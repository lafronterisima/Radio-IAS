 
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();

// ✅ CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// ================= CONFIG =================

// 🔐 VARIABLES DE ENTORNO (OBLIGATORIO)
const AZURA_API = "https://az.azurafree.eu/api/station/24/files";
const AZURA_KEY = process.env.AZURA_KEY;

const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;

// ================= UTILIDADES =================

// 🕒 Hora Colombia
function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ================= DATOS =================

// 🧠 Crear guion dinámico
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

    return `Hola, son las ${getHora()} en Colombia. 
El clima en Cali es ${clima}. 
Estás escuchando ${song.artist} - ${song.title}. 
Noticias: ${noticias}`;
  } catch (error) {
    console.error("Error creando guion:", error.message);
    return "Estás escuchando La Fronterísima Radio";
  }
}

// ================= VOZ =================

// 🎙 Generar voz con Azure
async function generarVoz(texto) {
  return new Promise((resolve, reject) => {
    try {
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
        (err) => {
          synthesizer.close();
          reject(err);
        }
      );
    } catch (err) {
      reject(err);
    }
  });
}

// ================= AUDIO =================

// 🎵 Descargar música (stream)
async function descargarMusica() {
  const url = "https://az.azurafree.eu/listen/la_fronterisima/radio.mp3";

  const response = await axios({
    url,
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

// 🎚 Mezclar voz + música (ducking PRO)
function mezclarAudio() {
  return new Promise((resolve, reject) => {
    exec(`"${ffmpegPath}" -y \
-i musica.mp3 -t 15 \
-i voz.mp3 \
-filter_complex "[1:a]volume=2.5[a1];[0:a][a1]sidechaincompress=threshold=0.03:ratio=10[out]" \
-map "[out]" \
-c:a libmp3lame salida.mp3`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ================= AZURACAST =================

// ☁️ Subir archivo
async function subirAzura() {
  try {
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

    console.log("🎧 Audio subido a AzuraCast");
  } catch (err) {
    console.error("Error subiendo a Azura:", err.message);
  }
}

// ================= DJ AUTOMÁTICO =================

async function DJAutomatico() {
  try {
    console.log("🎙 Generando locución...");

    const guion = await crearGuion();

    await generarVoz(guion);

    await descargarMusica(); // 🔥 CLAVE

    await mezclarAudio();

    await subirAzura();

    console.log("✅ DJ emitido correctamente");

  } catch (err) {
    console.error("❌ Error DJ:", err);
  }
}

// ▶ Ejecutar al iniciar
DJAutomatico();

// ⏱ Cada 15 minutos
setInterval(DJAutomatico, 15 * 60 * 1000);

// ================= API PARA FRONTEND =================

// 🎵 Canción actual
app.get("/song", async (req, res) => {
  try {
    const response = await axios.get("https://az.azurafree.eu/api/nowplaying/la_fronterisima");
    res.json(response.data);
  } catch {
    res.status(500).json({ error: "Error canción" });
  }
});

// 🌤 Clima
app.get("/weather", async (req, res) => {
  try {
    const response = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
    res.json(response.data);
  } catch {
    res.status(500).json({ error: "Error clima" });
  }
});

// 📰 Noticias
app.get("/news", async (req, res) => {
  try {
    const response = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml");
    res.send(response.data);
  } catch {
    res.status(500).send("Error noticias");
  }
});

// 🟢 Ruta base
app.get("/", (req, res) => {
  res.send("🎧 Radio IA activa");
});

// ================= SERVER =================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Backend IA Radio activo en puerto " + PORT);
});
      
