import React, { useState, useEffect, useRef, useCallback } from 'react';

// API base URL for backend - falls back to relative '/api' for development (proxied by Vite)
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const API = (path) => `${API_BASE}/api${path.startsWith('/') ? path : '/' + path}`;

// ============ Utility Functions ============

// Expand English contractions to their full form for fair comparison
// e.g. "you've" → "you have", "don't" → "do not", "it's" → "it is"
function expandContractions(text) {
  const contractions = {
    "you've": 'you have',
    "you'd": 'you would',
    "you're": 'you are',
    "you'll": 'you will',
    "i've": 'i have',
    "i'd": 'i would',
    "i'm": 'i am',
    "i'll": 'i will',
    "he's": 'he is',
    "he'd": 'he would',
    "he'll": 'he will',
    "she's": 'she is',
    "she'd": 'she would',
    "she'll": 'she will',
    "it's": 'it is',
    "it'd": 'it would',
    "it'll": 'it will',
    "we've": 'we have',
    "we'd": 'we would',
    "we're": 'we are',
    "we'll": 'we will',
    "they've": 'they have',
    "they'd": 'they would',
    "they're": 'they are',
    "they'll": 'they will',
    "don't": 'do not',
    "doesn't": 'does not',
    "didn't": 'did not',
    "won't": 'will not',
    "wouldn't": 'would not',
    "shouldn't": 'should not',
    "couldn't": 'could not',
    "can't": 'can not',
    "cannot": 'cannot',
    "isn't": 'is not',
    "aren't": 'are not',
    "wasn't": 'was not',
    "weren't": 'were not',
    "haven't": 'have not',
    "hasn't": 'has not',
    "hadn't": 'had not',
    "mustn't": 'must not',
    "mightn't": 'might not',
    "needn't": 'need not',
    "let's": 'let us',
    "that's": 'that is',
    "that'd": 'that would',
    "what's": 'what is',
    "what're": 'what are',
    "who's": 'who is',
    "where's": 'where is',
    "how's": 'how is',
    "here's": 'here is',
    "there's": 'there is',
    "there're": 'there are',
    "there'd": 'there would',
    "there'll": 'there will'
  };

  let result = text.toLowerCase();
  for (const [contraction, expanded] of Object.entries(contractions)) {
    result = result.replace(new RegExp(contraction, 'gi'), expanded);
  }
  // Handle possessive 's — remove it (e.g. "john's" → "john")
  result = result.replace(/'s\b/g, '');
  // Remove any remaining apostrophes (e.g. "youve" vs "you've" → both become "youve")
  result = result.replace(/'/g, '');
  return result;
}

// Convert English number words to digits for fair comparison.
// Handles COMPOUND numbers correctly, e.g.:
//   "one hundred"           → "100"   (not "1 100")
//   "one hundred and five"  → "105"
//   "twenty five"           → "25"
//   "one million"           → "1000000"
//   "two thousand"          → "2000"
function normalizeNumbers(text) {
  const small = {
    'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4,
    'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9,
    'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13,
    'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17,
    'eighteen': 18, 'nineteen': 19, 'twenty': 20, 'thirty': 30,
    'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70,
    'eighty': 80, 'ninety': 90
  };
  const scales = { 'hundred': 100, 'thousand': 1000, 'million': 1000000, 'billion': 1000000000 };

  // Convert an array of number words (lowercase, "and" removed) to a numeric value
  function wordsToNumber(words) {
    let total = 0;
    let current = 0;
    for (const w of words) {
      if (w in small) {
        current += small[w];
      } else if (w === 'hundred') {
        current *= 100;
      } else if (w in scales) {
        total += current * scales[w];
        current = 0;
      }
    }
    return total + current;
  }

  // Match whole sequences of consecutive number words (possibly with "and"
  // connectors and spacing) so compound numbers are parsed as ONE value:
  //   "one hundred"           → "100"
  //   "one hundred and five"  → "105"
  //   "twenty five"           → "25"
  const numWordList = Object.keys({ ...small, ...scales, and: null }).join('|');
  const numberPhraseRegex = new RegExp(
    `(?:\\b(?:${numWordList})\\b\\s*)+`,
    'gi'
  );

  return text.replace(numberPhraseRegex, (match) => {
    const hasTrailingSpace = /\s$/.test(match);
    const numWords = match
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .filter((w) => w !== 'and');
    // If the match was ONLY "and" (or "and and"), there is no actual number
    // to convert — keep the original text unchanged. Otherwise "and I abandoned
    // it" would become "0 I abandoned it" (wordsToNumber([]) === 0).
    if (numWords.length === 0) {
      return match;
    }
    return String(wordsToNumber(numWords)) + (hasTrailingSpace ? ' ' : '');
  });
}

function normalizeText(text) {
  return normalizeNumbers(expandContractions(text))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')  // Replace ALL punctuation/symbols with space
    .replace(/\s+/g, ' ')
    .trim();
}

function wordSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const matrix = Array(b.length + 1)
    .fill(null)
    .map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }
  return 1 - matrix[b.length][a.length] / maxLen;
}

