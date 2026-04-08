# Usamos la imagen completa de Node para evitar que falten librerías de sistema
FROM node:18

# Instalamos ffmpeg y las dependencias de Chromium para WhatsApp
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libgbm1 \
    libnss3 \
    libxss1 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiamos archivos de configuración
COPY package*.json ./

# Instalamos dependencias (incluyendo puppeteer)
RUN npm install

# Copiamos el resto del código
COPY . .

# Variables de entorno críticas para que Puppeteer no falle en Docker
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# EXPOSE debe coincidir con el puerto que configuraste en server.js
EXPOSE 8000

# Asegúrate de que tu archivo principal se llame server.js
CMD ["node", "server.js"]
