FROM node:20-slim

# Solo necesitamos ffmpeg para el audio
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 8000
CMD ["node", "server.js"]
