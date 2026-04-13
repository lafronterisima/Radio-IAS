#!/bin/bash
mkdir -p modelos/vits-piper-es_CO-salome-low
cd modelos/vits-piper-es_CO-salome-low
if [ ! -f "es_CO-salome-low.onnx" ]; then
  wget https://huggingface.co/csukuangfj/vits-piper-es_CO-salome-low/resolve/main/es_CO-salome-low.onnx
  wget https://huggingface.co/csukuangfj/vits-piper-es_CO-salome-low/resolve/main/tokens.txt
  # Descargar carpeta espeak-ng-data si es necesario
fi
