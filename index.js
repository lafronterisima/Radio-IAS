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
const ffmpegPath = require("ffmpeg-static");

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
// CONFIG
// =======================
const AZURA_API = process.env.AZURA_API;
const AZURA_KEY = process.env.AZURA_KEY;
const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const LIVE_URL = process.env.LIVE_URL; // URL de streaming en vivo de AzuraCast
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// =======================
// RUTAS
// =======================

app.get("/song", async (req, res) => {
  try {
    const response = await axios.get(`${AZURA_API.replace("/files","")}/nowplaying/la_fronterisima`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: "Error obteniendo canción" });
  }
});

app.get("/weather", async (req, res) => {
  try {
    const response = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: "Error clima" });
  }
});

app.get("/news", async (req, res) => {
  try {
    const response = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml");
    res.send(response.data);
  } catch (err) {
    res.status(500).send("Error noticias");
  }
});

// Voz IA
app.get("/voz", async (req,res)=>{
  const texto = req.query.texto;
  if(!texto) return res.status(400).send("Texto requerido");

  try {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    synthesizer.speakTextAsync(
      texto,
      result => {
        res.setHeader("Content-Type","audio/mpeg");
        res.send(Buffer.from(result.audioData));
      },
      err => res.status(500).send("Error voz")
    );

  } catch(err){
    res.status(500).send("Error servidor voz");
  }
});

// =======================
// DJ AUTOMÁTICO STREAM
// =======================

function getHora(){
  return new Date().toLocaleTimeString("es-CO",{timeZone:"America/Bogota",hour:"2-digit",minute:"2-digit"});
}

async function crearGuion(){
  try{
    const [songRes, weatherRes, newsRes] = await Promise.all([
      axios.get(`${AZURA_API.replace("/files","")}/nowplaying/la_fronterisima`),
      axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true"),
      axios.get("https://feeds.bbci.co.uk/mundo/rss.xml")
    ]);

    const song = songRes.data.now_playing.song;
    const clima = weatherRes.data.current_weather.temperature+"°C";
    const noticias = [...newsRes.data.matchAll(/<title>(.*?)<\/title>/g)].slice(1,3).map(m=>m[1]).join(". ");

    return `Hola, son las ${getHora()} en Colombia. El clima en Cali es ${clima}. Estás escuchando ${song.artist} - ${song.title}. Noticias: ${noticias}`;

  }catch{
    return "Estás escuchando La Fronterísima Radio";
  }
}

// Generar voz
async function generarVoz(texto){
  const response = await axios.get(`${BASE_URL}/voz?texto=${encodeURIComponent(texto)}`, { responseType:"arraybuffer" });
  fs.writeFileSync("voz.mp3", response.data);
  console.log("Voz generada: voz.mp3");
}

// Mezclar con stream en vivo y subir
async function mezclarYSubir(){
  // FFmpeg toma la URL en vivo + locución
  return new Promise((resolve,reject)=>{
    exec(`"${ffmpegPath}" -y -i "${LIVE_URL}" -i voz.mp3 -filter_complex "[0:a][1:a]sidechaincompress=threshold=0.03:ratio=10[out]" -map "[out]" -c:a libmp3lame salida.mp3`,
      (err)=>{
        if(err) reject(err);
        else resolve();
      });
  });
}

// Subir a AzuraCast
async function subirAzura(){
  const file = fs.readFileSync("salida.mp3");
  const form = new FormData();
  form.append("path","dj/dj_auto.mp3");
  form.append("file",file,"dj_auto.mp3");

  await axios.post(AZURA_API,form,{headers:{...form.getHeaders(),"X-API-Key":AZURA_KEY}});
  console.log("✅ Audio subido a AzuraCast");
}

// DJ completo
async function DJAutomatico(){
  try{
    console.log("🎙 Generando locución...");
    const texto = await crearGuion();
    await generarVoz(texto);
    await mezclarYSubir();
    await subirAzura();
    console.log("✅ DJ emitido correctamente");
  }catch(err){
    console.error("❌ Error DJ:",err);
  }
}

// Ejecutar cada 15 min
setInterval(DJAutomatico,15*60*1000);
// Ejecutar al iniciar
DJAutomatico();

// =======================
// SERVIDOR
// =======================
app.listen(PORT,()=>console.log(`🚀 Backend IA Radio activo en puerto ${PORT}`));
