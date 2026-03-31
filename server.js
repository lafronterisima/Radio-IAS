const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const Parser = require('rss-parser');
require('dotenv').config();

const app = express();
const parser = new Parser();

// ================= CONFIGURACIÓN =================
const AZURA_API = "https://az.azurafree.eu/api/station/24/files";
const AZURA_KEY = process.env.AZURA_KEY;
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_REGION;

// ================= UTILIDADES =================
function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

// ================= 1. GENERACIÓN DE GUION =================
async function crearGuion() {
  try {
    // 1. Obtener canción actual de AzuraCast
    const songRes = await axios.get("https://az.azurafree.eu/api/nowplaying/la_fronterisima");
    const nowPlaying = songRes.data.now_playing?.song;
    const artista = nowPlaying?.artist || "varios artistas";
    const cancion = nowPlaying?.title || "la mejor música";

    // 2. Obtener Clima (Cali)
    const weatherRes = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
    const temp = Math.round(weatherRes.data.current_weather.temperature);

    // 3. Obtener Noticias (RSS BBC)
    const feed = await parser.parseURL('https://feeds.bbci.co.uk/mundo/rss.xml');
    const noticias = feed.items.slice(0, 2).map(i => i.title).join(". ");

    return `Hola, son las ${getHora()} en Colombia. El clima en Cali es de ${temp} grados. Estás escuchando a ${artista} con el éxito ${cancion}. En noticias: ${noticias}. Sigue con más música en La Fronterísima.`;
  } catch (error) {
    console.error("⚠️ Error creando guion, usando versión simple:", error.message);
    return `Hola, son las ${getHora()}. Estás en sintonía de La Fronterísima, la radio que te acompaña con la mejor música las 24 horas.`;
  }
}

// ================= 2. SÍNTESIS DE VOZ (AZURE) =================
async function generarVoz(texto) {
  return new Promise((resolve, reject) => {
    if (!AZURE_SPEECH_KEY || !AZURE_REGION) return reject("Faltan llaves de Azure");

    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16khz32kBitrateMonoMp3;

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    synthesizer.speakTextAsync(texto, result => {
      if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
        fs.writeFileSync("voz.mp3", Buffer.from(result.audioData));
        synthesizer.close();
        resolve();
      } else {
        synthesizer.close();
        reject("Error Azure: " + result.errorDetails);
      }
    }, err => {
      synthesizer.close();
      reject(err);
    });
  });
}

// ================= 3. MEZCLA DE AUDIO (FFMPEG) =================
function mezclarAudio() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync("fondo.mp3")) {
      console.warn("⚠️ No se encontró fondo.mp3, se usará solo la voz.");
      // Si no hay fondo, copiamos la voz directamente a salida
      fs.copyFileSync("voz.mp3", "salida.mp3");
      return resolve();
    }

    // Comando profesional de Ducking (la música baja cuando entra la voz)
    const comando = `ffmpeg -y -i fondo.mp3 -i voz.mp3 -filter_complex "[0:a]volume=0.4[bg];[1:a]volume=1.3[v];[bg][v]sidechaincompress=threshold=0.1:ratio=20:attack=100:release=1000[out]" -map "[out]" -c:a libmp3lame -b:a 128k salida.mp3`;

    exec(comando, (err) => {
      if (err) reject("Error FFmpeg: " + err);
      else resolve();
    });
  });
}

// ================= 4. SUBIDA A AZURACAST =================
async function subirAzura() {
  try {
    const file = fs.createReadStream("salida.mp3");
    const form = new FormData();
    
    // CAMBIO CLAVE: Subir a la raíz para evitar el error 403 de carpeta inexistente
    form.append("path", "dj_auto.mp3"); 
    form.append("file", file);

    console.log("📤 Intentando subir a:", AZURA_API);

    await axios.post(AZURA_API, form, {
      headers: { 
        ...form.getHeaders(), 
        "X-API-Key": AZURA_KEY 
      }
    });
    console.log("✅ Audio subido con éxito a la raíz de AzuraCast");
  } catch (err) {
    // Si falla, nos dará el detalle exacto del porqué
    console.error("❌ Detalle del error 403/404:", err.response?.data || err.message);
    throw new Error("Error subida: " + err.message);
  }
}

// ================= SERVIDOR Y RUTAS =================
app.get("/", (req, res) => res.send("🎧 DJ IA Activo y funcionando en Koyeb"));

// Endpoint para disparar el DJ manualmente desde el frontend
app.get("/trigger-dj", async (req, res) => {
  await DJ();
  res.send("Proceso iniciado manualmente");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  // Primera ejecución a los 5 segundos
  setTimeout(DJ, 5000);
  // Repetir cada 15 minutos
  setInterval(DJ, 15 * 60 * 1000);
});
