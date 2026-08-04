import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { YoutubeTranscript } from 'youtube-transcript';
import axios from 'axios';
import { transcribeVideo } from './whisperPipeline.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('FunnyDictation API is Live!'));

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function getVideoMetadata(videoId) {
  try {
    const { data } = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    return { title: data.title, author: data.author_name, thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` };
  } catch {
    return { title: 'Unknown Video', author: 'Unknown', thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` };
  }
}

app.get(['/api/search', '/search'], async (req, res) => {
  const { q } = req.query;
  try {
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', q, type: 'video', maxResults: 10, relevanceLanguage: 'en', key: YOUTUBE_API_KEY }
    });
    const videos = data.items.map(item => ({ id: item.id.videoId, title: item.snippet.title, channel: item.snippet.channelTitle, thumbnail: item.snippet.thumbnails?.medium?.url }));
    res.json({ videos });
  } catch (e) { res.status(500).json({ error: 'Search failed' }); }
});

app.get(['/api/transcript', '/transcript'], async (req, res) => {
  const { url } = req.query;
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid URL' });

  let transcript = null;

  // PHƯƠNG ÁN 1: Dùng thư viện youtube-transcript (Ổn định)
  try {
    const result = await YoutubeTranscript.fetchTranscript(videoId).catch(() => null);
    if (result && result.length) {
      transcript = result.map(seg => ({
        text: seg.text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim(),
        offset: Math.round(seg.offset),
        duration: Math.round(seg.duration)
      }));
    }
  } catch (e) { console.log("API 1 failed"); }

  // PHƯƠNG ÁN 2: Dùng Whisper AI (Dành cho video game/video ko phụ đề)
  if (!transcript || !transcript.length) {
    try {
      console.log(`[Whisper] Processing AI transcript for ${videoId}...`);
      const aiSegments = await transcribeVideo(videoId);
      if (aiSegments) {
        transcript = aiSegments.map(seg => ({
          text: seg.text.trim(),
          offset: Math.round(seg.start * 1000),
          duration: Math.round((seg.end - seg.start) * 1000)
        }));
      }
    } catch (e) { console.error("Whisper failed:", e.message); }
  }

  if (!transcript) return res.status(404).json({ error: 'No transcript found' });

  const metadata = await getVideoMetadata(videoId);
  res.json({ videoId, ...metadata, sentences: transcript });
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Listening on port ${PORT}`));