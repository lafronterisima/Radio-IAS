
// index.js – IA DJ Web Service completo 🚀

require("dotenv").config();
const express = require("express");
const path = require("path");
const axios = require("axios");
const { textToSpeech } = require("./utils/azureTTS");
const { mixAudio } = require("./utils/audioMixer");
const { uploadToAzura } = require("./utils/azuraCastAPI");
const { getNews } = require("./utils/news");
const { AZURA_API_URL, AZURA_API_KEY, STATION_ID } = require("./config");

const app = express();
const PORT = process.env.PORT || 10000;
const CITY = process.env.CITY || "Bogota";
const OPENWEATHER_KEY = process.env.OPENWEATHER_API_KEY;

// Función para obtener hora actual en Colombia
function getColombiaTime() {
  return new Intl.DateTimeFormat("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Bogota",
  }).format(new Date());
}

// Función para obtener clima
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
    console.error("⚠️ Error al obtener clima:", err.response?.data || err.message);
    return "clima no disponible";
  }
}

// Función para obtener canción actual desde AzuraCast
async function getCurrentSong() {
  if (!AZURA_API_URL || !AZURA_API_KEY || !STATION_ID) return "canción desconocida";

  try {
    const res = await axios.get(`${AZURA_API_URL}/stations/${STATION_ID}/nowplaying`, {
      headers: { Authorization: `Bearer ${AZURA_API_KEY}` },
    });
    const song = res.data?.now_playing?.song?.title || "canción desconocida";
    const artist = res.data?.now_playing?.song?.artist || "";
    return artist ? `${song} de ${artist}` : song;
  } catch (err) {
    console.error("⚠️ Error al obtener canción:", err.response?.data || err.message);
    return "canción desconocida";
  }
}

// Función principal para generar locución
async function generateAndUploadLocution() {
  try {
    const colombiaTime = getColombiaTime();
    const weather = await getWeather();
    const song = await getCurrentSong();
    const news = await getNews(3, 20); // 3 titulares, máximo 12 palabras cada uno

    const text = `Hola, son las ${colombiaTime} en ${CITY}. El clima es ${weather}. Ahora suena ${song}. Noticias destacadas: ${news}.`;

    console.log("🗣 Texto a locutar:", text);

    // Archivos de audio
    const voiceFile = path.join(__dirname, "voice.mp3");
    const musicFile = path.join(__dirname, "music/currentTrack.mp3");
    const outputFile = path.join(__dirname, "final.mp3");

    if (!process.env.AZURE_KEY || !process.env.AZURE_REGION) {
      console.warn("⚠️ Azure TTS no configurado. Se omitirá la locución");
      return;
    }

    // Generar voz y mezclar con música
    await textToSpeech(text, voiceFile);
    await mixAudio(musicFile, voiceFile, outputFile);

    // Subir a AzuraCast si está configurado
    if (AZURA_API_URL && AZURA_API_KEY) {
      await uploadToAzura(outputFile);
      console.log("✅ Locución subida correctamente a AzuraCast");
    } else {
      console.log("✅ Locución generada localmente (AzuraCast no configurado)");
    }
  } catch (err) {
    console.error("⚠️ Error en IA DJ:", err.message || err);
  }
}

// Endpoint raíz
app.get("/", (req, res) => {
  res.send("IA DJ Web Service funcionando ✅ Usa /run-dj para generar locución");
});

// Endpoint manual para generar locución
app.get("/run-dj", async (req, res) => {
  try {
    await generateAndUploadLocution();
    res.send("✅ Locución generada y subida correctamente");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error en IA DJ");
  }
});

// Iniciar servidor
app.listen(PORT, () => console.log(`🚀 IA DJ Web Service corriendo en puerto ${PORT}`));

// Loop automático cada 10 minutos
generateAndUploadLocution(); // primera ejecución
setInterval(generateAndUploadLocution, 10 * 60 * 1000); // cada 10 min