import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Groq from 'groq-sdk';

const execFileAsync = promisify(execFile);

// ============ Configuration ============
// Groq rate limits (RPM/RPD) apply at the ACCOUNT level, not the key level.
// All keys created under the same Gmail account share the SAME quota.
// So we organize keys by account group:
//
//   GROQ_ACCOUNTS_JSON in .env:
//   [
//     { "accountName": "gmail_1", "keys": ["gsk_a1", "gsk_a2", "gsk_a3"] },
//     { "accountName": "gmail_2", "keys": ["gsk_b1", "gsk_b2"] }
//   ]
//
// Rotation strategy:
//   - Within the ACTIVE account: round-robin across its keys (RPM load balancing)
//   - On 429 (account-level quota exhausted): mark the WHOLE account exhausted,
//     switch to the next account, wait a smart delay, and retry the same chunk.
const GROQ_ACCOUNTS = (() => {
  try {
    const parsed = JSON.parse(process.env.GROQ_ACCOUNTS_JSON || '[]');
    return parsed
      .filter((acc) => acc && Array.isArray(acc.keys) && acc.keys.length > 0)
      .map((acc) => ({
        accountName: acc.accountName || 'unknown',
        keys: acc.keys.map((k) => String(k).trim()).filter(Boolean)
      }))
      .filter((acc) => acc.keys.length > 0);
  } catch {
    return [];
  }
})();

const CHUNK_DURATION_SECONDS = 180; // 3 minutes — safely under Groq's 25MB limit
const MODEL = 'whisper-large-v3';
const LANGUAGE = 'en';
const ACCOUNT_SWITCH_DELAY_MS = 7000; // smart delay before retrying with a new account

// ============ Account-aware rotation state ============
// activeAccountIndex : pointer to the account group currently in use
// activeKeyIndex     : pointer to the next key WITHIN the current account (round-robin)
// exhaustedAccounts  : Set of account names that hit 429 — skip them entirely
let activeAccountIndex = 0;
let activeKeyIndex = 0;
const exhaustedAccounts = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns the next { key, account } to try.
// Skips exhausted accounts. Round-robins keys within the active account.
function getNextKey() {
  let attempts = 0;
  while (attempts < GROQ_ACCOUNTS.length) {
    const account = GROQ_ACCOUNTS[activeAccountIndex];
    if (!exhaustedAccounts.has(account.accountName)) {
      const key = account.keys[activeKeyIndex % account.keys.length];
      // Advance the key pointer for the NEXT call (RPM load balancing)
      activeKeyIndex = (activeKeyIndex + 1) % account.keys.length;
      return { key, account };
    }
    // This account is exhausted — skip to the next one
    activeAccountIndex = (activeAccountIndex + 1) % GROQ_ACCOUNTS.length;
    activeKeyIndex = 0;
    attempts++;
  }
  throw new Error('[whisper] All Groq accounts are exhausted.');
}

// Marks the WHOLE account as exhausted (429 = account-level quota hit),
// then moves the active pointer to the next account.
function markAccountExhausted(accountName) {
  exhaustedAccounts.add(accountName);
  console.warn(`[whisper] Account "${accountName}" exhausted (429). Switching to next account...`);
  activeAccountIndex = (activeAccountIndex + 1) % GROQ_ACCOUNTS.length;
  activeKeyIndex = 0; // start from the first key of the new account
}

