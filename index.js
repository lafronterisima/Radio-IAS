const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");

const app = express();

const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;

const ICECAST_HOST = process.env.ICECAST_HOST;
const ICECAST_PORT = process.env.ICECAST_PORT;
const ICECAST_PASSWORD = process.env.ICECAST_PASSWORD;
const ICECAST_MOUNT = process.env.ICECAST_MOUNT;

const LOCUCION_INTERVAL = 15; // minutos
const JINGLE_PATH = path.join(__dirname, "jingle.mp3");

// ================= UTIL =================
function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ================= GUION =================
async function crearGuion() {
  try {
    let song = "La Fronterísima Radio", clima = "desconocido", noticias = "No hay noticias";

    try {
      const songRes = await axios.get("https://az.azurafree.eu/api/nowplaying/la_fronterisima");
      const s = songRes.data.now_playing.song;
      song = `${s.artist} - ${s.title}`;
    } catch {}

    try {
      const weatherRes = await axios.get(
        "https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true"
      );
      clima = weatherRes.data.current_weather.temperature + "°C";
    } catch {}

    try {
      const newsRes = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml");
      noticias = newsRes.data
        .split("<title>")
        .slice(2, 5)
        .map(t => t.split("</title>")[0])
        .join(". ");
    } catch {}

    return `Hola, son las ${getHora()} en Colombia. El clima en Cali es ${clima}. Estás escuchando ${song}. Noticias: ${noticias}`;
  } catch (err) {
    console.error("Error creando guion:", err);
    return "Estás escuchando La Fronterísima Radio";
  }
}

// ================= VOZ EN MEMORIA =================
async function generarVozBuffer(texto) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    synthesizer.speakTextAsync(
      texto,
      result => {
        synthesizer.close();
        resolve(Buffer.from(result.audioData));
      },
      err => reject(err)
    );
  });
}

// ================= STREAM EN VIVO =================
function iniciarStreamContinuo() {
  const icecastUrl = `icecast://source:${ICECAST_PASSWORD}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;
  const musicaUrl = "https://az.azurafree.eu/listen/la_fronterisima/radio.mp3";

  // FFmpeg streaming principal
  const ffmpeg = spawn(ffmpegPath, [
    "-re",
    "-i", musicaUrl,
    "-i", "pipe:0", // para locuciones y jingles dinámicos
    "-filter_complex", "[0:a][1:a]amix=inputs=2:dropout_transition=2:weights=1 2[aout]",
    "-map", "[aout]",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-f", "mp3",
    icecastUrl
  ]);

  ffmpeg.stdout.on("data", data => process.stdout.write(`[FFMPEG] ${data}`));
  ffmpeg.stderr.on("data", data => process.stderr.write(`[FFMPEG] ${data}`));
  ffmpeg.on("close", code => console.log(`FFmpeg cerrado con código ${code}`));

  return ffmpeg.stdin; // retorna stdin para enviar audio dinámico
}

// ================= LOCUCIONES DINÁMICAS =================
async function overlayLocucion(ffmpegStdin) {
  try {
    const guion = await crearGuion();
    const vozBuffer = await generarVozBuffer(guion);

    // Enviar buffer directo a FFmpeg stdin
    ffmpegStdin.write(vozBuffer);
    console.log("✅ Locución transmitida en vivo");
  } catch (err) {
    console.error("❌ Error en locución:", err);
  }
}

// ================= DJ AUTOMÁTICO =================
const ffmpegStdin = iniciarStreamContinuo();
overlayLocucion(ffmpegStdin);
setInterval(() => overlayLocucion(ffmpegStdin), LOCUCION_INTERVAL * 60 * 1000);

// ================= API FRONTEND =================
app.use(express.static(__dirname));
app.use((req, res, next) => { res.header("Access-Control-Allow-Origin", "*"); next(); });

app.get("/song", async (req, res) => {
  const r = await axios.get("https://az.azurafree.eu/api/nowplaying/la_fronterisima");
  res.json(r.data);
});
app.get("/weather", async (req, res) => {
  const r = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
  res.json(r.data);
});
app.get("/news", async (req, res) => {
  const r = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml");
  res.send(r.data);
});
app.get("/", (req, res) => res.send("🎧 Radio IA 24/7 PROFESIONAL"));

// ================= SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor escuchando en puerto ${PORT}`));
