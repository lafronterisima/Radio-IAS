
# Imagen base Node.js
FROM node:20-bullseye

# Instalar ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar package.json e instalar dependencias
COPY package*.json ./
RUN npm install

# Copiar el resto de la app
COPY . .

# Variables de entorno se configuran en Render
ENV NODE_ENV=production

# Exponer puerto (Render lo usa)
EXPOSE 3000

# Ejecutar el web service
CMD ["node", "index.js"]