// ============ 1. Download audio via yt-dlp ============
async function downloadAudio(videoId, outputDir) {
  const outputPath = path.join(outputDir, `${videoId}.mp3`);
  await execFileAsync(
    'yt-dlp',
    [
      '-x', // extract audio only
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '-o', outputPath,
      `https://www.youtube.com/watch?v=${videoId}`
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return outputPath;
}

// ============ 2. Split audio via FFmpeg ============
async function splitAudio(audioPath, outputDir) {
  const base = path.basename(audioPath, path.extname(audioPath));
  const pattern = path.join(outputDir, `${base}_chunk_%03d.mp3`);

  await execFileAsync(
    'ffmpeg',
    [
      '-i', audioPath,
      '-f', 'segment',
      '-segment_time', String(CHUNK_DURATION_SECONDS),
      '-c', 'copy',
      pattern
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );

  const files = fs
    .readdirSync(outputDir)
    .filter((f) => f.startsWith(`${base}_chunk_`) && f.endsWith('.mp3'))
    .sort();
  return files.map((f) => path.join(outputDir, f));
}

// ============ 3. Transcribe with account-aware key rotation ============
async function transcribeChunk(client, chunkPath) {
  const file = fs.createReadStream(chunkPath);
  const response = await client.audio.transcriptions.create({
    file,
    model: MODEL,
    response_format: 'verbose_json',
    language: LANGUAGE
  });
  return response;
}

async function transcribeWithAccountRotation(chunkPath) {
  let lastError = null;

  // Try at most once per account group
  for (let attempt = 0; attempt < GROQ_ACCOUNTS.length; attempt++) {
    let pair;
    try {
      pair = getNextKey();
    } catch (err) {
      throw new Error(`[whisper] ${err.message} Last error: ${lastError?.message || 'none'}`);
    }

    const { key, account } = pair;
    const client = new Groq({ apiKey: key });
    console.log(
      `[whisper] Trying account "${account.accountName}" key #${account.keys.indexOf(key)}...`
    );

    try {
      return await transcribeChunk(client, chunkPath);
    } catch (err) {
      lastError = err;
      if (err.status === 429) {
        // 429 at account level → the WHOLE account is rate-limited
        markAccountExhausted(account.accountName);
        // Smart delay before retrying with the next account
        console.log(
          `[whisper] Waiting ${ACCOUNT_SWITCH_DELAY_MS / 1000}s before switching account...`
        );
        await sleep(ACCOUNT_SWITCH_DELAY_MS);
        continue;
      }
      // Non-429 error — don't waste accounts, propagate immediately
      throw err;
    }
  }

  throw new Error(
    `[whisper] All ${GROQ_ACCOUNTS.length} Groq accounts exhausted. Last error: ${lastError?.message}`
  );
}

// ============ 4+5. Merge timestamps with offset calibration ============
// offset_N = Σ(duration of chunk 0 .. chunk N-1)
// start_global = start_local + offset_N
function mergeSegments(chunkResults) {
  const merged = [];
  let cumulativeOffset = 0;

  for (const result of chunkResults) {
    const segments = result.segments || [];
    for (const seg of segments) {
      merged.push({
        start: Math.round((seg.start + cumulativeOffset) * 1000) / 1000,
        end: Math.round((seg.end + cumulativeOffset) * 1000) / 1000,
        text: (seg.text || '').trim()
      });
    }
    cumulativeOffset += result.duration || 0;
  }

  return merged;
}

// ============ Main pipeline ============
export async function transcribeVideo(videoId) {
  if (GROQ_ACCOUNTS.length === 0) {
    throw new Error(
      '[whisper] GROQ_ACCOUNTS_JSON not configured. Add account groups to .env'
    );
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  try {
    // 1. Download audio
    console.log(`[whisper] Downloading audio for ${videoId}...`);
    const audioPath = await downloadAudio(videoId, workDir);

    // 2. Split into 3-min chunks
    console.log(`[whisper] Splitting audio into ${CHUNK_DURATION_SECONDS}s chunks...`);
    const chunks = await splitAudio(audioPath, workDir);
    console.log(`[whisper] Created ${chunks.length} chunk(s).`);

    // 3+4. Transcribe each chunk (account-aware key rotation on 429)
    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`[whisper] Transcribing chunk ${i + 1}/${chunks.length}...`);
      results.push(await transcribeWithAccountRotation(chunks[i]));
    }

    // 5. Merge with offset calibration
    const merged = mergeSegments(results);
    console.log(
      `[whisper] Done. ${merged.length} segments, total ${results.reduce((s, r) => s + (r.duration || 0), 0)}s.`
    );
    return merged;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}