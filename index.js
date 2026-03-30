 
// =======================
// 馃殌 IMPORTS
// =======================
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");

const app = express();


// =======================
// 馃寪 CORS
// =======================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});


// =======================
// 馃幍 CANCI脫N ACTUAL
// =======================
app.get("/song", async (req, res) => {
  try {
    const response = await axios.get(
      "https://az.azurafree.eu/api/nowplaying/la_fronterisima"
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Error obteniendo canci贸n" });
  }
});


// =======================
// 馃尋 CLIMA
// =======================
app.get("/weather", async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true"
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Error clima" });
  }
});


// =======================
// 馃摪 NOTICIAS
// =======================
app.get("/news", async (req, res) => {
  try {
    const response = await axios.get(
      "https://feeds.bbci.co.uk/mundo/rss.xml"
    );
    res.send(response.data);
  } catch (error) {
    res.status(500).send("Error noticias");
  }
});


// =======================
// 馃攰 VOZ IA (AZURE)
// =======================
app.get("/voz", async (req, res) => {

  const texto = req.query.texto;

  if (!texto) {
    return res.status(400).send("Texto requerido");
  }

  try {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_KEY,
      process.env.AZURE_REGION
    );

    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    synthesizer.speakTextAsync(
      texto,
      result => {
        res.setHeader("Content-Type", "audio/mpeg");
        res.send(Buffer.from(result.audioData));
      },
      err => {
        res.status(500).send("Error voz");
      }
    );

  } catch (error) {
    res.status(500).send("Error servidor voz");
  }
});


// =======================
// 馃 DJ AUTOM脕TICO
// =======================

// 馃攼 CONFIGURA ESTO
const AZURA_API = "https://az.azurafree.eu/api/station/1/files";
const AZURA_KEY = "dd608c7b0c3e41ad:091b0407a742cefb20e5095a57b7e8d8"; 


// 馃晵 HORA
function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit"
  });
}


// 馃 CREAR GUION
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
      .slice(1, 3)
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


// 馃攰 GENERAR VOZ (USA TU MISMO BACKEND)
async function generarVoz(texto) {
  const response = await axios.get(
    "http://localhost:" + PORT + "/voz?texto=" + encodeURIComponent(texto),
    { responseType: "arraybuffer" }
  );

  fs.writeFileSync("voz.mp3", response.data);
}


// 馃帥锔� MEZCLAR AUDIO (DUCKING)
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


// 馃摗 SUBIR A AZURACAST
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


// 馃攣 EJECUTAR DJ
async function DJAutomatico() {
  try {
    console.log("馃帣 Generando locuci贸n...");

    const texto = await crearGuion();

    await generarVoz(texto);
    await mezclarAudio();
    await subirAzura();

    console.log("鉁� DJ emitido correctamente");

  } catch (err) {
    console.error("鉂� Error DJ:", err);
  }
}


// 鈴� CADA 15 MINUTOS
setInterval(DJAutomatico, 15 * 60 * 1000);

// 鈻讹笍 EJECUTAR AL INICIAR
DJAutomatico();


// =======================
// 馃殌 SERVIDOR
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("馃殌 Backend IA Radio activo en puerto " + PORT);
});