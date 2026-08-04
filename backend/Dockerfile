FROM node:20-alpine

# Install yt-dlp and ffmpeg for AI transcription fallback
RUN apk add --no-cache ffmpeg yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 5001

CMD ["npm", "start"]
