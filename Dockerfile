# 1. Usamos la imagen oficial de Node
FROM node:18-slim

# 2. INSTALACIÓN DE DEPENDENCIAS DEL SISTEMA
# Instalamos ffmpeg para el audio y las librerías necesarias para Chromium (WhatsApp)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libgconf-2-4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgdk-pixbuf2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    libnss3 \
    libxss1 \
    libasound2 \
    fonts-liberation \
    libappindicator3-1 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 3. Directorio de trabajo
WORKDIR /app

# 4. Instalación de dependencias de Node
COPY package*.json ./
# Instalamos todas incluyendo puppeteer
RUN npm install

# 5. Copiamos el código
COPY . .

# 6. CONFIGURACIÓN DE PUPPETEER
# Esto le dice a la librería de WhatsApp dónde encontrar el navegador
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# 7. Exponemos el puerto
EXPOSE 8000

# 8. Comando de arranque
CMD ["node", "server.js"]
