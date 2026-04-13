cat << 'EOF' > download_model.sh
#!/bin/bash
# Crear carpeta para modelos si no existe
mkdir -p modelos
cd modelos

# URL del modelo Salomé (Colombiano) de Sherpa-ONNX
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_CO-salome-medium.tar.bz2"
FILE="vits-piper-es_CO-salome-medium.tar.bz2"

if [ ! -f "vits-piper-es_CO-salome-medium/es_CO-salome-medium.onnx" ]; then
    echo "⬇️ Descargando modelo de voz local (Salomé)..."
    
    # Intentar descargar con curl (común en servidores nube)
    curl -L -o "$FILE" "$MODEL_URL"

    # Validar que el archivo descargado sea real (mínimo 10MB)
    if [ -f "$FILE" ] && [ $(wc -c <"$FILE") -ge 10000000 ]; then
        echo "📦 Descomprimiendo archivos..."
        tar xjf "$FILE"
        rm "$FILE"
        echo "✅ Modelo listo para usar."
    else
        echo "❌ Error: La descarga falló o el archivo está incompleto."
        exit 1
    fi
else
    echo "✔ El modelo ya existe, saltando descarga."
fi
EOF
