FROM node:20-slim

# Instalamos ffmpeg, curl (para el script de descarga) y bzip2 (para descomprimir el modelo)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    bzip2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de producción
RUN npm install --omit=dev

# Copiar el resto del código
COPY . .

# Dar permisos de ejecución al script de descarga
RUN chmod +x download_model.sh

EXPOSE 8000

# IMPORTANTE: Ejecutamos el script de descarga ANTES de iniciar la app
# Cambiamos server.js por index.js
CMD ["sh", "-c", "./download_model.sh && node index.js"]
