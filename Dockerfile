FROM node:20-slim

# Instalar ffmpeg e dependências do yt-dlp
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Instalar yt-dlp (sempre a versão mais recente, sem cache)
RUN pip3 install --no-cache-dir -U yt-dlp --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p downloads

EXPOSE 3001

CMD ["node", "server.js"]
