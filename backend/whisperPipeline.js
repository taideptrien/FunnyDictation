import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import Groq from 'groq-sdk';

// Danh sách Piped Instances (Ổn định hơn Invidious)
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.victr.me',
  'https://piped-api.lunar.icu',
  'https://pipedapi.us.to',
  'https://pipedapi.at.as64422.net'
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

async function downloadAudio(videoId, outputPath) {
  for (const instance of PIPED_INSTANCES) {
    try {
      console.log(`[Whisper] Trying Piped instance: ${instance}`);

      // Bước 1: Lấy thông tin stream từ Piped
      const { data } = await axios.get(`${instance}/streams/${videoId}`, { timeout: 10000 });

      // Bước 2: Tìm link audio (ưu tiên định dạng m4a hoặc opus)
      const audioStream = data.audioStreams.find(s => s.format === 'M4A' || s.extension === 'm4a') || data.audioStreams[0];

      if (!audioStream || !audioStream.url) continue;

      console.log(`[Whisper] Found audio stream, downloading...`);

      // Bước 3: Tải file về
      const response = await axios({
        method: 'get',
        url: audioStream.url,
        responseType: 'stream',
        timeout: 30000
      });

      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      console.log(`[Whisper] Success via ${instance}`);
      return true;
    } catch (err) {
      console.warn(`[Whisper] Instance ${instance} failed: ${err.message}`);
      continue;
    }
  }
  throw new Error("All Piped/Invidious instances are currently blocked or offline.");
}

export async function transcribeVideo(videoId) {
  const apiKey = getGroqKey();
  if (!apiKey) throw new Error("No Groq API Key found.");

  const client = new Groq({ apiKey });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  const audioPath = path.join(workDir, `${videoId}.m4a`);

  try {
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