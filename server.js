 
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

// ======= CONFIGURACIÓN =======
const AZURA_KEY = (process.env.AZURA_KEY || "").trim();
const AZURE_SPEECH_KEY = (process.env.AZURE_SPEECH_KEY || "").trim();
const AZURE_REGION = (process.env.AZURE_REGION || "").trim();
const STATION_ID = "42"; // Tu ID de estación
const AZURA_BASE_URL = `https://az.azurafree.eu/api/station/${STATION_ID}`;

// Memoria temporal para noticias
let noticiasLeidas = [];

// 1. UTILIDADES
function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

function getSaludo() {
  const frases = [
    "¡Qué tal familia! Acompañándolos en La Fronterísima.",
    "Sintonía total a esta hora en todo el país.",
    "Hola qué tal, aquí reportándonos en vivo para ustedes.",
    "¡Suban el volumen! Estamos en la mejor compañía musical."
  ];
  return frases[Math.floor(Math.random() * frases.length)];
}

// 2. FUNCIONES DE PROCESAMIENTO
async function obtenerNoticias() {
  try {
    const feed = await parser.parseURL('https://feeds.bbci.co.uk/mundo/rss.xml');
    const nuevas = feed.items
      .map(i => i.title)
      .filter(t => !noticiasLeidas.includes(t));

    const seleccionadas = nuevas.slice(0, 2);
    // Mantener historial de las últimas 15 noticias
    noticiasLeidas = [...seleccionadas, ...noticiasLeidas].slice(0, 15);
    
    return seleccionadas.length > 0 
      ? `En noticias: ${seleccionadas.join(". ")}.` 
      : "Sigue disfrutando de nuestra programación especial.";
  } catch (e) {
    return "Mantente informado con nosotros minuto a minuto.";
  }
}

async function crearGuion() {
  try {
    const [songRes, weatherRes] = await Promise.all([
      axios.get(`https://az.azurafree.eu/api/nowplaying/${STATION_ID}`),
      axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true")
    ]);

    const artista = songRes.data.now_playing?.song?.artist || "tus artistas favoritos";
    const cancion = songRes.data.now_playing?.song?.title || "grandes éxitos";
    const temp = Math.round(weatherRes.data.current_weather.temperature);
    const noticias = await obtenerNoticias();

    return `${getSaludo()} Son las ${getHora()} en Colombia. La temperatura en Cali es de ${temp} grados. Acabamos de escuchar a ${artista} con el éxito titulado ${cancion}. ${noticias} Quédate con nosotros en La Fronterísima.`;
  } catch (e) {
    console.error("⚠️ Error en guion:", e.message);
    return `Hola, son las ${getHora()}. Estás en sintonía de La Fronterísima, acompañándote con la mejor música siempre.`;
  }
}

async function generarVoz(texto) {
  return new Promise((resolve, reject) => {
    if (!AZURE_SPEECH_KEY || !AZURE_REGION) return reject("Faltan llaves de Azure");

    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_REGION);
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    // Usamos SSML para mejorar la entonación y pausas
    const ssml = `
      <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO">
        <voice name="es-CO-SalomeNeural">
          <prosody rate="medium" pitch="default">
            ${texto}
          </prosody>
          <break time="800ms" />
        </voice>
      </speak>`;

    synthesizer.speakSsmlAsync(ssml, result => {
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
    // Si existe fondo.mp3, hace ducking (baja volumen al fondo mientras suena la voz)
    // El flag -shortest asegura que el audio termine cuando acabe la locución
    const comando = fs.existsSync("fondo.mp3") 
      ? `ffmpeg -y -i fondo.mp3 -i voz.mp3 -filter_complex "[0:a]volume=0.3[bg];[1:a]volume=1.2[v];[bg][v]sidechaincompress=threshold=0.1:ratio=20[out]" -map "[out]" -shortest -c:a libmp3lame -b:a 128k salida.mp3`
      : `ffmpeg -y -i voz.mp3 -c:a libmp3lame -b:a 128k salida.mp3`;

    exec(comando, (err) => {
      if (err) reject("Error FFmpeg: " + err);
      else resolve();
    });
  });
}

async function subirAzura() {
  if (!fs.existsSync("salida.mp3")) return;

  const form = new FormData();
  form.append("file", fs.createReadStream("salida.mp3"));
  form.append("path", "dj_auto.mp3"); // Nombre del archivo en el servidor

  try {
    await axios.post(`${AZURA_BASE_URL}/files`, form, {
      headers: {
        ...form.getHeaders(),
        "X-API-Key": AZURA_KEY
      }
    });
    console.log("✅ Audio subido con éxito a AzuraCast.");
  } catch (err) {
    console.error("❌ Error de subida:", err.response?.data || err.message);
  }
}

// 3. FUNCIÓN MAESTRA DJ
async function DJ() {
  console.log(`\n🎙️ [${new Date().toLocaleTimeString()}] Iniciando locución...`);
  try {
    const guion = await crearGuion();
    console.log("📝 Guion:", guion);

    await generarVoz(guion);
    console.log("🔊 Voz generada.");

    await mezclarAudio();
    console.log("🎚️ Mezcla finalizada.");

    await subirAzura();
  } catch (error) {
    console.error("⚠️ Fallo en el proceso DJ:", error);
  }
}

// 4. SERVIDOR EXPRESS
app.get("/", (req, res) => res.send("🎧 DJ IA Fronterísima - Activo y Operando"));

// Forzar ejecución manual si es necesario
app.get("/trigger", async (req, res) => {
    await DJ();
    res.send("Locución disparada manualmente.");
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  
  // Primera ejecución a los 10 segundos del arranque
  setTimeout(DJ, 10000);
  
  // Ciclo cada 15 minutos
  setInterval(DJ, 15 * 60 * 1000);
});