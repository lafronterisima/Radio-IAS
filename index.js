      const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CORS ====================
app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin","*");
  res.header("Access-Control-Allow-Headers","*");
  next();
});

// ==================== FRONTEND ====================
app.get("/", (req,res)=>{
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>IA DJ Web Stream</title>
<style>
body { font-family: Arial; background: #111; color: #fff; padding: 20px; }
h1 { color: #ff4081; }
div { margin: 10px 0; font-size: 1.2em; }
</style>
</head>
<body>
<h1>🎧 IA DJ Web Stream</h1>
<div id="song">Cargando canción...</div>
<div id="weather">Clima cargando...</div>
<div id="news">Noticias cargando...</div>
<audio src="https://az.azurafree.eu/listen/la_fronterisima/radio.mp3" autoplay controls></audio>
<audio id="tts"></audio>

<script>
const BACKEND = "";

const songDiv = document.getElementById('song');
const weatherDiv = document.getElementById('weather');
const newsDiv = document.getElementById('news');
const ttsAudio = document.getElementById('tts');

async function fetchNowPlaying() {
  try {
    const res = await fetch(BACKEND + "/song");
    const data = await res.json();
    return data.now_playing.song.artist + " - " + data.now_playing.song.title;
  } catch { return "Canción desconocida"; }
}

async function fetchWeather() {
  try {
    const res = await fetch(BACKEND + "/weather");
    const data = await res.json();
    return data.current_weather.temperature + "°C";
  } catch { return "No disponible"; }
}

async function fetchNews() {
  try {
    const res = await fetch(BACKEND + "/news");
    const txt = await res.text();
    const xml = new DOMParser().parseFromString(txt,"text/xml");
    const items = xml.querySelectorAll("item");
    let noticias = [];
    for(let i=0;i<3;i++){
      noticias.push(items[i].querySelector("title").textContent);
    }
    return noticias.join(". ");
  } catch { return "No disponible"; }
}

function getHoraColombia() {
  return new Date().toLocaleTimeString('es-CO', { timeZone:'America/Bogota', hour:'2-digit', minute:'2-digit' });
}

async function speakTTS(text) {
  try {
    const res = await fetch(BACKEND + "/voz?texto=" + encodeURIComponent(text));
    const blob = await res.blob();
    ttsAudio.src = URL.createObjectURL(blob);
    ttsAudio.play();
  } catch(err){ console.error("Error TTS", err); }
}

async function updateDJ() {
  const [song, weather, news] = await Promise.all([
    fetchNowPlaying(),
    fetchWeather(),
    fetchNews()
  ]);

  songDiv.textContent = "🎵 " + song;
  weatherDiv.textContent = "🌤️ " + weather;
  newsDiv.textContent = "📰 " + news;

  const now = new Date();
  if(now.getMinutes() % 15 === 0){
    const texto = \`Hola, son las \${getHoraColombia()} en Colombia.
El clima es \${weather}.
Ahora suena \${song}.
Noticias: \${news}\`;
    speakTTS(texto);
  }
}

updateDJ();
setInterval(updateDJ, 60000);
</script>
</body>
</html>
  `);
});

// ==================== BACKEND API ====================
const AZURA_API = process.env.AZURA_API;
const AZURA_KEY = process.env.AZURA_KEY;

// Canción actual
app.get("/song", async (req,res)=>{
  try{
    const response = await axios.get(`${AZURA_API}/nowplaying`,{
      headers:{ "Authorization":"Bearer "+AZURA_KEY }
    });
    res.json(response.data);
  }catch{
    res.json({ now_playing:{ song:{ artist:"Desconocido", title:"Desconocida" } } });
  }
});

// Clima Cali
app.get("/weather", async (req,res)=>{
  try{
    const response = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
    res.json(response.data);
  }catch{
    res.json({ current_weather:{ temperature:"No disponible" } });
  }
});

// Noticias
app.get("/news", async (req,res)=>{
  try{
    const response = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml");
    res.send(response.data);
  }catch{
    res.send("<rss><channel><item><title>No disponible</title></item></channel></rss>");
  }
});

// Voz TTS
app.get("/voz", async (req,res)=>{
  const texto = req.query.texto;
  if(!texto) return res.status(400).send("Texto requerido");

  try{
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_KEY,
      process.env.AZURE_REGION
    );
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
    synthesizer.speakTextAsync(
      texto,
      result=>{
        res.setHeader("Content-Type","audio/mpeg");
        res.send(Buffer.from(result.audioData));
      },
      err=>{
        console.error(err);
        res.status(500).send("Error voz");
      }
    );
  }catch{
    res.status(500).send("Error servidor voz");
  }
});

// ==================== DJ AUTOMÁTICO ====================
async function crearGuion(){
  try{
    const [songRes, weatherRes, newsRes] = await Promise.all([
      axios.get(`${AZURA_API}/nowplaying`,{ headers:{ "Authorization":"Bearer "+AZURA_KEY } }),
      axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true"),
      axios.get("https://feeds.bbci.co.uk/mundo/rss.xml")
    ]);
    const song = songRes.data.now_playing.song;
    const clima = weatherRes.data.current_weather.temperature + "°C";
    const noticias = [...newsRes.data.matchAll(/<title>(.*?)<\/title>/g)].slice(1,3).map(m=>m[1]).join(". ");
    const hora = new Date().toLocaleTimeString('es-CO',{ timeZone:'America/Bogota', hour:'2-digit', minute:'2-digit' });
    return `Hola, son las ${hora} en Colombia. El clima en Cali es ${clima}. Estás escuchando ${song.artist} - ${song.title}. Noticias: ${noticias}`;
  }catch{
    return "Estás escuchando La Fronterísima Radio";
  }
}

async function generarVoz(texto){
  const response = await axios.get(`http://localhost:${PORT}/voz?texto=${encodeURIComponent(texto)}`,{ responseType:'arraybuffer' });
  fs.writeFileSync("voz.mp3", response.data);
}

function mezclarAudio(){
  return new Promise((resolve,reject)=>{
    exec(`
      ffmpeg -y \
      -i musica.mp3 \
      -i voz.mp3 \
      -filter_complex "[0:a][1:a]sidechaincompress=threshold=0.03:ratio=10[out]" \
      -map "[out]" \
      -c:a libmp3lame salida.mp3
    `,(err)=>{
      if(err) reject(err);
      else resolve();
    });
  });
}

async function subirAzura(){
  const file = fs.readFileSync("salida.mp3");
  const form = new FormData();
  form.append("path","dj/dj_auto.mp3");
  form.append("file",file,"dj_auto.mp3");

  await axios.post(AZURA_API,form,{
    headers:{ ...form.getHeaders(), "X-API-Key":AZURA_KEY }
  });
  console.log("🎧 Audio subido a AzuraCast");
}

async function DJAutomatico(){
  try{
    console.log("🎤 Generando locución...");
    const texto = await crearGuion();
    await generarVoz(texto);
    await mezclarAudio();
    await subirAzura();
    console.log("✅ DJ emitido correctamente");
  }catch(err){
    console.error("❌ Error DJ:",err);
  }
}

// Cada 15 minutos
setInterval(DJAutomatico,15*60*1000);
DJAutomatico();

// ==================== INICIAR SERVIDOR ====================
app.listen(PORT,()=>console.log("🎧 Backend IA Radio activo en puerto "+PORT));
