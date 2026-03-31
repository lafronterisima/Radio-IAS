const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();

// ================= CONFIG =================
const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;

const ICECAST_HOST = process.env.ICECAST_HOST;
const ICECAST_PORT = process.env.ICECAST_PORT;
const ICECAST_PASSWORD = process.env.ICECAST_PASSWORD;
const ICECAST_MOUNT = process.env.ICECAST_MOUNT;

// Intervalo de locuciones y jingles en minutos
const LOCUCION_INTERVAL = 15;
const JINGLE_INTERVAL = 30;

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

// ================= RADIO 24/7 PROFESIONAL =================
function iniciarRadio() {
  const icecastUrl = `icecast://source:${ICECAST_PASSWORD}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;

  console.log("📡 Iniciando radio profesional 24/7...");

  const ffmpegArgs = [
    "-re",
    "-i", "https://az.azurafree.eu/listen/la_fronterisima/radio.mp3", // música continua
    "-f", "mp3",
    "-i", "pipe:0", // locuciones/jingles desde stdin
    "-filter_complex", "[1:a]volume=3[a1];[0:a][a1]sidechaincompress=threshold=0.02:ratio=12[out]",
    "-map", "[out]",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-f", "mp3",
    icecastUrl
  ];

  const ffmpeg = spawn(ffmpegPath, ffmpegArgs);

  ffmpeg.stderr.on("data", data => console.log("FFmpeg:", data.toString()));

  // ================= LOCUCIONES DINÁMICAS =================
  async function locucionPeriodica() {
    try {
      const guion = await crearGuion();
      const vozBuffer = await generarVozBuffer(guion);
      console.log("🎙 Enviando locución dinámica...");
      ffmpeg.stdin.write(vozBuffer);
    } catch (err) {
      console.error("❌ Error locución:", err.message);
    } finally {
      setTimeout(locucionPeriodica, LOCUCION_INTERVAL * 60 * 1000);
    }
  }

  // ================= JINGLES AUTOMÁTICOS =================
  async function jinglePeriodico() {
    try {
      // Aquí puedes usar un buffer de jingle local
      const jingleBuffer = require("fs").readFileSync("jingle.mp3");
      console.log("🎶 Enviando jingle...");
      ffmpeg.stdin.write(jingleBuffer);
    } catch (err) {
      console.error("❌ Error jingle:", err.message);
    } finally {
      setTimeout(jinglePeriodico, JINGLE_INTERVAL * 60 * 1000);
    }
  }

  setTimeout(locucionPeriodica, LOCUCION_INTERVAL * 60 * 1000);
  setTimeout(jinglePeriodico, JINGLE_INTERVAL * 60 * 1000);

  ffmpeg.on("close", code => {
    console.log(`🎧 FFmpeg cerró con código ${code}. Reiniciando radio...`);
    iniciarRadio(); // Reinicia automáticamente si falla
  });
}

// ▶ Iniciar radio profesional
iniciarRadio();

// ================= API FRONTEND =================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

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
  res.send("🎧 Radio IA 24/7 PROFESIONAL EN VIVO");
});

// ================= SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor escuchando en puerto ${PORT}`));
