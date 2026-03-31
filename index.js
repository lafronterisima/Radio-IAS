const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
require('dotenv').config();

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
    const clima = Math.round(weatherRes.data.current_weather.temperature) + " grados";

    const noticias = [...newsRes.data.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g)]
      .slice(2, 4)
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
      process.env.AZURE_SPEECH_KEY,
      process.env.AZURE_REGION
    );

    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";
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
          synthesizer.close();
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
    // Comando optimizado: baja el fondo al 10% cuando detecta voz
    const comando = `"${ffmpegPath}" -y -i fondo.mp3 -i voz.mp3 -filter_complex "[0:a]volume=0.4[bg];[1:a]volume=1.5[v];[bg][v]sidechaincompress=threshold=0.1:ratio=20:attack=100:release=1000[out]" -map "[out]" -c:a libmp3lame -b:a 128k salida.mp3`;

    exec(comando, (err) => {
      if (err) reject("Error en FFmpeg: " + err);
      else resolve();
    });
  });
}

// ================= SUBIR AZURA =================
async function subirAzura() {
  try {
    // Usamos readFileSync para asegurar que el buffer esté completo antes de enviarlo
    const fileBuffer = fs.readFileSync("salida.mp3");

    const form = new FormData();
    // Importante: El campo 'file' debe incluir el nombre y el tipo de contenido
    form.append("file", fileBuffer, {
      filename: "dj_auto.mp3",
      contentType: "audio/mpeg"
    });
    
    // Ruta en AzuraCast (asegúrate que la carpeta 'dj' exista)
    form.append("path", "dj/dj_auto.mp3");

    await axios.post(AZURA_API, form, {
      headers: {
        ...form.getHeaders(),
        "X-API-Key": AZURA_KEY
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    console.log("🎧 Audio subido con éxito a AzuraCast");
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    throw new Error("Error al subir a Azura: " + detail);
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

    if (!fs.existsSync("fondo.mp3")) {
      console.warn("⚠️ No se encontró fondo.mp3, se usará solo la voz.");
      fs.copyFileSync("voz.mp3", "salida.mp3");
    } else {
      await mezclarAudio();
      console.log("🎚️ Mezcla completada.");
    }

    await subirAzura();
    console.log("✅ Proceso finalizado con éxito.");

    // Limpieza de archivos temporales para evitar llenar el disco de Koyeb
    if (fs.existsSync("voz.mp3")) fs.unlinkSync("voz.mp3");
    if (fs.existsSync("salida.mp3")) fs.unlinkSync("salida.mp3");

  } catch (err) {
    console.error("❌ Error en el flujo del DJ:", err.message);
  }
}

// Ciclo: Cada 15 minutos
setInterval(DJ, 15 * 60 * 1000);
// Inicio: 10 segundos después del arranque
setTimeout(DJ, 10000);

// ================= SERVER =================
app.get("/", (req, res) => res.send("🎧 DJ IA PARA LA FRONTERÍSIMA ACTIVO"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log("🚀 Servidor en puerto " + PORT);
});
