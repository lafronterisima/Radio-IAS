
   
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
require('dotenv').config(); // 👈 Recomendado para manejar llaves

const app = express();

// ================= CONFIG =================
const AZURA_API = "https://az.azurafree.eu/api/station/24/files";
const AZURA_KEY = process.env.AZURA_KEY || "dd608c7b0c3e41ad:091b0407a742cefb20e5095a57b7e8d8"; 

// ================= HORA =================
function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
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
    const clima = Math.round(weatherRes.data.current_weather.temperature) + " grados"; // "grados" suena mejor que "C" en voz

    // Limpiamos un poco los títulos de noticias (quitamos etiquetas si hay)
    const noticias = [...newsRes.data.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g)]
      .slice(2, 4) // Saltamos el título del canal
      .map(m => m[1] || m[2])
      .join(". ");

    return `Hola, son las ${getHora()} en Colombia. El clima en Cali es de ${clima}. Estás escuchando a ${song.artist} con el éxito ${song.title}. En noticias: ${noticias}. Sigue con más música en La Fronterísima.`;
  } catch (error) {
    console.error("Error en guion:", error.message);
    return "Estás escuchando La Fronterísima Radio, la emisora que te acompaña con la mejor música las 24 horas.";
  }
}

// ================= VOZ =================
async function generarVoz(texto) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_SPEECH_KEY, // 👈 Asegúrate que coincida con tu .env
      process.env.AZURE_REGION
    );

    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";
    // Forzamos salida a MP3 (Azure por defecto usa WAV)
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16khz32kBitrateMonoMp3;

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    synthesizer.speakTextAsync(
      texto,
      result => {
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          fs.writeFileSync("voz.mp3", Buffer.from(result.audioData));
          synthesizer.close();
          resolve();
        } else {
          reject("Error en síntesis: " + result.errorDetails);
        }
      },
      err => {
        synthesizer.close();
        reject(err);
      }
    );
  });
}

// ================= MEZCLA (DUCKING PRO) =================
function mezclarAudio() {
  return new Promise((resolve, reject) => {
    // Asegúrate de tener un archivo "fondo.mp3" (la cortina musical) en la carpeta raíz
    // Este comando baja el volumen de la música automáticamente cuando entra la voz
    const comando = `"${ffmpegPath}" -y -i fondo.mp3 -i voz.mp3 -filter_complex "[0:a]volume=0.5[bg];[1:a]volume=1.2[v];[bg][v]sidechaincompress=threshold=0.1:ratio=20:attack=100:release=1000[out]" -map "[out]" -c:a libmp3lame -b:a 128k salida.mp3`;

    exec(comando, (err) => {
      if (err) reject("Error en FFmpeg: " + err);
      else resolve();
    });
  });
}

// ================= SUBIR AZURA =================
async function subirAzura() {
  try {
    const file = fs.createReadStream("salida.mp3"); // 👈 Stream es más eficiente que readFileSync

    const form = new FormData();
    form.append("path", "dj/dj_auto.mp3");
    form.append("file", file);

    await axios.post(AZURA_API, form, {
      headers: {
        ...form.getHeaders(),
        "X-API-Key": AZURA_KEY
      }
    });

    console.log("🎧 Audio subido con éxito a AzuraCast");
  } catch (err) {
    throw new Error("Error al subir a Azura: " + err.message);
  }
}

// ================= FUNCIÓN PRINCIPAL =================
async function DJ() {
  try {
    console.log(`--- Iniciando locución ${new Date().toISOString()} ---`);
    
    const texto = await crearGuion();
    console.log("📝 Guion:", texto);

    await generarVoz(texto);
    console.log("🔊 Voz generada.");

    await mezclarAudio();
    console.log("🎚️ Mezcla completada.");

    await subirAzura();
    console.log("✅ Proceso finalizado.");
  } catch (err) {
    console.error("❌ Error en el flujo del DJ:", err);
  }
}

// Ejecutar cada 15 min
setInterval(DJ, 15 * 60 * 1000);
// Ejecución inicial tras 5 segundos para dejar que el servidor arranque
setTimeout(DJ, 5000);

// ================= SERVER =================
app.get("/", (req, res) => res.send("🎧 DJ IA ACTIVO"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor en puerto " + PORT));
