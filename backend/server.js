import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { YoutubeTranscript } from 'youtube-transcript';
import TranscriptClient from 'youtube-transcript-api';
import axios from 'axios';
import { transcribeVideo } from './whisperPipeline.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// youtube-transcript-api client (primary source — better quality auto-generated captions)
// Uses a realistic User-Agent to avoid being blocked by YouTube.
const transcriptClient = new TranscriptClient({
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
  }
});

app.use(cors());
app.use(express.json());

// Extract video ID from various YouTube URL formats
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Get video metadata via YouTube oEmbed (no API key needed)
async function getVideoMetadata(videoId) {
  try {
    const { data } = await axios.get(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    return {
      title: data.title,
      author: data.author_name,
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    };
  } catch (error) {
    return {
      title: 'Unknown Video',
      author: 'Unknown',
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    };
  }
}

// Search YouTube videos (requires YOUTUBE_API_KEY in .env)
app.get('/api/search', async (req, res) => {
  const { q, maxResults = 10 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Missing search query "q"' });
  }

  if (!YOUTUBE_API_KEY) {
    return res.status(400).json({
      error: 'YOUTUBE_API_KEY is not configured in .env file.',
      hint: 'Get a free key at https://console.cloud.google.com/apis/credentials'
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
        key: YOUTUBE_API_KEY
      }
    });

    const videos = data.items.map((item) => ({
      id: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.medium?.url || '',
      publishedAt: item.snippet.publishedAt
    }));

    res.json({ videos });
  } catch (error) {
    console.error('Search error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Search failed. Check your YOUTUBE_API_KEY.',
      detail: error.response?.data?.error?.message || error.message
    });
  }
});

