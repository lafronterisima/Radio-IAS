# 1. Usamos la imagen de Node oficial (Debian)
FROM node:18

# 2. INSTALACIÓN DE DEPENDENCIAS
# Instalamos ffmpeg y las dependencias necesarias para que corra el motor de WhatsApp (Chromium)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 3. Directorio de trabajo
WORKDIR /app

# 4. Copiamos dependencias e instalamos
COPY package*.json ./
RUN npm install

# 5. Copiamos el resto del código
COPY . .

# 6. Variables de entorno para Puppeteer
# Esto evita que Puppeteer intente descargar otro Chrome y use el del sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# 7. Puerto (Asegúrate de que coincida con tu server.js)
EXPOSE 8000

# 8. Comando de inicio
CMD ["node", "server.js"]
