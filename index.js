const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();

// ================= CONFIG =================
const AZURA_API = process.env.AZURA_API;
const AZURA_KEY = process.env.AZURA_KEY;

// ================= CORS =================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// ================= HORA =================
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
    const clima = weatherRes.data.current_weather.temperature + " grados";

    const noticias = [...newsRes.data.matchAll(/<title>(.*?)<\/title>/g)]
      .slice(1, 4)
      .map(m => m[1])
      .join(". ");

    return `Hola, son las ${getHora()} en Colombia. 
El clima es ${clima}. 
Estás escuchando ${song.artist} - ${song.title}. 
Noticias: ${noticias}`;
  } catch (err) {
    console.error("Error guion:", err);
    return "Estás escuchando La Fronterísima Radio";
  }
}

// ================= VOZ =================
async function generarVoz(texto) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_KEY,
      process.env.AZURE_REGION
    );

    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    synthesizer.speakTextAsync(
      texto,
      result => {
        fs.writeFileSync("voz.mp3", Buffer.from(result.audioData));
        resolve();
      },
      err => reject(err)
    );
  });
}

// ================= MEZCLA =================
function mezclarAudio() {
  return new Promise((resolve, reject) => {
    exec(`"${ffmpegPath}" -y \
-i musica.mp3 \
-i voz.mp3 \
-filter_complex "[0:a][1:a]sidechaincompress=threshold=0.03:ratio=10[out]" \
-map "[out]" \
-c:a libmp3lame salida.mp3`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ================= SUBIR AZURA =================
async function subirAzura() {
  const file = fs.readFileSync("salida.mp3");

  const form = new FormData();
  form.append("path", "dj/dj_auto.mp3");
  form.append("file", file, "dj_auto.mp3");

  await axios.post(AZURA_API, form, {
    headers: {
      ...form.getHeaders(),
      "X-API-Key": AZURA_KEY
    }
  });

  console.log("🎧 Subido a AzuraCast");
}

// ================= DJ =================
async function DJ() {
  try {
    console.log("🎙 Generando locución...");

    const texto = await crearGuion();
    await generarVoz(texto);
    await mezclarAudio();
    await subirAzura();

    console.log("✅ DJ emitido");
  } catch (err) {
    console.error("❌ Error DJ:", err);
  }
}

// Ejecutar cada 15 minutos
DJ();
setInterval(DJ, 15 * 60 * 1000);

// ================= RUTAS FRONTEND =================

// 🎵 CANCIÓN
app.get("/song", async (req, res) => {
  try {
    const r = await axios.get("https://az.azurafree.eu/api/nowplaying/la_fronterisima");
    res.json(r.data);
  } catch {
    res.status(500).json({ error: "Error canción" });
  }
});

// 🌤 CLIMA
app.get("/weather", async (req, res) => {
  try {
    const r = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
    res.json(r.data);
  } catch {
    res.status(500).json({ error: "Error clima" });
  }
});

// 📰 NOTICIAS
app.get("/news", async (req, res) => {
  try {
    const r = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml");
    res.send(r.data);
  } catch {
    res.status(500).send("Error noticias");
  }
});

// ================= HOME =================
app.get("/", (req, res) => {
  res.send("🎧 Radio IA Koyeb funcionando");
});

// ================= SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Servidor corriendo en puerto " + PORT);
});
