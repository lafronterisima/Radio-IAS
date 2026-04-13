#!/bin/bash
mkdir -p modelos
cd modelos

# URL del modelo liviano
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_CO-salome-low.tar.bz2"
FILE="modelo.tar.bz2"

if [ ! -f "vits-piper-es_CO-salome-low/es_CO-salome-low.onnx" ]; then
    echo "⬇️ Descargando modelo liviano..."
    curl -L -o "$FILE" "$MODEL_URL"
    
    echo "📦 Descomprimiendo..."
    tar xjf "$FILE"
    rm "$FILE"
    
    # Verificación de seguridad: listar lo que se descargó
    ls -R
    echo "✅ Proceso de descarga finalizado."
else
    echo "✔ El modelo ya existe en la ruta correcta."
fi
