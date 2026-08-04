FROM node:20-slim

# Chỉ cài ffmpeg và curl
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cài đặt dependencies
COPY backend/package*.json ./
RUN npm install --omit=dev

# Copy code
COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["node", "backend/server.js"]