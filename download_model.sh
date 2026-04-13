#!/bin/bash
mkdir -p modelos
cd modelos

# URL del modelo Salomé SMALL (Mucho más liviano)
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_CO-salome-low.tar.bz2"
FILE="vits-piper-es_CO-salome-low.tar.bz2"

if [ ! -f "vits-piper-es_CO-salome-low/es_CO-salome-low.onnx" ]; then
    echo "⬇️ Descargando modelo LIVIANO (Salomé)..."
    curl -L -o "$FILE" "$MODEL_URL"

    if [ -f "$FILE" ] && [ $(wc -c <"$FILE") -ge 5000000 ]; then
        echo "📦 Descomprimiendo..."
        tar xjf "$FILE"
        rm "$FILE"
        echo "✅ Modelo liviano listo."
    else
        echo "❌ Error en descarga."
        exit 1
    fi
else
    echo "✔ El modelo ya existe."
fi
