// =======================
// IMPORTS
// =======================
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");

const app = express();

// =======================
// CORS
// =======================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// =======================
// CONFIG AZURACAST Y AZURE
// =======================
const AZURA_API = process.env.AZURA_API || "https://az.azurafree.eu/api/station/24/files";
const AZURA_KEY = process.env.AZURA_KEY;  // tu API key de AzuraCast
const AZURE_KEY = process.env.AZURE_KEY;  // tu Azure TTS Key
const AZURE_REGION = process.env.AZURE_REGION; // tu región Azure
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

// =======================
// RUTAS: canción, clima, noticias
// =======================
app.get("/song", async (req, res) => {
  try {
    const response = await axios.get("https://az.azurafree.eu/api/nowplaying/24");
    res.json(response.data);
  } catch {
    res.status(500).json({ error: "Error obteniendo canción" });
  }
});

app.get("/weather", async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true"
    );
    res.json(response.data);
  } catch {
    res.status(500).json({ error: "Error clima" });
  }
});

app.get("/news", async (req, res) => {
  try {
    const response = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml");
    res.send(response.data);
  } catch {
    res.status(500).send("Error noticias");
  }
});

// =======================
// VOZ IA (AZURE TTS)
// =======================
app.get("/voz", async (req, res) => {
  const texto = req.query.texto;
  if (!texto) return res.status(400).send("Texto requerido");

  try {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
    synthesizer.speakTextAsync(
      texto,
      result => {
        res.setHeader("Content-Type", "audio/mpeg");
        res.send(Buffer.from(result.audioData));
      },
      err => res.status(500).send("Error voz")
    );

  } catch {
    res.status(500).send("Error servidor voz");
  }
});

// =======================
// DJ AUTOMÁTICO
// =======================

// Hora en Colombia
function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// Crear guion de locución
async function crearGuion() {
  try {
    const [songRes, weatherRes, newsRes] = await Promise.all([
      axios.get("https://az.azurafree.eu/api/nowplaying/24"),
      axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true"),
      axios.get("https://feeds.bbci.co.uk/mundo/rss.xml")
    ]);

    const song = songRes.data.now_playing.song;
    const clima = weatherRes.data.current_weather.temperature + " grados";

    const noticias = [...newsRes.data.matchAll(/<title>(.*?)<\/title>/g)]
      .slice(1, 3)
      .map(m => m[1])
      .join(". ");

    return `Hola, son las ${getHora()} en Colombia.
El clima en Cali es ${clima}.
Estás escuchando ${song.artist} - ${song.title}.
Noticias: ${noticias}`;

  } catch {
    return "Estás escuchando La Fronterísima Radio";
  }
}

// Generar voz TTS
async function generarVoz(texto) {
  try {
    const response = await axios.get(`${BASE_URL}/voz?texto=${encodeURIComponent(texto)}`, {
      responseType: "arraybuffer"
    });
    fs.writeFileSync("voz.mp3", response.data);
    console.log("✅ Voz generada: voz.mp3");
  } catch (err) {
    console.error("❌ Error generando voz:", err.message);
  }
}

// Mezclar audio (ducking)
function mezclarAudio() {
  return new Promise((resolve, reject) => {
    exec(`
      ffmpeg -y \
      -i musica.mp3 \
      -i voz.mp3 \
      -filter_complex "[0:a][1:a]sidechaincompress=threshold=0.03:ratio=10[out]" \
      -map "[out]" \
      -c:a libmp3lame salida.mp3
    `, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Subir audio a AzuraCast
async function subirAzura() {
  const file = fs.readFileSync("salida.mp3");
  const form = new FormData();
  form.append("path", "dj/dj_auto.mp3");
  form.append("file", file, "dj_auto.mp3");

  await axios.post(AZURA_API, form, { headers: { ...form.getHeaders(), "X-API-Key": AZURA_KEY } });
  console.log("✅ Audio subido a AzuraCast");
}

// Ejecutar DJ automático
async function DJAutomatico() {
  try {
    console.log("🎙 Generando locución...");
    const texto = await crearGuion();
    await generarVoz(texto);
    await mezclarAudio();
    await subirAzura();
    console.log("✅ DJ emitido correctamente");
  } catch (err) {
    console.error("❌ Error DJ:", err);
  }
}

// Cada 15 minutos
setInterval(DJAutomatico, 15 * 60 * 1000);
// Ejecutar al iniciar
DJAutomatico();

// =======================
// SERVIDOR EXPRESS
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend IA Radio activo en ${BASE_URL}`);
});
