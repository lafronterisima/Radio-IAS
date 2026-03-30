 
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// 馃敼 Configuraci贸n AzuraCast
const AZURA_API = "https://az.azurafree.eu/api/station/24/files";
const AZURA_KEY = "dd608c7b0c3e41ad:091b0407a742cefb20e5095a57b7e8d8";

// 馃敼 Funci贸n para obtener hora
function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 馃敼 Crear guion de voz
async function crearGuion() {
  try {
    const [songRes, weatherRes, newsRes] = await Promise.all([
      axios.get("https://az.azurafree.eu/api/nowplaying/la_fronterisima"),
      axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true"),
      axios.get("https://feeds.bbci.co.uk/mundo/rss.xml")
    ]);

    const song = songRes.data.now_playing.song;
    const clima = weatherRes.data.current_weather.temperature + "掳C";

    const noticias = [...newsRes.data.matchAll(/<title>(.*?)<\/title>/g)]
      .slice(1, 4) // primeras 3 noticias
      .map(m => m[1])
      .join(". ");

    return `Hola, son las ${getHora()} en Colombia.
El clima en Cali es ${clima}.
Est谩s escuchando ${song.artist} - ${song.title}.
Noticias: ${noticias}`;
  } catch {
    return "Est谩s escuchando La Fronter铆sima Radio";
  }
}

// 馃敼 Generar voz IA con Azure
async function generarVoz(texto) {
  const speechConfig = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_KEY,
    process.env.AZURE_REGION
  );
  speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";

  const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
  return new Promise((resolve, reject) => {
    synthesizer.speakTextAsync(
      texto,
      (result) => {
        fs.writeFileSync("voz.mp3", Buffer.from(result.audioData));
        resolve();
      },
      (err) => reject(err)
    );
  });
}

// 馃敼 Mezclar voz + m煤sica (ducking)
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

// 馃敼 Subir mp3 final a AzuraCast
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

  console.log("馃帶 Audio subido a AzuraCast");
}

// 馃敼 Funci贸n principal DJ
async function DJAutomatico() {
  try {
    console.log("馃帣 Generando locuci贸n...");
    const guion = await crearGuion();
    await generarVoz(guion);
    await mezclarAudio();
    await subirAzura();
    console.log("鉁� DJ emitido correctamente");
  } catch (err) {
    console.error("鉂� Error DJ:", err);
  }
}

// Ejecutar DJ al iniciar y cada 15 min
DJAutomatico();
setInterval(DJAutomatico, 15 * 60 * 1000);

// 馃敼 Rutas backend (opcional para frontend)
app.get("/song", async (req, res) => {
  try {
    const response = await axios.get("https://az.azurafree.eu/api/nowplaying/la_fronterisima");
    res.json(response.data);
  } catch {
    res.status(500).json({ error: "Error canci贸n" });
  }
});

app.get("/weather", async (req, res) => {
  try {
    const response = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
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

// 馃敼 Servidor Express
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("馃殌 Backend IA Radio activo en puerto " + PORT);
});
