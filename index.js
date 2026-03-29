// index.js – IA DJ Web Service con noticias Euronews 🚀
require("dotenv").config();

const express = require("express");
const path = require("path");
const axios = require("axios");
const Parser = require("rss-parser");
const parser = new Parser();

const { textToSpeech } = require("./utils/azureTTS");
const { mixAudio } = require("./utils/audioMixer");
const { uploadToAzura } = require("./utils/azuraCastAPI");
const { AZURA_API_URL, AZURA_API_KEY, STATION_ID } = require("./config");

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración
const CITY = process.env.CITY || "Bogota";
const OPENWEATHER_KEY = process.env.OPENWEATHER_API_KEY || null;
const AZURE_KEY = process.env.AZURE_KEY || null;
const AZURE_REGION = process.env.AZURE_REGION || null;

// -------------------- Funciones auxiliares --------------------

// Clima
async function getWeather() {
  if (!OPENWEATHER_KEY) return "clima no disponible";

  try {
    const res = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${CITY}&units=metric&appid=${OPENWEATHER_KEY}`
    );
    const temp = Math.round(res.data.main.temp);
    const description = res.data.weather[0].description;
    return `${temp}°C con ${description}`;
  } catch (err) {
    console.warn("⚠️ Error al obtener clima:", err.response?.data?.message || err.message);
    return "clima no disponible";
  }
}

// Canción actual
async function getCurrentSong() {
  if (!AZURA_API_URL || !AZURA_API_KEY || !STATION_ID) return "canción desconocida";

  try {
    const res = await axios.get(`${AZURA_API_URL}/stations/${STATION_ID}/nowplaying`, {
      headers: { Authorization: `Bearer ${AZURA_API_KEY}` }
    });
    const song = res.data?.now_playing?.song?.title || "canción desconocida";
    const artist = res.data?.now_playing?.song?.artist || "";
    return artist ? `${song} de ${artist}` : song;
  } catch (err) {
    console.warn("⚠️ Error al obtener canción:", err.response?.data?.message || err.message);
    return "canción desconocida";
  }
}

// Noticias Euronews RSS (Just In)
async function getNews() {
  try {
    const feed = await parser.parseURL('https://www.euronews.com/rss?level=theme&name=just-in');
    const headlines = feed.items.slice(0, 3).map(item => item.title);
    return headlines.length ? headlines : ["No hay noticias disponibles"];
  } catch (err) {
    console.warn("⚠️ Error al obtener noticias de Euronews:", err.message);
    return ["No hay noticias disponibles"];
  }
}

// -------------------- Función principal de locución --------------------
async function generateAndUploadLocution() {
  try {
    const now = new Date();
    const weather = await getWeather();
    const song = await getCurrentSong();
    const newsHeadlines = await getNews();
    const newsText = newsHeadlines.join(". ");

    const text = `Hola, son las ${now.getHours()}:${now.getMinutes()} en ${CITY}. El clima es ${weather}. Ahora suena ${song}. Noticias destacadas: ${newsText}.`;
    console.log("🗣 Texto a locutar:", text);

    const voiceFile = path.join(__dirname, "voice.mp3");
    const musicFile = path.join(__dirname, "music/currentTrack.mp3");
    const outputFile = path.join(__dirname, "final.mp3");

    if (!AZURE_KEY || !AZURE_REGION) {
      console.warn("⚠️ Azure TTS no configurado. Se omite locución");
      return;
    }

    await textToSpeech(text, voiceFile);
    console.log("✅ Locución generada con Azure TTS");

    await mixAudio(musicFile, voiceFile, outputFile);
    console.log("✅ Mezcla de audio completada");

    if (AZURA_API_URL && AZURA_API_KEY) {
      await uploadToAzura(outputFile);
      console.log("✅ Locución subida a AzuraCast");
    } else {
      console.log("ℹ️ AzuraCast no configurado. Locución solo local");
    }
  } catch (err) {
    console.error("❌ Error al generar locución:", err.message || err);
  }
}

// -------------------- Servidor web --------------------
app.get("/", (req, res) => {
  res.send("IA DJ Web Service funcionando ✅ Usa /run-dj para generar locución");
});

app.get("/run-dj", async (req, res) => {
  try {
    await generateAndUploadLocution();
    res.send("Locución ejecutada ✅");
  } catch (err) {
    console.error("❌ Error en /run-dj:", err.message || err);
    res.status(500).send("Error en IA DJ ❌");
  }
});

// -------------------- Iniciar servidor y loop --------------------
app.listen(PORT, () =>
  console.log(`🚀 IA DJ Web Service corriendo en puerto ${PORT}`)
);

(async () => {
  await generateAndUploadLocution(); // primera ejecución
  setInterval(generateAndUploadLocution, 10 * 60 * 1000); // cada 10 min
})();