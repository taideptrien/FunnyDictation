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

const transcriptClient = new TranscriptClient({
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  },
});

app.use(cors());
app.use(express.json());

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

  if (!YOUTUBE_API_KEY) {
    return res.status(400).json({
      error: 'YOUTUBE_API_KEY is not configured.',
      hint: 'Get a free key at https://console.cloud.google.com/apis/credentials',
    });
  }

  try {
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q,
        type: 'video',
        maxResults,
        relevanceLanguage: 'en',
        key: YOUTUBE_API_KEY,
      },
    });

    const videos = data.items.map((item) => ({
      id: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.medium?.url || '',
      publishedAt: item.snippet.publishedAt,
    }));
    res.json({ videos });
  } catch (error) {
    console.error('Search error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Search failed. Check your YOUTUBE_API_KEY.',
      detail: error.response?.data?.error?.message || error.message,
    });
  }
});

app.get(['/api/transcript', '/transcript'], async (req, res) => {
  const { url } = req.query;
  const { lang = 'en' } = req.query;

  if (!url) return res.status(400).json({ error: 'Missing "url" query parameter' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or video ID' });

  try {
    await transcriptClient.ready;
    const result = await transcriptClient.getTranscript(videoId);
    let transcript = null;
    if (result?.tracks?.length) {
      const track =
        result.tracks.find(
          (t) =>
            (t.languageCode?.toLowerCase().startsWith('en') ||
              t.language?.toLowerCase().startsWith('english')) ||
            true
        ) || result.tracks[0];
      if (track?.transcript?.length) {
        transcript = track.transcript.map((seg) => ({
          text: seg.text.replace(/[\u200B-\u200D\uFEFF]/g, ''),
          offset: Math.round(seg.start * 1000),
          duration: Math.round(seg.dur * 1000),
        }));
      }
    }

    if (!transcript || !transcript.length) {
      try {
        transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang });
      } catch {
        try {
          transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en-US' });
        } catch {
          transcript = await YoutubeTranscript.fetchTranscript(videoId);
        }
      }
      if (transcript && transcript.length) {
        transcript = transcript.map((seg) => ({
          ...seg,
          text: seg.text.replace(/[\u200B-\u200D\uFEFF]/g, ''),
        }));
      }
    }

    if (!transcript || !transcript.length) {
      console.log(`[transcript] No captions for ${videoId}, falling back to Groq Whisper AI…`);
      try {
        const aiSegments = await transcribeVideo(videoId);
        if (aiSegments && aiSegments.length) {
          transcript = aiSegments.map((seg) => ({
            text: seg.text,
            offset: Math.round(seg.start * 1000),
            duration: Math.round((seg.end - seg.start) * 1000),
          }));
        }
      } catch (aiErr) {
        console.error('[transcript] Groq Whisper AI transcription failed:', aiErr.message);
      }
    }

    if (!transcript || !transcript.length) {
      return res.status(500).json({ error: 'Unable to generate transcript' });
    }

    res.json({ transcript, metadata: await getVideoMetadata(videoId) });
  } catch (err) {
    console.error('Transcript generation failed:', err);
    res.status(500).json({ error: 'Transcript generation failed' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀  Server listening on http://0.0.0.0:${PORT}`);
});
