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

// ======= CONFIGURACIÓN ESTACIÓN 24 =======
const AZURA_KEY = (process.env.AZURA_KEY || "").trim();
const AZURE_SPEECH_KEY = (process.env.AZURE_SPEECH_KEY || "").trim();
const AZURE_REGION = (process.env.AZURE_REGION || "").trim();

// URL con la llave integrada para evitar errores de cabecera (403 NotLoggedIn)
const AZURA_API = `https://az.azurafree.eu/api/station/24/files?api-key=${AZURA_KEY}`;

// 1. UTILIDADES
function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

// 2. FUNCIONES DE PROCESAMIENTO
async function crearGuion() {
  try {
    const songRes = await axios.get("https://az.azurafree.eu/api/nowplaying/24");
    const artista = songRes.data.now_playing?.song?.artist || "varios artistas";
    const cancion = songRes.data.now_playing?.song?.title || "la mejor música";
    
    const weatherRes = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
    const temp = Math.round(weatherRes.data.current_weather.temperature);
    
    const feed = await parser.parseURL('https://feeds.bbci.co.uk/mundo/rss.xml');
    const noticias = feed.items.slice(0, 2).map(i => i.title).join(". ");

    return `Hola, son las ${getHora()} en Colombia. El clima en Cali es de ${temp} grados. Estás escuchando a ${artista} con el éxito ${cancion}. En noticias: ${noticias}. Sigue con más música en La Fronterísima.`;
  } catch (e) {
    console.error("⚠️ Error en guion:", e.message);
    return `Hola, son las ${getHora()}. Estás en sintonía de La Fronterísima, acompañándote con la mejor música siempre.`;
  }
}

async function generarVoz(texto) {
  return new Promise((resolve, reject) => {
    if (!AZURE_SPEECH_KEY || !AZURE_REGION) return reject("Faltan llaves de Azure");

    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";
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

function mezclarAudio() {
  return new Promise((resolve, reject) => {
    // Si no tienes fondo.mp3, solo convertimos la voz a formato final
    const comando = fs.existsSync("fondo.mp3") 
      ? `ffmpeg -y -i fondo.mp3 -i voz.mp3 -filter_complex "[0:a]volume=0.4[bg];[1:a]volume=1.3[v];[bg][v]sidechaincompress=threshold=0.1:ratio=20:attack=100:release=1000[out]" -map "[out]" -c:a libmp3lame -b:a 128k salida.mp3`
      : `ffmpeg -y -i voz.mp3 -c:a libmp3lame -b:a 128k salida.mp3`;

    exec(comando, (err) => {
      if (err) reject("Error FFmpeg: " + err);
      else resolve();
    });
  });
}

// Cambia la URL para que sea limpia
const AZURA_API = `https://az.azurafree.eu/api/station/42/files`;

async function subirAzura() {
  if (!fs.existsSync("salida.mp3")) return;

  const form = new FormData();
  form.append("file", fs.createReadStream("salida.mp3"));
  form.append("path", "dj_auto.mp3");

  try {
    console.log("🔑 Enviando con X-API-Key en headers...");
    
    await axios.post(AZURA_API, form, {
      headers: {
        ...form.getHeaders(),
        // Esta es la forma estándar y más segura de autenticar en AzuraCast
        "X-API-Key": AZURA_KEY, 
        "User-Agent": "Mozilla/5.0"
      }
    });

    console.log("✅ ¡Logrado! Archivo subido correctamente.");
  } catch (err) {
    console.error("❌ Error de subida.");
    if (err.response && err.response.status === 403) {
      console.log("Error 403: Revisa que el Token tenga permisos de 'Manage Station Media'.");
    }
    console.log("Detalle:", err.response?.data || err.message);
  }
}

// 3. FUNCIÓN MAESTRA DJ
async function DJ() {
  console.log(`\n🎙️ [${new Date().toISOString()}] Iniciando locución...`);
  try {
    const guion = await crearGuion();
    console.log("📝 Guion:", guion);

    await generarVoz(guion);
    console.log("🔊 Voz generada.");

    await mezclarAudio();
    console.log("🎚️ Mezcla finalizada.");

    await subirAzura();
  } catch (error) {
    console.error("⚠️ Fallo en el proceso DJ:", error.message || error);
  }
}

// 4. SERVIDOR EXPRESS
app.get("/", (req, res) => res.send("🎧 DJ IA Fronterísima Estación 24 - Activo"));

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  
  // Ejecutar el DJ por primera vez a los 5 segundos
  setTimeout(DJ, 5000);
  
  // Repetir cada 15 minutos
  setInterval(DJ, 15 * 60 * 1000);
});
