#!/bin/bash
# Crear carpeta para modelos si no existe
mkdir -p modelos
cd modelos

# URL del modelo Salomé (Colombiano) de Sherpa-ONNX
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_CO-salome-medium.tar.bz2"

# Verificar si el archivo ya existe antes de intentar descargar
if [ ! -f "vits-piper-es_CO-salome-medium/es_CO-salome-medium.onnx" ]; then
    echo "⬇️ Descargando modelo de voz local (Salomé)..."
    
    # Usar curl en lugar de wget. -L es para seguir redirecciones.
    if curl -L -o vits-piper-es_CO-salome-medium.tar.bz2 "$MODEL_URL"; then
        echo "📦 Descomprimiendo archivos..."
        tar xjf vits-piper-es_CO-salome-medium.tar.bz2
        rm vits-piper-es_CO-salome-medium.tar.bz2
        echo "✅ Modelo listo para usar."
    else
        echo "❌ Error: No se pudo descargar el modelo. Revisa la conexión o URL."
        exit 1
    fi
else
    echo "✔ El modelo ya existe en la carpeta, saltando descarga."
fi