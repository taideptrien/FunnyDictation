import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Groq from 'groq-sdk';

const execFileAsync = promisify(execFile);

// Hàm lấy Key thông minh
const getGroqKey = () => {
  // 1. Thử lấy từ mảng JSON (ưu tiên)
  try {
    const rawJson = process.env.GROQ_ACCOUNTS_JSON;
    if (rawJson) {
      const cleanJson = rawJson.startsWith('=') ? rawJson.substring(1) : rawJson;
      const accounts = JSON.parse(cleanJson);
      if (Array.isArray(accounts) && accounts.length > 0) {
        const keys = accounts[0].keys; // Lấy tạm key đầu tiên của gmail_1
        return keys[Math.floor(Math.random() * keys.length)];
      }
    }
  } catch (e) {
    console.error("[Whisper] JSON Parse Error:", e.message);
  }

  // 2. Dự phòng: Nếu bạn có dán lẻ 1 key vào biến GROQ_API_KEY
  return process.env.GROQ_API_KEY || null;
};

async function downloadAudio(videoId, outputDir) {
  const outputPath = path.join(outputDir, `${videoId}.mp3`);

  await execFileAsync('yt-dlp', [
    '-x',
    '--audio-format', 'mp3',
    '--format', 'wa',                // Lấy audio bản nhẹ nhất
    '--no-check-certificates',       // Bỏ qua kiểm tra SSL (giúp vượt rào)
    '--no-cache-dir',                // Không lưu cache để tránh bị lộ IP cũ
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36', // Giả lập trình duyệt
    '--extractor-args', 'youtube:player_client=android,web;player_skip=webpage,configs', // Dùng client mobile ít bị chặn hơn
    '-o', outputPath,
    `https://www.youtube.com/watch?v=${videoId}`
  ]);

  return outputPath;
}

export async function transcribeVideo(videoId) {
  const apiKey = getGroqKey();
  if (!apiKey) throw new Error("No Groq API Key found in Environment Variables");

  const client = new Groq({ apiKey });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));

  try {
    console.log(`[Whisper] Processing video: ${videoId}`);
    const audioPath = await downloadAudio(videoId, workDir);

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