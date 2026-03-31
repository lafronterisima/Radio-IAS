const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const { exec } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const path = require("path");

const app = express();

// ================= CONFIG =================
const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;

const ICECAST_HOST = process.env.ICECAST_HOST;
const ICECAST_PORT = process.env.ICECAST_PORT;
const ICECAST_PASSWORD = process.env.ICECAST_PASSWORD;
const ICECAST_MOUNT = process.env.ICECAST_MOUNT;

const LOCUCION_INTERVAL = 15; // minutos
const JINGLE_PATH = path.join(__dirname, "jingle.mp3"); // opcional

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
async function generarVoz(texto, outputPath) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    synthesizer.speakTextAsync(
      texto,
      result => {
        fs.writeFileSync(outputPath, Buffer.from(result.audioData));
        synthesizer.close();
        resolve();
      },
      err => reject(err)
    );
  });
}

// ================= MUSICA =================
async function descargarMusica() {
  const url = "https://az.azurafree.eu/listen/la_fronterisima/radio.mp3";
  const response = await axios({ url, method: "GET", responseType: "stream" });
  const writer = fs.createWriteStream("musica.mp3");
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

// ================= MEZCLA =================
function mezclarAudio(vozPath, outputPath) {
  return new Promise((resolve, reject) => {
    const inputs = `-i musica.mp3 -i ${vozPath}`;
    const jingle = fs.existsSync(JINGLE_PATH) ? `-i ${JINGLE_PATH}` : "";
    const complexFilter = fs.existsSync(JINGLE_PATH)
      ? `[1:a]volume=3[a1];[2:a]volume=3[a2];[0:a][a1][a2]amix=inputs=3:normalize=1[out]`
      : `[1:a]volume=3[a1];[0:a][a1]sidechaincompress=threshold=0.02:ratio=12[out]`;

    const cmd = `"${ffmpegPath}" -y ${inputs} ${jingle} -filter_complex "${complexFilter}" -map "[out]" -c:a libmp3lame ${outputPath}`;
    exec(cmd, (err) => err ? reject(err) : resolve());
  });
}

// ================= STREAM =================
function transmitir(outputPath) {
  return new Promise((resolve, reject) => {
    const url = `icecast://source:${ICECAST_PASSWORD}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;
    const cmd = `"${ffmpegPath}" -re -i ${outputPath} -c:a libmp3lame -b:a 128k -f mp3 "${url}"`;
    const proc = exec(cmd, (err) => err ? reject(err) : resolve());
    proc.stdout?.pipe(process.stdout);
    proc.stderr?.pipe(process.stderr);
  });
}

// ================= DJ AUTOMÁTICO =================
async function DJAutomatico() {
  try {
    console.log("🎙 Generando locución...");
    await descargarMusica();

    const vozPath = "voz.mp3";
    const salida = "salida.mp3";
    const guion = await crearGuion();
    await generarVoz(guion, vozPath);
    await mezclarAudio(vozPath, salida);

    console.log("📡 Transmitiendo...");
    await transmitir(salida);

  } catch (err) {
    console.error("❌ Error:", err);
  }
}

// ▶ Iniciar
DJAutomatico();
setInterval(DJAutomatico, LOCUCION_INTERVAL * 60 * 1000);

// ================= API FRONTEND =================
app.use(express.static(__dirname));
app.use((req, res, next) => { res.header("Access-Control-Allow-Origin", "*"); next(); });

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
app.get("/", (req, res) => res.send("🎧 Radio IA 24/7 PROFESIONAL"));

// ================= SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor escuchando en puerto ${PORT}`));
