FROM node:20-slim

# Instalar FFmpeg (VITAL para mezclar el audio de Salomé)
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 7860

CMD ["node", "server.js"]
