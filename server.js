const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const Parser = require('rss-parser');
require('dotenv').config();

const app = express();
const parser = new Parser();

// ======= CONFIGURACIÓN ESTACIÓN 24 =======
const AZURA_API = "https://az.azurafree.eu/api/station/24/files"; 
const AZURA_KEY = process.env.AZURA_KEY;
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_REGION;

function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

async function crearGuion() {
  try {
    const songRes = await axios.get("https://az.azurafree.eu/api/nowplaying/24");
    const artista = songRes.data.now_playing?.song?.artist || "varios artistas";
    const cancion = songRes.data.now_playing?.song?.title || "la mejor música";
    const weatherRes = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
    const temp = Math.round(weatherRes.data.current_weather.temperature);
    const feed = await parser.parseURL('https://feeds.bbci.co.uk/mundo/rss.xml');
    const noticias = feed.items.slice(0, 2).map(i => i.title).join(". ");

    return `Hola, son las ${getHora()} en Colombia. El clima en Cali es de ${temp} grados. Estás escuchando a ${artista} con el éxito ${cancion}. En noticias: ${noticias}. Sigue con más música en La Fronterísima.`;
  } catch (e) {
    return `Hola, son las ${getHora()}. Estás en sintonía de La Fronterísima, acompañándote con la mejor música.`;
  }
}

async function generarVoz(texto) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
    synthesizer.speakTextAsync(texto, result => {
      if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
        fs.writeFileSync("voz.mp3", Buffer.from(result.audioData));
        synthesizer.close();
        resolve();
      } else {
        synthesizer.close();
        reject("Error Azure: " + result.errorDetails);
      }
    }, reject);
  });
}

function mezclarAudio() {
  return new Promise((resolve, reject) => {
    // Comando simple para asegurar que no falle por falta de fondo
    const comando = fs.existsSync("fondo.mp3") 
      ? `ffmpeg -y -i fondo.mp3 -i voz.mp3 -filter_complex "[0:a]volume=0.4[bg];[1:a]volume=1.3[v];[bg][v]sidechaincompress=threshold=0.1:ratio=20:attack=100:release=1000[out]" -map "[out]" -c:a libmp3lame -b:a 128k salida.mp3`
      : `ffmpeg -y -i voz.mp3 -c:a libmp3lame -b:a 128k salida.mp3`;

    exec(comando, (err) => err ? reject(err) : resolve());
  });
}

async function subirAzura() {
  if (!fs.existsSync("salida.mp3")) return;
  const form = new FormData();
  form.append("path", "dj_auto.mp3"); // Directo a la raíz
  form.append("file", fs.createReadStream("salida.mp3"));

  try {
    await axios.post(AZURA_API, form, {
      headers: { ...form.getHeaders(), "X-API-Key": AZURA_KEY }
    });
    console.log("✅ Audio subido a la estación 24");
  } catch (err) {
    console.error("❌ Error 403: Revisa tu API Key en AzuraCast Estación 24");
  }
}

async function DJ() {
  try {
    const guion = await crearGuion();
    await generarVoz(guion);
    await mezclarAudio();
    await subirAzura();
  } catch (error) {
    console.error("⚠️ Error en ciclo DJ:", error.message);
  }
}

app.get("/", (req, res) => res.send("Radio IA Online"));

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  setTimeout(DJ, 5000);
  setInterval(DJ, 15 * 60 * 1000);
});