// ============ Main App Component ============

function App() {
  const [view, setView] = useState('home');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState('');
  const [videoData, setVideoData] = useState(null);
  const [settings, setSettings] = useState({
    mode: 'full',
    numSentences: 0, // 0 = all sentences
    speed: 1.0,
    blankCount: 3
  });
  const [practiceSentences, setPracticeSentences] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [userAnswer, setUserAnswer] = useState('');
  const [showResult, setShowResult] = useState(false);
  const [result, setResult] = useState(null);
  const [replayCount, setReplayCount] = useState(0);
  const [score, setScore] = useState(0);
  const [totalCorrect, setTotalCorrect] = useState(0);
  const [totalWrong, setTotalWrong] = useState(0);
  const [history, setHistory] = useState([]);
  const [toast, setToast] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [useTTS, setUseTTS] = useState(false);
  const [showVideo, setShowVideo] = useState(true);

  const playerRef = useRef(null);
  const stopIntervalRef = useRef(null);
  const toastTimerRef = useRef(null);
  const answerRef = useRef(null);
  const speedRef = useRef(1.0);
  const practiceSentencesRef = useRef([]);
  const playerReadyRef = useRef(false);
  const lastCheckTimeRef = useRef(0);

  // Keep refs in sync
  useEffect(() => {
    speedRef.current = settings.speed;
  }, [settings.speed]);

  useEffect(() => {
    practiceSentencesRef.current = practiceSentences;
  }, [practiceSentences]);

  // Load history from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('funnydictation_history');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch {
        setHistory([]);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('funnydictation_history', JSON.stringify(history));
  }, [history]);

  const showToast = useCallback((message) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 3000);
  }, []);

  // ============ YouTube IFrame API ============

  useEffect(() => {
    if (!window.YT && !document.getElementById('youtube-iframe-api')) {
      const tag = document.createElement('script');
      tag.id = 'youtube-iframe-api';
      tag.src = 'https://www.youtube.com/iframe_api';
      document.body.appendChild(tag);
    }
  }, []);

  useEffect(() => {
    if (view === 'practice' && videoData && !useTTS) {
      const initPlayer = () => {
        if (!window.YT || !window.YT.Player) return false;

        if (playerRef.current && playerRef.current.destroy) {
          try {
            playerRef.current.destroy();
          } catch {
            // ignore
          }
          playerRef.current = null;
        }

        const div = document.getElementById('youtube-player-div');
        if (!div) return false;

        playerRef.current = new window.YT.Player('youtube-player-div', {
          videoId: videoData.videoId,
          playerVars: {
            autoplay: 0,
            controls: 1,
            modestbranding: 1,
            rel: 0
          },
          events: {
            onReady: () => {
              setPlayerReady(true);
              playerReadyRef.current = true;
              // Apply current speed
              try {
                playerRef.current.setPlaybackRate(speedRef.current);
              } catch {
                // ignore
              }
              // Auto-play first sentence immediately when ready - NO DELAY
              const first = practiceSentencesRef.current[0];
              if (first) playSentence(first);
            },
            onStateChange: (e) => {
              setIsPlaying(e.data === 1);
            },
            onError: () => {
              showToast('⚠️ Video không embed được, chuyển sang giọng đọc TTS');
              setUseTTS(true);
            }
          }
        });
        return true;
      };

      if (!initPlayer()) {
        window.onYouTubeIframeAPIReady = initPlayer;
      }

      return () => {
        if (stopIntervalRef.current) {
          clearInterval(stopIntervalRef.current);
          stopIntervalRef.current = null;
        }
        if (playerRef.current && playerRef.current.destroy) {
          try {
            playerRef.current.destroy();
          } catch {
            // ignore
          }
          playerRef.current = null;
        }
        setPlayerReady(false);
        playerReadyRef.current = false;
      };
    }
  }, [view, videoData, useTTS]);

  // ============ Play sentence ============

  const playSentence = useCallback(
    (sentence) => {
      if (!sentence) return;
      setReplayCount((prev) => prev + 1);

      if (!useTTS && playerRef.current && playerReadyRef.current && playerRef.current.seekTo) {
        try {
          if (stopIntervalRef.current) clearInterval(stopIntervalRef.current);

          // Option 2: Seek to start of current chunk, stop at the start of the NEXT chunk
          playerRef.current.seekTo(sentence.start, true);
          playerRef.current.playVideo();

          // Stop time = next chunk's start — the most reliable audio boundary.
          // Fall back to end/duration if nextStart is missing or invalid.
          let stopTime = sentence.nextStart;
          if (
            typeof stopTime !== 'number' ||
            !isFinite(stopTime) ||
            stopTime <= sentence.start + 0.1
          ) {
            stopTime =
              sentence.end ??
              sentence.start + Math.max(typeof sentence.duration === 'number' ? sentence.duration : 2, 2);
          }

          // YouTube's seekTo() is async — getCurrentTime() can return a STALE value
          // (the pre-seek position, which may be > stopTime) during the seek window.
          // If we polled during that window we would pause immediately after seek.
          //
          // Solution: only start checking for the stop condition once currentTime
          // has actually reached the target chunk (start - tolerance) — and is still
          // BELOW stopTime. A stale value from before the seek completes will be ABOVE
          // stopTime, so we keep waiting. This handles both slow seeks and very
          // short sentences (no arbitrary grace period that could swallow the audio).
          const expectedStart = sentence.start;
          const seekStartMs = Date.now();
          const maxSeekWaitMs = 1000;
          let started = false;
          // Poll very frequently to stop at exact time - NO BUFFER
          const checkInterval = 5;
          stopIntervalRef.current = setInterval(() => {
            try {
              const currentTime = playerRef.current.getCurrentTime();
              // Guard against invalid values returned during seeking/buffering
              if (typeof currentTime !== 'number' || !isFinite(currentTime)) return;

              if (!started) {
                // Consider the seek "complete" when currentTime lands at/near the
                // chunk start (while still below stopTime). Fall back to a timeout
                // if the seek never reports a value in range (e.g. very long seeks).
                const reachedTarget =
                  currentTime >= expectedStart - 0.2 && currentTime < stopTime;
                const seekTimedOut = Date.now() - seekStartMs > maxSeekWaitMs;
                if (!reachedTarget && !seekTimedOut) {
                  return; // still seeking — ignore stale values
                }
                started = true;
              }

              if (currentTime >= stopTime) {
                playerRef.current.pauseVideo();
                clearInterval(stopIntervalRef.current);
                stopIntervalRef.current = null;
              }
            } catch {
              clearInterval(stopIntervalRef.current);
              stopIntervalRef.current = null;
            }
          }, checkInterval);
          return;
        } catch {
          // Fallback to TTS
        }
      }

      // Fallback: TTS — only if video can't embed (useTTS = true)
      // If player not ready yet, do nothing (silent) — auto-play will handle it when ready
      if (!useTTS) return;

      if (!('speechSynthesis' in window)) {
        showToast('Trình duyệt không hỗ trợ đọc tiếng');
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(sentence.text);
      utterance.lang = 'en-US';
      utterance.rate = speedRef.current;
      utterance.pitch = 1;
      const voices = window.speechSynthesis.getVoices();
      const preferredVoice =
        voices.find((v) => v.lang === 'en-US' && v.name.includes('Google')) ||
        voices.find((v) => v.lang === 'en-US') ||
        voices.find((v) => v.lang.startsWith('en'));
      if (preferredVoice) utterance.voice = preferredVoice;
      window.speechSynthesis.speak(utterance);
    },
    [useTTS, showToast]
  );

  const stopPlaying = () => {
    if (playerRef.current && playerReadyRef.current && playerRef.current.pauseVideo) {
      try {
        playerRef.current.pauseVideo();
      } catch {
        // ignore
      }
    }
    if (stopIntervalRef.current) {
      clearInterval(stopIntervalRef.current);
      stopIntervalRef.current = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsPlaying(false);
  };

  // ============ Speed change ============

  const changeSpeed = (newSpeed) => {
    setSettings((prev) => ({ ...prev, speed: newSpeed }));
    speedRef.current = newSpeed;
    if (playerRef.current && playerReadyRef.current && playerRef.current.setPlaybackRate) {
      try {
        playerRef.current.setPlaybackRate(newSpeed);
      } catch {
        // ignore
      }
    }
  };

  // ============ Search & Load ============

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchError('');
    try {
      const res = await fetch(API(`/search?q=${encodeURIComponent(searchQuery)}`));
      const data = await res.json();
      if (!res.ok) {
        setSearchError(data.error || 'Search failed');
        if (data.hint) setSearchError((prev) => `${prev}. ${data.hint}`);
        setSearchResults([]);
      } else {
        setSearchResults(data.videos || []);
      }
    } catch {
      setSearchError('Không kết nối được backend. Kiểm tra server đang chạy.');
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleLoadUrl = async () => {
    if (!urlInput.trim()) return;
    await loadTranscript(urlInput.trim());
  };

  const loadTranscript = async (urlOrId) => {
    setLoadingTranscript(true);
    setTranscriptError('');
    setUseTTS(false);
    try {
      const res = await fetch(API(`/transcript?url=${encodeURIComponent(urlOrId)}`));
      const data = await res.json();
      if (!res.ok) {
        setTranscriptError(data.error || 'Failed to load transcript');
        return;
      }
      setVideoData(data);
      setView('setup');
    } catch {
      setTranscriptError('Không kết nối được backend. Kiểm tra server đang chạy.');
    } finally {
      setLoadingTranscript(false);
    }
  };

  // ============ Setup & Start ============

  const startPractice = () => {
    if (!videoData) return;
    // 0 = all sentences, otherwise slice
    const count = settings.numSentences === 0 
      ? videoData.sentences.length 
      : Math.min(settings.numSentences, videoData.sentences.length);
    setPracticeSentences(videoData.sentences.slice(0, count));
    setCurrentIndex(0);
    setUserAnswer('');
    setShowResult(false);
    setResult(null);
    setReplayCount(0);
    setScore(0);
    setTotalCorrect(0);
    setTotalWrong(0);
    setView('practice');
  };

  // ============ Answer Checking (Progressive) ============

  const checkAnswer = () => {
    const current = practiceSentences[currentIndex];
    if (!current) return;
    lastCheckTimeRef.current = Date.now();

    const correctWords = normalizeText(current.text).split(' ');
    const userWords = normalizeText(userAnswer).split(' ').filter(Boolean);

    let correctCount = 0;
    let firstWrongIndex = -1;
    const wordResults = [];

    for (let i = 0; i < correctWords.length; i++) {
      const userWord = userWords[i] || '';
      if (userWord && wordSimilarity(correctWords[i], userWord) >= 0.7) {
        correctCount++;
        wordResults.push({ word: correctWords[i], status: 'correct' });
      } else {
        if (firstWrongIndex === -1) firstWrongIndex = i;
        wordResults.push({
          word: correctWords[i],
          status: userWord ? 'wrong' : 'missing',
          userWord
        });
      }
    }

    for (let i = correctWords.length; i < userWords.length; i++) {
      wordResults.push({ word: userWords[i], status: 'extra' });
    }

    const accuracy = correctWords.length > 0 ? correctCount / correctWords.length : 0;
    const isCorrect = accuracy >= 0.8;

    setResult({
      isCorrect,
      accuracy,
      wordResults,
      firstWrongIndex,
      correctText: current.text,
      userText: userAnswer.trim()
    });
    setShowResult(true);

    if (isCorrect) {
      setTotalCorrect((prev) => prev + 1);
    }
  };

  // Retry: clear result, let user edit answer
  const retryAnswer = () => {
    setShowResult(false);
    setResult(null);
    // Focus textarea
    if (answerRef.current) {
      answerRef.current.focus();
    }
  };

  // Skip: show correct answer, count as wrong, let user see before advancing
  const skipSentence = () => {
    const current = practiceSentences[currentIndex];
    if (!current) return;

    const correctWords = normalizeText(current.text).split(' ');
    const wordResults = correctWords.map(word => ({ word, status: 'correct' }));

    setResult({
      isCorrect: false,
      accuracy: 0,
      wordResults,
      firstWrongIndex: -1,
      correctText: current.text,
      userText: '',
      skipped: true
    });
    setShowResult(true);
    setTotalWrong((prev) => prev + 1);
  };

  const nextSentence = () => {
    if (currentIndex < practiceSentences.length - 1) {
      stopPlaying();
      const nextIndex = currentIndex + 1;
      setCurrentIndex(nextIndex);
      setUserAnswer('');
      setShowResult(false);
      setResult(null);
      setReplayCount(0);
      // Auto-play next sentence immediately - NO DELAY
      const next = practiceSentences[nextIndex];
      if (next) playSentence(next);
    } else {
      const total = totalCorrect + totalWrong;
      const finalScore = total > 0 ? Math.round((totalCorrect / total) * 100) : 0;
      setScore(finalScore);
      if (videoData) {
        const historyEntry = {
          id: Date.now(),
          videoId: videoData.videoId,
          title: videoData.title,
          author: videoData.author,
          thumbnail: videoData.thumbnail,
          score: finalScore,
          correct: totalCorrect,
          wrong: totalWrong,
          total,
          date: new Date().toISOString()
        };
        setHistory((prev) => [historyEntry, ...prev].slice(0, 50));
      }
      stopPlaying();
      setView('score');
    }
  };

  // ============ Hotkeys ============
  // Enter = check answer / next sentence (when correct)
  // Ctrl = replay audio
  // Esc = skip sentence

  useEffect(() => {
    const handleKey = (e) => {
      if (view !== 'practice') return;

      // Enter = check answer only; when correct, DON'T auto-advance
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!showResult) {
          // Not showing result → check answer
          if (userAnswer.trim()) checkAnswer();
        } else if (result && result.isCorrect) {
          // Correct → DO NOTHING, let user click button or wait
          // User must click "Câu tiếp theo" button to advance
        } else {
          // Wrong → check again (user may have edited answer)
          if (userAnswer.trim()) checkAnswer();
        }
        return;
      }

      // Ctrl (alone) = replay audio
      if (e.key === 'Control') {
        e.preventDefault();
        playSentence(practiceSentences[currentIndex]);
        return;
      }

      // Esc = skip sentence
      if (e.key === 'Escape') {
        e.preventDefault();
        skipSentence();
        return;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [view, showResult, userAnswer, currentIndex, practiceSentences, result]);

  // ============ Render Helpers ============

  const renderResultWords = () => {
    if (!result) return null;
    // Progressive: show correct words (green), first wrong (red), rest hidden (___)
    let foundWrong = false;
    return result.wordResults.map((item, i) => {
      if (item.status === 'extra') {
        return (
          <span key={i} className="wrong-word" title="Từ thừa">
            {item.word}{' '}
          </span>
        );
      }
      if (item.status === 'correct') {
        return (
          <span key={i} className="correct-word">
            {item.word}{' '}
          </span>
        );
      }
      // First wrong — show the answer word
      if (!foundWrong) {
        foundWrong = true;
        return (
          <span key={i} className="wrong-word" title={item.userWord ? `Bạn gõ: ${item.userWord}` : 'Thiếu từ'}>
            {item.word}{' '}
          </span>
        );
      }
      // After first wrong — blank out
      return (
        <span key={i} className="blank-hidden">
          {'___ '}
        </span>
      );
    });
  };

  const renderBlankSentence = () => {
    const current = practiceSentences[currentIndex];
    if (!current) return null;
    const words = current.text.split(' ');
    const blankCount = Math.min(settings.blankCount, words.length);
    const blankIndices = new Set();
    while (blankIndices.size < blankCount) {
      blankIndices.add(Math.floor(Math.random() * words.length));
    }
    return words.map((word, i) =>
      blankIndices.has(i) ? (
        <span key={i} className="blank">
          {word}
        </span>
      ) : (
        <span key={i}> {word}</span>
      )
    );
  };

  // ============ Render ============

  return (
    <div className="app">
      <header className="header">
        <div className="container header-inner">
          <div className="logo">
            {/* Minimalist audio-wave-in-play-button icon (Nordic Light) */}
            <svg
              className="logo-icon"
              width="32"
              height="32"
              viewBox="0 0 32 32"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* Soft rounded play-button container */}
              <rect x="1" y="1" width="30" height="30" rx="9" fill="#EEF2FF" stroke="#C7D2FE" strokeWidth="1.5" />
              {/* Play triangle */}
              <path d="M13 10.5L21 16L13 21.5V10.5Z" fill="#4F46E5" />
              {/* Audio waves */}
              <path d="M9 14V18" stroke="#4F46E5" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M6 12.5V19.5" stroke="#A5B4FC" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M24 14V18" stroke="#4F46E5" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M27 12.5V19.5" stroke="#A5B4FC" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <span className="logo-text">
              <span className="logo-dicta">Dicta</span>
              <span className="logo-tube">Tube</span>
            </span>
          </div>
          <div className="header-nav">
            {view !== 'home' && (
              <button
                className="header-nav-btn"
                onClick={() => {
                  stopPlaying();
                  setView('home');
                }}
              >
                ← Home
              </button>
            )}
            {history.length > 0 && (
              <button
                className="header-nav-btn"
                onClick={() => {
                  stopPlaying();
                  setView('history');
                }}
              >
                📜 History
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="container">
        {view === 'home' && (
          <div className="search-section">
            <h1 className="search-title">Luyện nghe tiếng Anh qua YouTube</h1>
            <p className="search-subtitle">
              Chọn video yêu thích — game, vlog, phim, talkshow... và luyện dictation ngay!
            </p>

            <div className="search-box">
              <input
                type="text"
                placeholder="🔍 Tìm video... (vd: minecraft gameplay, mrbeast, podcast)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
              <button className="btn btn-primary" onClick={handleSearch} disabled={searching}>
                {searching ? '...' : 'Search'}
              </button>
            </div>

            <div className="divider">hoặc</div>

            <div className="search-box">
              <input
                type="text"
                placeholder="🔗 Dán URL YouTube hoặc Video ID"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLoadUrl()}
              />
              <button className="btn btn-secondary" onClick={handleLoadUrl} disabled={loadingTranscript}>
                {loadingTranscript ? '...' : 'Load'}
              </button>
            </div>

            {searchError && <div className="error-box">{searchError}</div>}
            {transcriptError && <div className="error-box">{transcriptError}</div>}

            {loadingTranscript && (
              <div className="loading">
                <div className="spinner" />
                <p>Đang tải transcript...</p>
              </div>
            )}

            {searching && (
              <div className="loading">
                <div className="spinner" />
                <p>Đang tìm video...</p>
              </div>
            )}

            {searchResults.length > 0 && (
              <div className="video-grid">
                {searchResults.map((video) => (
                  <div
                    key={video.id}
                    className="video-card"
                    onClick={() => loadTranscript(video.id)}
                  >
                    <img className="video-thumb" src={video.thumbnail} alt={video.title} loading="lazy" />
                    <div className="video-info">
                      <div className="video-title">{video.title}</div>
                      <div className="video-channel">{video.channel}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!searchResults.length && !searching && !loadingTranscript && (
              <div className="empty-state">
                <div className="empty-state-icon">🎯</div>
                <p>
                  Tìm video hoặc dán URL để bắt đầu luyện tập.
                  <br />
                  <small>Video cần có phụ đề tiếng Anh (auto-generated cũng được).</small>
                </p>
              </div>
            )}
          </div>
        )}

        {view === 'setup' && videoData && (
          <div className="setup-section">
            <div className="card setup-card">
              <div className="setup-video">
                <img src={videoData.thumbnail} alt={videoData.title} />
                <div className="setup-video-info">
                  <h2>{videoData.title}</h2>
                  <p>{videoData.author}</p>
                  <p style={{ marginTop: '8px', color: 'var(--secondary)' }}>
                    ✅ {videoData.totalSentences} câu có sẵn để luyện
                  </p>
                </div>
              </div>

              <div className="setup-options">
                <div className="setup-option">
                  <label>Chế độ luyện</label>
                  <select
                    value={settings.mode}
                    onChange={(e) => setSettings({ ...settings, mode: e.target.value })}
                  >
                    <option value="full">Nghe & gõ cả câu</option>
                    <option value="blank">Điền từ còn thiếu</option>
                  </select>
                </div>

                <div className="setup-option">
                  <label>Số câu luyện</label>
                  <select
                    value={settings.numSentences}
                    onChange={(e) => setSettings({ ...settings, numSentences: parseInt(e.target.value) })}
                  >
                    <option value={0}>Tất cả ({videoData.totalSentences} câu)</option>
                    <option value={5}>5 câu đầu</option>
                    <option value={10}>10 câu đầu</option>
                    <option value={20}>20 câu đầu</option>
                    <option value={50}>50 câu đầu</option>
                  </select>
                </div>

                <div className="setup-option">
                  <label>Tốc độ phát</label>
                  <select
                    value={String(settings.speed)}
                    onChange={(e) => changeSpeed(parseFloat(e.target.value))}
                  >
                    <option value="0.25">0.25x (rất chậm)</option>
                    <option value="0.5">0.5x (chậm)</option>
                    <option value="0.75">0.75x</option>
                    <option value="1">1.0x (bình thường)</option>
                    <option value="1.25">1.25x</option>
                    <option value="1.5">1.5x (nhanh)</option>
                  </select>
                </div>

                {settings.mode === 'blank' && (
                  <div className="setup-option">
                    <label>
                      Số từ bị ẩn: <span className="range-value">{settings.blankCount}</span>
                    </label>
                    <input
                      type="range"
                      min="1"
                      max="6"
                      value={settings.blankCount}
                      onChange={(e) => setSettings({ ...settings, blankCount: parseInt(e.target.value) })}
                    />
                  </div>
                )}
              </div>

              <div className="setup-actions">
                <button className="btn btn-outline" onClick={() => setView('home')}>
                  Hủy
                </button>
                <button className="btn btn-primary" onClick={startPractice}>
                  Bắt đầu luyện 🚀
                </button>
              </div>
            </div>
          </div>
        )}

        {view === 'practice' && practiceSentences.length > 0 && (
          <div className="practice-section">
            {/* Top progress bar */}
            <div className="practice-header" style={{ maxWidth: '1400px', margin: '0 auto 20px' }}>
              <div className="practice-progress">
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${((currentIndex + (showResult && result?.isCorrect ? 1 : 0)) / practiceSentences.length) * 100}%`
                    }}
                  />
                </div>
                <span className="progress-text">
                  {currentIndex + 1} / {practiceSentences.length}
                </span>
              </div>
              <button className="btn btn-outline btn-sm" onClick={() => { stopPlaying(); setView('home'); }}>
                ✕ Thoát
              </button>
            </div>

            {/* Split-screen: 55% video / 45% workspace */}
            <div className="practice-split">
              {/* LEFT: Video player */}
              <div className="practice-left">
                {showVideo && !useTTS && (
                  <div className="practice-video">
                    <div id="youtube-player-div" style={{ width: '100%', height: '100%' }} />
                  </div>
                )}
                {useTTS && (
                  <div className="video-toggle-row">
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                      📢 Đang dùng giọng đọc TTS (video không embed được)
                    </span>
                  </div>
                )}
                {showVideo && !useTTS && (
                  <div className="video-toggle-row">
                    <button className="btn btn-outline btn-sm" onClick={() => setShowVideo(false)}>
                      🙈 Ẩn video
                    </button>
                  </div>
                )}
                {!showVideo && !useTTS && (
                  <div className="video-toggle-row">
                    <button className="btn btn-outline btn-sm" onClick={() => setShowVideo(true)}>
                      👁 Hiện video
                    </button>
                  </div>
                )}
              </div>

              {/* RIGHT: Dictation workspace */}
              <div className="practice-right">
                <div className="card practice-card">
                  <div className="sentence-number">Câu {currentIndex + 1}</div>

                  {settings.mode === 'blank' && !showResult && (
                    <div className="sentence-text">{renderBlankSentence()}</div>
                  )}

                  {settings.mode === 'full' && !showResult && (
                    <div className="sentence-text" style={{ color: 'var(--text-muted)', fontSize: '1rem' }}>
                      🎧 Nghe và gõ lại chính xác những gì bạn nghe được
                    </div>
                  )}

                  <div className="audio-controls">
                    <button
                      className="play-btn"
                      onClick={() => playSentence(practiceSentences[currentIndex])}
                      title="Phát lại (Ctrl)"
                    >
                      {isPlaying ? '⏸' : '▶'}
                    </button>
                    {isPlaying && (
                      <button className="btn btn-outline btn-sm" onClick={stopPlaying}>
                        Dừng
                      </button>
                    )}
                    <div className="speed-control">
                      <label>Tốc độ:</label>
                      <select
                        value={String(settings.speed)}
                        onChange={(e) => changeSpeed(parseFloat(e.target.value))}
                      >
                        <option value="0.25">0.25x</option>
                        <option value="0.5">0.5x</option>
                        <option value="0.75">0.75x</option>
                        <option value="1">1.0x</option>
                        <option value="1.25">1.25x</option>
                        <option value="1.5">1.5x</option>
                      </select>
                    </div>
                    <span className="replay-count">Đã nghe: {replayCount} lần</span>
                  </div>

                  {/* Answer input — always editable */}
                  <textarea
                    ref={answerRef}
                    className="answer-input"
                    placeholder={
                      settings.mode === 'full'
                        ? 'Gõ câu bạn nghe được... (Enter = kiểm tra, Shift+Enter = xuống dòng)'
                        : 'Điền các từ còn thiếu... (Enter = kiểm tra)'
                    }
                    value={userAnswer}
                    onChange={(e) => setUserAnswer(e.target.value)}
                  />

                  {/* Result — progressive, shown when checked */}
                  {showResult && result && (
                    <div className="result-box">
                      <div className="result-correct">
                        {result.isCorrect ? '🎉 Chính xác!' : result.skipped ? '⏭ Đã bỏ qua' : '❌ Chưa đúng, xem gợi ý:'}
                      </div>
                      <div className="result-answer">{renderResultWords()}</div>
                      {!result.isCorrect && (
                        <p style={{ marginTop: '12px', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                          Độ chính xác: {Math.round(result.accuracy * 100)}% — <span style={{ color: 'var(--secondary)' }}>Xanh</span> = đúng, <span style={{ color: 'var(--danger)' }}>Đỏ</span> = sai, <span style={{ borderBottom: '2px solid var(--text-muted)' }}>___</span> = chưa xem. Sửa lại rồi nhấn Enter để kiểm tra tiếp!
                        </p>
                      )}
                    </div>
                  )}

                  {/* Actions — different when correct vs wrong */}
                  {!showResult ? (
                    <div className="answer-actions">
                      <button className="btn btn-outline" onClick={skipSentence}>
                        Bỏ qua
                      </button>
                      <button className="btn btn-primary" onClick={checkAnswer} disabled={!userAnswer.trim()}>
                        Kiểm tra ✓
                      </button>
                    </div>
                  ) : result.isCorrect || result.skipped ? (
                    <div className="answer-actions">
                      <button
                        className="btn btn-outline"
                        onClick={() => playSentence(practiceSentences[currentIndex])}
                      >
                        🔁 Nghe lại
                      </button>
                      <button className="btn btn-primary" onClick={nextSentence}>
                        {currentIndex < practiceSentences.length - 1 ? 'Câu tiếp theo →' : 'Xem kết quả 🏆'}
                      </button>
                    </div>
                  ) : (
                    <div className="answer-actions">
                      <button className="btn btn-outline" onClick={skipSentence}>
                        ⏭ Bỏ qua câu này
                      </button>
                      <button className="btn btn-outline" onClick={() => playSentence(practiceSentences[currentIndex])}>
                        🔁 Nghe lại
                      </button>
                      <button className="btn btn-primary" onClick={retryAnswer}>
                        ✏️ Thử lại
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Floating keyboard shortcuts legend */}
            <div className="shortcuts-legend">
              <span><kbd>Enter</kbd> Kiểm tra</span>
              <span><kbd>Ctrl</kbd> Phát lại</span>
              <span><kbd>Esc</kbd> Bỏ qua</span>
              <span><kbd>Shift</kbd>+<kbd>Enter</kbd> Xuống dòng</span>
            </div>
          </div>
        )}

        {view === 'score' && (
          <div className="score-section">
            <div className="card score-card">
              <h2 style={{ marginBottom: '24px' }}>Kết quả luyện tập</h2>
              <div className="score-circle" style={{ '--score': score }}>
                <span>{score}%</span>
              </div>

              <div className="score-stats">
                <div className="score-stat">
                  <div className="score-stat-value" style={{ color: 'var(--secondary)' }}>
                    {totalCorrect}
                  </div>
                  <div className="score-stat-label">Đúng</div>
                </div>
                <div className="score-stat">
                  <div className="score-stat-value" style={{ color: 'var(--danger)' }}>
                    {totalWrong}
                  </div>
                  <div className="score-stat-label">Sai</div>
                </div>
                <div className="score-stat">
                  <div className="score-stat-value">{totalCorrect + totalWrong}</div>
                  <div className="score-stat-label">Tổng câu</div>
                </div>
              </div>

              <div className="score-actions">
                <button className="btn btn-outline" onClick={() => setView('home')}>
                  🏠 Về trang chủ
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setCurrentIndex(0);
                    setUserAnswer('');
                    setShowResult(false);
                    setResult(null);
                    setReplayCount(0);
                    setScore(0);
                    setTotalCorrect(0);
                    setTotalWrong(0);
                    setView('practice');
                  }}
                >
                  🔄 Luyện lại
                </button>
              </div>
            </div>
          </div>
        )}

        {view === 'history' && (
          <div className="history-section">
            <h2 style={{ marginBottom: '20px' }}>📜 Lịch sử luyện tập</h2>
            {history.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📭</div>
                <p>Chưa có lịch sử luyện tập nào.</p>
              </div>
            ) : (
              <div className="history-list">
                {history.map((item) => (
                  <div key={item.id} className="history-item">
                    <img src={item.thumbnail} alt={item.title} />
                    <div className="history-info">
                      <div className="history-title">{item.title}</div>
                      <div className="history-meta">
                        {item.author} • {new Date(item.date).toLocaleDateString('vi-VN')} •{' '}
                        {item.correct}/{item.total} câu đúng
                      </div>
                    </div>
                    <div className="history-score">{item.score}%</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: '20px' }}>
              <button className="btn btn-outline" onClick={() => setView('home')}>
                ← Về trang chủ
              </button>
            </div>
          </div>
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default App;