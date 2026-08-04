import { Octokit } from '@octokit/rest';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import FormData from 'form-data';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const accountsJson = process.env.GROQ_ACCOUNTS_JSON
  ? JSON.parse(process.env.GROQ_ACCOUNTS_JSON)
  : null;

export async function transcribeVideo(videoId) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not defined');

  const tempDir = path.join('/tmp', 'whisper-pipeline');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const audioPath = path.join(tempDir, `${videoId}.mp3`);
  const ytDlpCommand = `yt-dlp -x --audio-format mp3 -o "${audioPath}" "https://www.youtube.com/watch?v=${videoId}"`;
  await runCommand(ytDlpCommand);

  const form = new FormData();
  form.append('audio_file', fs.createReadStream(audioPath));

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });

  if (!response.ok) throw new Error(`Groq Whisper API error: ${response.statusText}`);
  const data = await response.json();

  fs.unlinkSync(audioPath);

  return data.segments.map((seg) => ({
    start: seg.start_time,
    end: seg.end_time,
    text: seg.text.trim(),
  }));
}

async function runCommand(cmd) {
  const { exec } = await import('child_process');
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) return reject(new Error(`exec error: ${stderr || error.message}`));
      resolve(stdout);
    });
  });
}
