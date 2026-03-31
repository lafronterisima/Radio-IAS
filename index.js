const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();

// ✅ CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

// ================= CONFIG =================

const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;

const ICECAST_HOST = process.env.ICECAST_HOST;
const ICECAST_PORT = process.env.ICECAST_PORT;
const ICECAST_PASSWORD = process.env.ICECAST_PASSWORD;
const ICECAST_MOUNT = process.env.ICECAST_MOUNT;

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
    const [songRes, weatherRes, newsRes] = await Promise.all([
      axios.get("https://az.azurafree.eu/api/nowplaying/la_fronterisima"),
      axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true"),
      axios.get("https://feeds.bbci.co.uk/mundo/rss.xml")
    ]);

    const song = songRes.data.now_playing.song;
    const clima = weatherRes.data.current_weather.temperature + "°C";

    const noticias = newsRes.data
      .split("<title>")
      .slice(2, 5)
      .map(t => t.split("</title>")[0])
      .join(". ");

    return `Hola, son las ${getHora()} en Colombia. El clima en Cali es ${clima}. Estás escuchando ${song.artist} - ${song.title}. Noticias: ${noticias}`;
  } catch {
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
        const buffer = Buffer.from(result.audioData);
        synthesizer.close();
        resolve(buffer);
      },
      err => reject(err)
    );
  });
}

// ================= STREAM EN VIVO =================

async function transmitirEnVivo() {
  console.log("🎙 Preparando guion...");
  const guion = await crearGuion();
  const vozBuffer = await generarVozBuffer(guion);

  console.log("📡 Transmitiendo en vivo...");

  const icecastUrl = `icecast://source:${ICECAST_PASSWORD}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;

  // FFmpeg: mezcla música de stream + locución en buffer
  const ffmpeg = spawn(ffmpegPath, [
    "-re",
    "-i", "https://az.azurafree.eu/listen/la_fronterisima/radio.mp3", // música
    "-f", "mp3",
    "-i", "pipe:0", // locución desde stdin
    "-filter_complex", "[1:a]volume=3[a1];[0:a][a1]sidechaincompress=threshold=0.02:ratio=12[out]",
    "-map", "[out]",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-f", "mp3",
    icecastUrl
  ]);

  // Enviar buffer de voz a FFmpeg
  ffmpeg.stdin.write(vozBuffer);
  ffmpeg.stdin.end();

  ffmpeg.stdout.on("data", data => console.log("FFmpeg:", data.toString()));
  ffmpeg.stderr.on("data", data => console.log("FFmpeg err:", data.toString()));

  ffmpeg.on("close", code => console.log(`🎧 Transmisión finalizada (code ${code})`));
}

// ================= DJ AUTOMÁTICO =================

let enEjecucion = false;

async function DJAutomatico() {
  if (enEjecucion) return;
  enEjecucion = true;

  try {
    await transmitirEnVivo();
    console.log("🚀 DJ en vivo completo");
  } catch (err) {
    console.error("❌ Error DJ:", err.message);
  } finally {
    enEjecucion = false;
  }
}

// ▶ iniciar
DJAutomatico();

// ⏱ cada 25 min
setInterval(DJAutomatico, 25 * 60 * 1000);

// ================= API FRONTEND =================

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

app.get("/", (req, res) => {
  res.send("🎧 Radio IA EN VIVO");
});

// ================= SERVER =================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor escuchando en puerto ${PORT}`));
