FROM node:20

# Instalamos ffmpeg para las mezclas de audio de Salomé
RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Puerto obligatorio para Hugging Face
EXPOSE 7860

CMD ["node", "server.js"]
