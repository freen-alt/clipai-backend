FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir -U yt-dlp --break-system-packages
RUN pip3 install --no-cache-dir -U openai-whisper --break-system-packages
RUN python3 -c "import whisper; whisper.load_model('base')"

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p downloads

EXPOSE 3001

CMD ["node", "server.js"]
