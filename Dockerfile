FROM node:20-slim

# Solo lo necesario
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 8000

ENV NODE_ENV=production

CMD ["node", "server.js"]
