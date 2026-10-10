# Usamos una imagen de Node estable
FROM node:20-slim

# Instalamos FFmpeg (VITAL para mezclar el audio de Salomé)
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Creamos la carpeta de la app
WORKDIR /app

# Copiamos los archivos de dependencias
COPY package*.json ./

# Instalamos las librerías
RUN npm install

# Copiamos el resto del código
COPY . .

# Exponemos el puerto que configuramos
EXPOSE 7860

# Comando para arrancar
CMD ["node", "server.js"]
