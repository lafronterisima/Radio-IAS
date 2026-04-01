const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const Parser = require("rss-parser");

const app = express();
const parser = new Parser();

// ================= CONFIG =================
const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;

const ICECAST_HOST = process.env.ICECAST_HOST;
const ICECAST_PORT = process.env.ICECAST_PORT;
const ICECAST_PASSWORD = process.env.ICECAST_PASSWORD;
const ICECAST_MOUNT = process.env.ICECAST_MOUNT;

const STATION_ID = 24; // ⚠️ cambia si es necesario
const LOCUCION_INTERVAL = 15 * 60 * 1000;

// ================= UTIL =================
function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

// ================= GUION =================
async function crearGuion() {
  try {
    let artista = "varios artistas";
    let cancion = "la mejor música";
    let temp = "desconocido";
    let noticias = "sin novedades por ahora";

    // 🎵 Canción actual
    try {
      const songRes = await axios.get(`https://az.azurafree.eu/api/nowplaying/${STATION_ID}`);
      artista = songRes.data.now_playing.song.artist;
      cancion = songRes.data.now_playing.song.title;
    } catch {}

    // 🌡️ Clima
    try {
      const weatherRes = await axios.get(
        "https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true"
      );
      temp = Math.round(weatherRes.data.current_weather.temperature);
    } catch {}

    // 📰 Noticias
    try {
      const feed = await parser.parseURL("https://feeds.bbci.co.uk/mundo/rss.xml");
      noticias = feed.items.slice(0, 2).map(i => i.title).join(". ");
    } catch {}

    return `Hola, muy buenas. Son las ${getHora()} en Colombia. 
El clima en Cali es de ${temp} grados. 
Estás escuchando ${cancion} de ${artista}. 
En noticias: ${noticias}. 
Sigue en La Fronterísima con más música.`;

  } catch (err) {
    console.error("Error guion:", err);
    return `Hola, son las ${getHora()}. Estás en La Fronterísima.`;
  }
}

// ================= VOZ =================
async function generarVoz(texto) {
  const file = `voz_${Date.now()}.mp3`;

  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    const ssml = `
    <speak version="1.0" xml:lang="es-CO">
      <voice name="es-CO-SalomeNeural">
        <prosody rate="0%" pitch="+2%">
          ${texto}
        </prosody>
      </voice>
    </speak>`;

    synthesizer.speakSsmlAsync(ssml,
      result => {
        fs.writeFileSync(file, Buffer.from(result.audioData));
        synthesizer.close();
        resolve(file);
      },
      err => {
        synthesizer.close();
        reject(err);
      }
    );
  });
}

// ================= STREAM CONTINUO =================
function iniciarStreamContinuo() {
  const icecastUrl = `icecast://source:${ICECAST_PASSWORD}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;
  const musicaUrl = "https://az.azurafree.eu/listen/la_fronterisima/radio.mp3";

  const ff = spawn(ffmpegPath, [
    "-re",
    "-i", musicaUrl,
    "-vn",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-f", "mp3",
    icecastUrl
  ]);

  ff.stderr.on("data", d => console.log("[MÚSICA]", d.toString()));

  ff.on("close", () => {
    console.log("⚠️ Stream caído, reiniciando...");
    setTimeout(() => iniciarStreamContinuo(), 3000);
  });

  return ff;
}

// ================= ENVIAR AUDIO =================
function enviarAudioAlAire(filePath) {
  return new Promise((resolve, reject) => {
    const icecastUrl = `icecast://source:${ICECAST_PASSWORD}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;

    const ff = spawn(ffmpegPath, [
      "-re",
      "-i", filePath,
      "-vn",
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      "-f", "mp3",
      icecastUrl
    ]);

    ff.stderr.on("data", d => console.log("[LOCUCIÓN]", d.toString()));

    ff.on("close", () => {
      console.log("🎙️ Locución al aire OK");
      resolve();
    });

    ff.on("error", reject);
  });
}

// ================= DJ AUTOMÁTICO =================
let stream;

async function lanzarLocucion() {
  try {
    console.log("\n🎙️ Iniciando locución...");

    // detener música
    if (stream) {
      stream.kill("SIGINT");
      console.log("⏸️ Música pausada");
    }

    const guion = await crearGuion();
    console.log("📝", guion);

    const voz = await generarVoz(guion);

    await enviarAudioAlAire(voz);

    fs.unlinkSync(voz);

    console.log("▶️ Regresando música...");
    stream = iniciarStreamContinuo();

  } catch (err) {
    console.error("❌ Error DJ:", err);
  }
}

// ================= INICIO =================
stream = iniciarStreamContinuo();

// primera locución
setTimeout(lanzarLocucion, 10000);

// cada 15 min
setInterval(lanzarLocucion, LOCUCION_INTERVAL);

// ================= SERVER =================
app.get("/", (req, res) => {
  res.send("🎧 DJ IA Radio 24/7 ACTIVO");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
