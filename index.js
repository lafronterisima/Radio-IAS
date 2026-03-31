const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const { exec } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
require('dotenv').config();

const app = express();

// ================= CONFIGURACIÓN =================
// Las llaves se leen de las variables de entorno de Koyeb
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_REGION;

// ================= UTILIDADES =================
function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

// Limpia archivos antiguos al arrancar o antes de cada locución
function limpiarTemporales() {
  const archivos = ["voz.mp3", "procesando.mp3", "salida.mp3"];
  archivos.forEach(file => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
}

// ================= GENERACIÓN DE GUION =================
async function crearGuion() {
  try {
    const [songRes, weatherRes, newsRes] = await Promise.all([
      axios.get("https://az.azurafree.eu/api/nowplaying/la_fronterisima"),
      axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true"),
      axios.get("https://feeds.bbci.co.uk/mundo/rss.xml")
    ]);

    const song = songRes.data.now_playing.song;
    const clima = Math.round(weatherRes.data.current_weather.temperature) + " grados";
    const noticias = [...newsRes.data.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g)]
      .slice(2, 4).map(m => m[1] || m[2]).join(". ");

    return `Hola, son las ${getHora()} en Colombia. El clima en Cali es de ${clima}. Estás escuchando a ${song.artist} con el éxito ${song.title}. En noticias: ${noticias}. Sigue con más música en La Fronterísima.`;
  } catch (error) {
    return "Estás escuchando La Fronterísima Radio, acompañándote con la mejor música las 24 horas.";
  }
}

// ================= SÍNTESIS DE VOZ =================
async function generarVoz(texto) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16khz32kBitrateMonoMp3;

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
    }, err => { synthesizer.close(); reject(err); });
  });
}

// ================= MEZCLA Y PUBLICACIÓN =================
function mezclarYPublicar() {
  return new Promise((resolve, reject) => {
    // Si no hay fondo, la voz pasa a ser el archivo procesando
    if (!fs.existsSync("fondo.mp3")) {
      fs.copyFileSync("voz.mp3", "procesando.mp3");
      fs.renameSync("procesando.mp3", "salida.mp3");
      return resolve();
    }

    const comando = `"${ffmpegPath}" -y -i fondo.mp3 -i voz.mp3 -filter_complex "[0:a]volume=0.4[bg];[1:a]volume=1.5[v];[bg][v]sidechaincompress=threshold=0.1:ratio=20:attack=100:release=1000[out]" -map "[out]" -c:a libmp3lame -b:a 128k procesando.mp3`;

    exec(comando, (err) => {
      if (err) return reject(err);
      
      // ✅ EL PASO CLAVE: Solo cuando FFmpeg termina, Liquidsoap ve el archivo
      if (fs.existsSync("procesando.mp3")) {
        fs.renameSync("procesando.mp3", "salida.mp3");
        console.log("📢 DJ Publicado: salida.mp3 listo para transmitir.");
      }
      resolve();
    });
  });
}

// ================= FUNCIÓN PRINCIPAL =================
async function DJ() {
  try {
    console.log(`--- Iniciando ciclo de IA ${new Date().toISOString()} ---`);
    
    // 1. Limpiar rastro anterior para que Liquidsoap no repita audios viejos
    limpiarTemporales();

    // 2. Crear contenido
    const texto = await crearGuion();
    await generarVoz(texto);
    
    // 3. Procesar y publicar
    await mezclarYPublicar();
    
    console.log("✅ Ciclo completado con éxito.");
  } catch (err) {
    console.error("❌ Error en el DJ:", err.message);
  }
}

// Configuración de intervalos
setInterval(DJ, 15 * 60 * 1000); // Cada 15 min
setTimeout(DJ, 5000);            // Primer inicio a los 5 seg

// Servidor para Health Check de Koyeb
app.get("/", (req, res) => res.send("📻 LA FRONTERÍSIMA IA: ACTIVA"));
app.listen(process.env.PORT || 3000, '0.0.0.0');
