# Root level Dockerfile for Render
# Build the backend located in /backend
FROM node:20-slim

# Install system tools needed for ffmpeg, Python, and yt-dlp
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp from GitHub releases
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Set working directory inside container to backend
WORKDIR /app/backend

# Copy backend package files and lockfile
COPY backend/package*.json ./

# Chỗ này cũ là RUN npm ci ... hãy thay bằng:
RUN npm install --omit=dev

# Copy source code into container
COPY . .

# Expose application port
EXPOSE 10000

# Start the server from backend directory
CMD ["node", "server.js"]
