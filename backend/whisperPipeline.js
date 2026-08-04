import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import Groq from 'groq-sdk';

// Danh sách các máy chủ dự phòng để lấy audio (Invidious instances)
const INVIDIOUS_INSTANCES = [
  'https://inv.tux.rs',
  'https://invidious.sethforprivacy.com',
  'https://invidious.snopyta.org',
  'https://inv.nadeko.net',
  'https://invidious.perennialte.ch'
];

const getGroqKey = () => {
  try {
    const rawJson = process.env.GROQ_ACCOUNTS_JSON;
    if (rawJson) {
      const cleanJson = rawJson.startsWith('=') ? rawJson.substring(1) : rawJson;
      const accounts = JSON.parse(cleanJson);
      if (Array.isArray(accounts) && accounts.length > 0) {
        const keys = accounts[0].keys;
        return keys[Math.floor(Math.random() * keys.length)];
      }
    }
  } catch (e) { }
  return process.env.GROQ_API_KEY || null;
};

// Hàm mới: Tải audio qua Proxy Invidious (Không cần yt-dlp)
async function downloadAudio(videoId, outputPath) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      console.log(`[Whisper] Trying proxy: ${instance}`);
      // Itag 140 là định dạng m4a/aac 128kbps (nhẹ và chuẩn)
      const audioUrl = `${instance}/latest_version?id=${videoId}&itag=140`;

      const response = await axios({
        method: 'get',
        url: audioUrl,
        responseType: 'stream',
        timeout: 15000 // 15 giây
      });

      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      console.log(`[Whisper] Download successful via ${instance}`);
      return true;
    } catch (err) {
      console.warn(`[Whisper] Proxy ${instance} failed: ${err.message}`);
      continue; // Thử máy chủ tiếp theo
    }
  }
  throw new Error("All proxies failed. YouTube is blocking the request.");
}

export async function transcribeVideo(videoId) {
  const apiKey = getGroqKey();
  if (!apiKey) throw new Error("No Groq API Key found.");

  const client = new Groq({ apiKey });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  const audioPath = path.join(workDir, `${videoId}.m4a`);

  try {
    console.log(`[Whisper] Processing video: ${videoId}`);
    await downloadAudio(videoId, audioPath);

    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-large-v3',
      language: 'en',
      response_format: 'verbose_json',
    });

    return transcription.segments;
  } catch (err) {
    throw new Error(`Whisper Error: ${err.message}`);
  } finally {
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  }
}