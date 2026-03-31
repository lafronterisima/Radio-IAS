 
# Usamos una imagen de Node compacta pero completa
FROM node:18-slim

# INSTALACIÓN CLAVE: Instalamos ffmpeg directamente en el sistema operativo
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Directorio de trabajo
WORKDIR /app

# Copiamos solo los archivos de dependencias primero (optimiza el tiempo de carga)
COPY package*.json ./
RUN npm install --production

# Copiamos el resto del código y tu archivo de fondo musical
COPY . .

# Exponemos el puerto para Koyeb
EXPOSE 3000

# Comando para arrancar el DJ
CMD ["node", "server.js"]