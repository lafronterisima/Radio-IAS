# Imagen base ligera pero compatible
FROM node:20-slim

# Instalar dependencias necesarias para Sherpa ONNX + audio
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    cmake \
    git \
    libsndfile1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /app

# Copiar dependencias primero (mejor cache)
COPY package*.json ./

# Instalar dependencias Node
RUN npm install --omit=dev

# Copiar el resto del código
COPY . .

# Puerto de tu API
EXPOSE 8000

# Variable entorno
ENV NODE_ENV=production

# Comando de inicio
CMD ["node", "server.js"]
