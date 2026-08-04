import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { YoutubeTranscript } from 'youtube-transcript';
import TranscriptClient from 'youtube-transcript-api';
import axios from 'axios';
import { transcribeVideo } from './whisperPipeline.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Cấu hình client
const transcriptClient = new TranscriptClient({
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  },
});

app.use(cors());
app.use(express.json());

// Trang chủ để test
app.get('/', (req, res) => res.send('FunnyDictation API is running on Render.'));

// Hàm dọn dẹp ký tự lạ
function cleanText(text) {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
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
    const { data } = await axios.get(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    return {
      title: data.title,
      author: data.author_name,
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    };
  } catch {
    return {
      title: 'Unknown Video',
      author: 'Unknown',
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    };
  }
}

app.get(['/api/search', '/search'], async (req, res) => {
  const { q, maxResults = 10 } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing search query "q"' });
  if (!YOUTUBE_API_KEY) return res.status(400).json({ error: 'YOUTUBE_API_KEY missing' });

  try {
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet', q, type: 'video', maxResults, relevanceLanguage: 'en', key: YOUTUBE_API_KEY,
      },
    });
    const videos = data.items.map((item) => ({
      id: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.medium?.url || '',
    }));
    res.json({ videos });
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get(['/api/transcript', '/transcript'], async (req, res) => {
  const { url } = req.query;
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  let transcript = null;

  // --- PHƯƠNG ÁN 1: youtube-transcript-api (Bọc kỹ để tránh crash axios) ---
  try {
    await transcriptClient.ready;
    const result = await transcriptClient.getTranscript(videoId).catch(() => null);

    if (result?.tracks?.length) {
      const track = result.tracks.find(t =>
        t.languageCode?.toLowerCase().startsWith('en') ||
        t.language?.toLowerCase().startsWith('english')
      ) || result.tracks[0];

      if (track?.transcript?.length) {
        transcript = track.transcript.map(seg => ({
          text: cleanText(seg.text),
          offset: Math.round(parseFloat(seg.start) * 1000),
          duration: Math.round(parseFloat(seg.dur) * 1000),
        }));
      }
    }
  } catch (e) {
    console.log("[API 1] Library crashed, skipping to API 2...");
  }

  // --- PHƯƠNG ÁN 2: youtube-transcript (Dự phòng nếu API 1 hỏng) ---
  if (!transcript || !transcript.length) {
    try {
      const result2 = await YoutubeTranscript.fetchTranscript(videoId).catch(() => null);
      if (result2 && result2.length) {
        transcript = result2.map(seg => ({
          text: cleanText(seg.text),
          offset: Math.round(seg.offset),
          duration: Math.round(seg.duration),
        }));
      }
    } catch (e) {
      console.log("[API 2] Failed, skipping to Whisper AI...");
    }
  }

  // --- PHƯƠNG ÁN 3: Groq Whisper AI (Cứu cánh cuối cùng) ---
  if (!transcript || !transcript.length) {
    console.log(`[Whisper] Generating AI transcript for ${videoId}...`);
    try {
      const aiSegments = await transcribeVideo(videoId);
      if (aiSegments && aiSegments.length) {
        transcript = aiSegments.map(seg => ({
          text: cleanText(seg.text),
          offset: Math.round(seg.start * 1000),
          duration: Math.round((seg.end - seg.start) * 1000),
        }));
      }
    } catch (aiErr) {
      console.error('[Whisper] AI failed:', aiErr.message);
    }
  }

  // Trả kết quả
  if (!transcript || !transcript.length) {
    return res.status(404).json({ error: 'No transcript available' });
  }

  const metadata = await getVideoMetadata(videoId);
  res.json({
    videoId,
    ...metadata,
    sentences: transcript // Frontend của bạn thường mong đợi key "sentences"
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
});