  
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const { exec } = require("child_process");
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

// ================= VOZ =================

async function generarVoz(texto) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    synthesizer.speakTextAsync(
      texto,
      (result) => {
        fs.writeFileSync("voz.mp3", Buffer.from(result.audioData));
        synthesizer.close();
        resolve();
      },
      (err) => reject(err)
    );
  });
}

// ================= AUDIO =================

async function descargarMusica() {
  const response = await axios({
    url: "https://az.azurafree.eu/listen/la_fronterisima/radio.mp3",
    method: "GET",
    responseType: "stream"
  });

  const writer = fs.createWriteStream("musica.mp3");
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

// 🎚 Mezcla tipo radio real
function mezclarAudio() {
  return new Promise((resolve, reject) => {
    exec(`"${ffmpegPath}" -y \
-i musica.mp3 -t 15 \
-i voz.mp3 \
-filter_complex "[1:a]volume=3[a1];[0:a][a1]sidechaincompress=threshold=0.02:ratio=12[out]" \
-map "[out]" \
-c:a libmp3lame salida.mp3`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ================= STREAM EN VIVO =================

function transmitirEnVivo() {
  return new Promise((resolve, reject) => {

    const url = `icecast://source:${ICECAST_PASSWORD}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;

    console.log("📡 Enviando a:", url);

    exec(`"${ffmpegPath}" -re \
-i salida.mp3 \
-c:a libmp3lame -b:a 128k \
-f mp3 "${url}"`, (err) => {
      if (err) reject(err);
      else resolve();
    });

  });
}

// ================= DJ =================

async function DJAutomatico() {
  try {
    console.log("🎙 Generando locución...");

    const guion = await crearGuion();

    await generarVoz(guion);
    await descargarMusica();
    await mezclarAudio();

    // 🔥 ENVÍA DIRECTO AL STREAM
    await transmitirEnVivo();

    console.log("🚀 EN VIVO COMPLETADO");

  } catch (err) {
    console.error("❌ Error:", err);
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

app.listen(PORT, () => {
  console.log("🚀 Servidor en puerto " + PORT);
});
