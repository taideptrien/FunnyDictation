# 🎧 DictaTube

**Luyện nghe tiếng Anh qua video YouTube yêu thích** — Chọn video bất kỳ từ YouTube, nghe từng câu, gõ lại chính xác những gì bạn nghe được!

## ✨ Tính năng

- 🔍 **Tìm kiếm video** YouTube trực tiếp (cần YouTube Data API v3 key)
- 📝 **Tự động tách câu** từ transcript (hỗ trợ auto-generated captions)
- 🎯 **Dictation tương tác**: nghe → gõ → kiểm tra → sửa lỗi từng từ
- 🎬 **Audio dừng chính xác** tại ranh giới câu
- 🔊 **TTS fallback** khi video không embed được
- 🤖 **AI Transcription** (Groq Whisper) cho video không có phụ đề
- 🏆 **Điểm số & lịch sử** luyện tập
- ⌨️ **Phím tắt** (Enter, Ctrl, Esc)
- 📱 **Responsive** — desktop split-screen + mobile

## 🛠️ Tech Stack

| Layer | Công nghệ |
|-------|-----------|
| Frontend | React 18, Vite |
| Backend | Node.js, Express |
| Transcript | youtube-transcript-api, youtube-transcript |
| AI Transcription | Groq Whisper (`whisper-large-v3`) |
| Audio processing | yt-dlp, ffmpeg |

## 🚀 Cài đặt

### Yêu cầu
- Node.js ≥ 18
- npm
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (cho AI transcription fallback)
- [ffmpeg](https://ffmpeg.org/) (cho AI transcription fallback)

### Bước 1: Clone & cài dependencies

```bash
git clone https://github.com/YOUR_USERNAME/DictaTube.git
cd DictaTube

# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### Bước 2: Cấu hình Backend

```bash
cd backend
cp .env.example .env
```

Mở `.env` và điền:

```env
# YouTube API key (tùy chọn, cho tính năng tìm kiếm)
# Lấy miễn phí tại: https://console.cloud.google.com/apis/credentials
YOUTUBE_API_KEY=YOUR_YOUTUBE_API_KEY

# Groq API keys (chỉ cần cho video KHÔNG có phụ đề)
# Groq rate limit theo ACCOUNT — nhóm keys theo Gmail:
GROQ_ACCOUNTS_JSON=[{"accountName":"gmail_1","keys":["gsk_key1","gsk_key2"]},{"accountName":"gmail_2","keys":["gsk_key3"]}]
```

### Bước 3: Cấu hình Frontend (tùy chọn)

```bash
cd frontend
cp .env.example .env  # chỉ cần nếu API server khác localhost:5001
```

### Bước 4: Chạy

```bash
# Terminal 1 — Backend (port 5001)
cd backend
npm run dev

# Terminal 2 — Frontend (port 3000)
cd frontend
npm run dev
```

Mở **http://localhost:3000** 🎉

## 🔐 Bảo mật

- **KHÔNG bao giờ** commit `.env` — nó đã được thêm vào `.gitignore`
- `backend/.env.example` chỉ chứa placeholder (không có key thật)
- Groq keys được tổ chức theo account (`GROQ_ACCOUNTS_JSON`) vì rate limit áp dụng ở cấp account

## 📁 Cấu trúc dự án

```
DictaTube/
├── backend/
│   ├── server.js            # Express server chính
│   ├── whisperPipeline.js   # Groq Whisper AI transcription pipeline
│   ├── .env.example         # Mẫu env (không chứa key thật)
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx          # React app chính
│   │   └── index.css        # Nordic Light styles
│   ├── vite.config.js       # Vite + proxy API
│   └── .env.example
└── .gitignore
```

## 🤝 Đóng góp

Pull requests luôn được chào đón! Hãy tạo issue trước khi thực hiện thay đổi lớn.

## 📄 License

MIT