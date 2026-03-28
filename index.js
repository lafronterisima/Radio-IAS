
// index.js – IA DJ Web Service listo para Render 🚀

const express = require("express");
const path = require("path");
const axios = require("axios");
const { textToSpeech } = require("./utils/azureTTS");
const { mixAudio } = require("./utils/audioMixer");
const { uploadToAzura } = require("./utils/azuraCastAPI");
const { AZURA_API_URL, AZURA_API_KEY, STATION_ID } = require("./config");

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de OpenWeather
const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY; // tu API Key
const CITY = process.env.CITY || "Bogota";

async function getWeather() {
  try {
    const res = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${CITY}&units=metric&appid=${OPENWEATHER_KEY}`
    );
    const temp = Math.round(res.data.main.temp);
    const description = res.data.weather[0].description;
    return `${temp} grados con ${description}`;
  } catch (err) {
    console.error("Error al obtener clima:", err);
    return "clima no disponible";
  }
}

async function getCurrentSong() {
  try {
    const res = await axios.get(`${AZURA_API_URL}/stations/${STATION_ID}/nowplaying`, {
      headers: { Authorization: `Bearer ${AZURA_API_KEY}` }
    });
    const song = res.data?.now_playing?.song?.title || "canción desconocida";
    const artist = res.data?.now_playing?.song?.artist || "";
    return artist ? `${song} de ${artist}` : song;
  } catch (err) {
    console.error("Error al obtener canción:", err);
    return "canción desconocida";
  }
}

// Función principal de locución
async function generateAndUploadLocution() {
  try {
    const now = new Date();
    const weather = await getWeather();
    const song = await getCurrentSong();
    const text = `Hola, son las ${now.getHours()}:${now.getMinutes()} en ${CITY}. El clima es ${weather}. Ahora suena ${song}.`;

    console.log("Texto a locutar:", text);

    // Archivos de audio
    const voiceFile = path.join(__dirname, "voice.mp3");
    const musicFile = path.join(__dirname, "music/currentTrack.mp3");
    const outputFile = path.join(__dirname, "final.mp3");

    // Generar voz y mezclar
    await textToSpeech(text, voiceFile);
    await mixAudio(musicFile, voiceFile, outputFile);

    // Subir a AzuraCast
    await uploadToAzura(outputFile);

    console.log("Locución subida correctamente ✅");
  } catch (err) {
    console.error("Error en IA DJ:", err);
  }
}

// Endpoint raíz amigable
app.get("/", (req, res) => {
  res.send("IA DJ Web Service funcionando ✅ Usa /run-dj para generar locución");
});

// Endpoint manual para generar locución
app.get("/run-dj", async (req, res) => {
  try {
    await generateAndUploadLocution();
    res.send("Locución subida correctamente ✅");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error en IA DJ ❌");
  }
});

// Iniciar web server
app.listen(PORT, () => console.log(`IA DJ Web Service corriendo en puerto ${PORT}`));

// 🔹 Loop interno cada 10 minutos
generateAndUploadLocution(); // primera ejecución al iniciar
setInterval(generateAndUploadLocution, 10 * 60 * 1000); // cada 10 min