// Get transcript + metadata for a video (by URL or video ID)
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  const { lang = 'en' } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube URL or video ID' });
  }

  try {
    // Fetch transcript: PRIMARY = youtube-transcript-api (better auto-generated quality),
    // FALLBACK = youtube-transcript (old library) if the new one has no captions.
    // Note: segments from the new API use start/dur in SECONDS (as strings),
    // so we convert them to MILLISECONDS to match the old library's srv3 format
    // that the cleaning pipeline below expects.
    // Strip zero-width characters (U+200B, U+200C, U+200D, U+FEFF) that
    // youtube-transcript-api sometimes injects into segment text.
    // These invisible chars break word-boundary matching (overlap detection,
    // dedupe, etc.) and make text look garbled in the UI.
    function stripZeroWidth(text) {
      return text.replace(/[\u200B-\u200D\uFEFF]/g, '');
    }

    async function fetchTranscriptNewApi(videoId) {
      try {
        await transcriptClient.ready;
        const result = await transcriptClient.getTranscript(videoId);
        const tracks = result?.tracks;
        if (!tracks || tracks.length === 0) return null;
        // Prefer an English track if available, otherwise use the first one
        const track =
          tracks.find(
            (t) =>
              t.languageCode?.toLowerCase().startsWith('en') ||
              t.language?.toLowerCase().startsWith('english')
          ) || tracks[0];
        if (!track?.transcript || track.transcript.length === 0) return null;
        return track.transcript.map((seg) => ({
          text: stripZeroWidth(seg.text || ''),
          offset: parseFloat(seg.start) * 1000,
          duration: parseFloat(seg.dur) * 1000
        }));
      } catch (err) {
        console.error('youtube-transcript-api failed:', err.message);
        return null;
      }
    }

    let transcript = await fetchTranscriptNewApi(videoId);

    // Fallback to the old library if the new one returned nothing
    if (!transcript || transcript.length === 0) {
      try {
        transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang });
      } catch {
        try {
          transcript = await YoutubeTranscript.fetchTranscript(videoId, {
            lang: 'en-US'
          });
        } catch {
          transcript = await YoutubeTranscript.fetchTranscript(videoId);
        }
      }
      // Also strip zero-width chars from the fallback source
      if (transcript && transcript.length > 0) {
        transcript = transcript.map((seg) => ({
          ...seg,
          text: stripZeroWidth(seg.text || '')
        }));
      }
    }

    // LAST RESORT: video has NO subtitles at all → use Groq Whisper AI transcription
    if (!transcript || transcript.length === 0) {
      console.log(`[transcript] No captions for ${videoId}, falling back to Groq Whisper AI...`);
      try {
        const aiSegments = await transcribeVideo(videoId);
        if (aiSegments && aiSegments.length > 0) {
          // Convert [{ start, end, text }] → [{ text, offset, duration }] (milliseconds)
          transcript = aiSegments.map((seg) => ({
            text: seg.text,
            offset: Math.round(seg.start * 1000),
            duration: Math.round((seg.end - seg.start) * 1000)
          }));
        }
      } catch (aiErr) {
        console.error('[transcript] Groq Whisper AI transcription failed:', aiErr.message);
      }
    }

    if (!transcript || transcript.length === 0) {
      return res.status(404).json({ error: 'No transcript available for this video' });
    }

    // Clean + merge segments into sentences
    // Note: offset/duration can be in milliseconds (srv3) or seconds (classic format)
    // Filter out music/sound effect segments like [♪♪♪], [Music], (applause), [Laughter], screaming, etc.
    const soundEffectPattern = /^[\[\(♪♫]*\s*(music|applause|laughter|cheering|crowd|sound effect|audio|♪|♫|noise|silence|indistinct|foreign|scream|shout|yell|groan|moan|sigh|cough|sneeze|sniff|burp|fart|vomit|gasp|pant|breath|heartbeat|pulse|rhythm|beat|drum|guitar|piano|violin|trumpet|saxophone|microphone|feedback|echo|reverb|static|noises?)\s*[\]\)♪♫]*$/i;
    const bracketOnlyPattern = /^[\[\(♪♫\]\)\s]+$/;

    // Onomatopoeia / interjection-only segments — auto-generated transcripts often
    // caption background music/sound effects as repeated interjections like
    // "woo woo", "ooh", "ahh", "hmm", "uh", "um", "yeah", "oh", "wow", "ha ha",
    // "la la", "na na", "dun dun", "boom", "bang", "whoosh", etc.
    // If a segment contains ONLY these words (no real speech), drop it entirely.
    const onomatopoeiaWords = new Set([
      'woo', 'wow', 'ooh', 'ahh', 'ah', 'aah', 'hmm', 'huh', 'uh', 'um', 'erm',
      'yeah', 'yay', 'oh', 'ha', 'heh', 'huh', 'mmm', 'mm', 'eh', 'huh',
      'la', 'na', 'da', 'doo', 'dun', 'boom', 'bang', 'whoosh', 'pop', 'click',
      'beep', 'boop', 'ding', 'dong', 'tick', 'tock', 'shh', 'psst', 'brr',
      'grr', 'rawr', 'meow', 'woof', 'arf', 'moo', 'baa', 'oink', 'quack',
      'cock', 'doodle', 'doo', 'tweet', 'chirp', 'hoot', 'caw', 'ribbit',
      'buzz', 'hum', 'ring', 'clap', 'snap', 'stomp', 'thud', 'thump',
      'crash', 'smash', 'splash', 'drip', 'drop', 'sizzle', 'fizz', 'pop'
    ]);
    // A segment is "sound-only" if every word (after removing punctuation) is
    // an onomatopoeia/interjection word, and it has at least 1 word.
    function isSoundOnlySegment(text) {
      const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
      if (words.length === 0) return false;
      return words.every((w) => onomatopoeiaWords.has(w));
    }

    const segments = transcript
      .map((seg) => {
        const isMs = seg.offset > 1000 || seg.duration > 1000;
        let text = seg.text.trim();
        
        // Strip sound effect markers from ANY position in the segment.
        // YouTube auto-generated captions often insert "[Music]" or just "music"
        // in the MIDDLE of a sentence, e.g.:
        //   "an alternate loki [Music] manages to grab" → "an alternate loki manages to grab"
        //   "an alternate loki music manages to grab"   → "an alternate loki manages to grab"
        const soundEffects = ['music', 'applause', 'laughter', 'cheering', 'crowd', 'sound effect', 'audio', 'noise', 'silence', 'indistinct', 'foreign', 'scream', 'shout', 'yell', 'groan', 'moan', 'sigh', 'cough', 'sneeze', 'sniff', 'burp', 'fart', 'vomit', 'gasp', 'pant', 'breath', 'heartbeat', 'pulse', 'rhythm', 'beat', 'drum', 'guitar', 'piano', 'violin', 'trumpet', 'saxophone', 'microphone', 'feedback', 'echo', 'reverb', 'static', 'noises?'];
        // Match sound effect words with optional brackets/♪♫ around them, ANYWHERE in the text
        const effectAnywherePattern = new RegExp(
          '\\s*[\\[\\(♪♫\\s]*(?:' + soundEffects.join('|') + ')[\\]\\)♪♫\\s]*\\s*',
          'gi'
        );
        text = text.replace(effectAnywherePattern, ' '); // Remove sound effects anywhere
        text = text.replace(/\s+/g, ' '); // Collapse multiple spaces
        text = text.trim();
        
        return {
          text,
          start: isMs ? seg.offset / 1000 : seg.offset,
          duration: isMs ? seg.duration / 1000 : seg.duration
        };
      })
      .filter((seg) => {
        // Remove empty segments
        if (!seg.text) return false;
        // Remove sound-only segments (e.g. "woo woo", "ooh", "ha ha")
        if (isSoundOnlySegment(seg.text)) return false;
        return true;
      });

    // Helper: remove duplicate consecutive words and collapse repeated chars
    // e.g. "but somehow but somehow" → "but somehow"
    // e.g. "yeahhhhh" → "yeah", "nooo" → "no"
    function dedupeWords(text) {
      const words = text.split(/\s+/).filter(Boolean);
      const result = [];
      let i = 0;
      while (i < words.length) {
        // Check for repeated phrase pattern: first half == second half
        const remaining = words.length - i;
        if (remaining >= 4) {
          const halfLen = Math.floor(remaining / 2);
          const firstHalf = words.slice(i, i + halfLen).map(w => w.toLowerCase()).join(' ');
          const secondHalf = words.slice(i + halfLen, i + halfLen * 2).map(w => w.toLowerCase()).join(' ');
          if (firstHalf === secondHalf) {
            result.push(...words.slice(i, i + halfLen).map(w => w.replace(/(.)\1{3,}/g, '$1').toLowerCase()));
            i += halfLen * 2;
            continue;
          }
        }
        // Skip single duplicate word and collapse repeated chars
        if (i > 0 && words[i].toLowerCase() === words[i - 1].toLowerCase()) {
          i++;
          continue;
        }
        result.push(words[i].replace(/(.)\1{3,}/g, '$1'));
        i++;
      }
      return result.join(' ');
    }

    // Normalize text for overlap comparison: case-insensitive, punctuation-insensitive,
    // and number-normalized (e.g. "1,000,000" == "1000000" == "one million").
    // YouTube transcripts commonly vary formatting between repeated segments.
    const overlapNumberWords = {
      'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
      'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
      'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
      'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
      'eighteen': '18', 'nineteen': '19', 'twenty': '20', 'thirty': '30',
      'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70',
      'eighty': '80', 'ninety': '90', 'hundred': '100', 'thousand': '1000',
      'million': '1000000', 'billion': '1000000000'
    };
    const overlapNumberEntries = Object.entries(overlapNumberWords).sort((a, b) => b[0].length - a[0].length);

    function normalizeForOverlap(text) {
      let result = text.toLowerCase();
      // Replace number words with digits (longest words first to avoid partial matches)
      for (const [word, digit] of overlapNumberEntries) {
        result = result.replace(new RegExp(`\\b${word}\\b`, 'g'), digit);
      }
      // Remove thousand separators: "1,000,000" → "1000000"
      result = result.replace(/,(\d)/g, '$1');
      // Punctuation → space
      result = result
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return result;
    }

    // Find the longest overlap between the end of text1 and the start of text2
    // e.g. findOverlapLength("hello world again", "world again my friend") → 2
    // In: "wins a million dollars for their subscribers" +
    //     "wins a 1,000,000 dollars for their subscribers these creators..." → 6
    // Comparison is normalized so punctuation/case/number-format differences
    // between repeated segments are ignored.
    function findOverlapLength(text1, text2) {
      const words1 = normalizeForOverlap(text1).split(/\s+/).filter(Boolean);
      const words2 = normalizeForOverlap(text2).split(/\s+/).filter(Boolean);
      if (words1.length === 0 || words2.length === 0) return 0;
      const maxLen = Math.min(words1.length, words2.length, 30);
      for (let len = maxLen; len > 0; len--) {
        const suffix = words1.slice(words1.length - len).join(' ');
        const prefix = words2.slice(0, len).join(' ');
        if (suffix === prefix) return len;
      }
      return 0;
    }

    // Improved sentence splitting: split by punctuation, conjunctions, or word count
    // Ensures chunks are NOT too long, NO words are skipped
    const sentences = [];
    let current = { text: '', start: null, end: 0, wordCount: 0, totalDuration: 0 };

    for (const seg of segments) {
      const words = seg.text.split(/\s+/).filter(Boolean);
      if (current.start === null) current.start = seg.start;
      current.end = seg.start + seg.duration;

      // Check for sentence-ending punctuation or strong conjunctions
      const hasSentenceEnd = /[.!?]$/.test(seg.text.trim());
      const hasStrongBreak = /[,;]\s*$/.test(seg.text.trim());

      // Add to current chunk (dedupe consecutive repeated words within segment)
      const deduped = dedupeWords(seg.text);
      const dedupedWords = deduped.split(/\s+/).filter(Boolean);
      
      // Dedupe across segment boundaries using multi-word overlap detection
      // (YouTube often repeats the tail of the previous segment at the start of the next)
      const currentWords = current.text.split(/\s+/).filter(Boolean);
      let finalText = deduped;
      if (currentWords.length > 0 && dedupedWords.length > 0) {
        const overlapLen = findOverlapLength(current.text, deduped);
        if (overlapLen > 0) {
          finalText = dedupedWords.slice(overlapLen).join(' ');
        }
      }
      
      current.text += (current.text ? ' ' : '') + finalText;
      const addedWords = finalText.split(/\s+/).filter(Boolean).length;
      current.wordCount += addedWords;
      current.totalDuration += seg.duration;

      // Split if:
      // 1. Sentence-ending punctuation (. ! ?)
      // 2. Comma/semicolon + word count >= 8
      // 3. Word count >= 12 (hard limit)
      const spanDuration = current.end - current.start;
      if (hasSentenceEnd || (hasStrongBreak && current.wordCount >= 8) || current.wordCount >= 12 || spanDuration > 8) {
        // Final dedupe before pushing
        const finalText = dedupeWords(current.text.trim());
        // Normalize whitespace
        const safeText = finalText.replace(/\s+/g, ' ').trim();
        sentences.push({
          text: safeText,
          start: current.start,
          duration: current.end - current.start,
          end: current.end,
        });
        current = { text: '', start: null, end: 0, wordCount: 0, totalDuration: 0 };
      }
    }

    // Don't forget the last chunk
    if (current.text) {
      const finalText = dedupeWords(current.text.trim());
      // Normalize whitespace
      const safeText = finalText.replace(/\s+/g, ' ').trim();
      sentences.push({
        text: safeText,
        start: current.start,
        duration: current.end - current.start,
        end: current.end,
      });
    }

    // Extra pass: dedupe consecutive repeated words across the WHOLE sentence.
    // This catches cases like "i just bought this grocery store store and i have..."
    // where the same word appears twice in a row (from segment boundary overlap
    // that findOverlapLength missed due to punctuation/number differences).
    for (const sent of sentences) {
      sent.text = dedupeWords(sent.text).replace(/\s+/g, ' ').trim();
    }

    // Post-process: remove text overlap between consecutive sentences.
    // YouTube transcript segments VERY commonly repeat the previous segment —
    // sometimes the ENTIRE previous sentence appears at the start of the next.
    // E.g. sentence 2 = "wins a million dollars for their subscribers"
    //      sentence 3 = "wins a million dollars for their subscribers these creators..."
    // We strip that overlap from the START of every sentence after the first.
    for (let i = 1; i < sentences.length; i++) {
      const prev = sentences[i - 1];
      const curr = sentences[i];
      const overlapLen = findOverlapLength(prev.text, curr.text);
      if (overlapLen > 0) {
        const currWords = curr.text.split(/\s+/).filter(Boolean);
        const newText = currWords.slice(overlapLen).join(' ').replace(/\s+/g, ' ').trim();
        // If the whole sentence turned out to be a repeat, mark it empty
        // so it gets dropped by the empty-filter below.
        sentences[i].text = newText || '';
      }
    }

    // Drop sentences that were fully repeated (now empty)
    const nonEmptySentences = sentences.filter((s) => s.text && s.text.trim());

    // Final pass: remove ALL duplicate sentences (keep only unique ones)
    const seen = new Set();
    const uniqueSentences = [];
    for (const sent of nonEmptySentences) {
      const normalized = sent.text.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        uniqueSentences.push(sent);
      }
    }

    // Add nextStart to each sentence for the frontend stop-time logic
    // nextStart = start of the next chunk (most reliable boundary for stopping)
    for (let i = 0; i < uniqueSentences.length; i++) {
      uniqueSentences[i].nextStart =
        i < uniqueSentences.length - 1 ? uniqueSentences[i + 1].start : uniqueSentences[i].end;
    }

    const metadata = await getVideoMetadata(videoId);

    res.json({
      videoId,
      ...metadata,
      totalSentences: uniqueSentences.length,
      sentences: uniqueSentences
    });
  } catch (error) {
    console.error('Transcript error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch transcript. The video may not have captions.',
      detail: error.message
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'FunnyDictation backend is running!' });
});

// Only start the server when running directly (not in Vercel serverless)
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`🚀 Backend server running on http://localhost:${PORT}`);
  });
}

// Export app for serverless deployment (Vercel, etc.)
export { app };
