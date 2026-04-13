# Usamos una imagen de Node estable
FROM node:20-slim

# Instalar dependencias del sistema (FFmpeg es vital para tu radio)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de la app
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# >>> EJECUTAR instalación de producción
RUN npm install --omit=dev

# Copiar el resto del código
COPY . .

# Exponer el puerto de tu API
EXPOSE 8000

# Variable de entorno para producción
ENV NODE_ENV=production

# Comando de arranque
CMD ["node", "server.js"]
