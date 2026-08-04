# Use official lightweight Node.js runtime
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

# Set working directory inside container
WORKDIR /app

# Copy & install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY . .

# Expose application port
EXPOSE 5001

# Start the server
CMD ["node", "server.js"]