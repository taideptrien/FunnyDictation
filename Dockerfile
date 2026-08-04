# 1. Sử dụng Node 20
FROM node:20-slim

# 2. Cài đặt các công cụ hệ thống
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 3. Cài đặt yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# 4. Đặt thư mục làm việc tại /app (Không đặt vào /app/backend nữa)
WORKDIR /app

# 5. Copy file package.json từ thư mục backend vào /app
COPY backend/package*.json ./

# 6. Cài đặt thư viện (Dùng npm install để tránh lỗi lệch file lock)
RUN npm install --omit=dev

# 7. Copy toàn bộ code từ GitHub vào /app
COPY . .

# 8. Render dùng cổng 10000
ENV PORT=10000
EXPOSE 10000

# 9. QUAN TRỌNG: Chạy file server.js nằm trong thư mục backend
CMD ["node", "backend/server.js"]