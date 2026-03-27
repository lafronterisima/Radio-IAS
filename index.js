
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;

ffmpeg.setFfmpegPath(ffmpegPath);

const sdk = require("microsoft-cognitiveservices-speech-sdk");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
ffmpeg.setFfmpegPath(ffmpegPath);

// 🔐 VARIABLES SEGURAS (Render ENV)
const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const AZURA_API_URL = process.env.AZURA_API_URL;
const AZURA_API_KEY = process.env.AZURA_API_KEY;
const STATION_ID = process.env.STATION_ID;

// 🎧 estado
let ultimaCancion = "";

/**
 * 🎙️ GENERAR VOZ
 */
async function generarAudioAzure(texto) {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-ES-AlvaroNeural";

    const audioConfig = sdk.AudioConfig.fromAudioFileOutput("voz_temp.mp3");
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

    return new Promise((resolve, reject) => {
        synthesizer.speakTextAsync(texto, () => {
            synthesizer.close();
            resolve("voz_temp.mp3");
        }, reject);
    });
}

/**
 * 🎚️ MEZCLAR AUDIO EN TIEMPO REAL (DUCKING)
 */
async function mezclarAudioEnVivo() {
    return new Promise((resolve, reject) => {
        // Transmitir la mezcla en vivo (sin generar archivos intermedios)
        ffmpeg()
            .input("cortina.mp3")             // Música de fondo
            .input("voz_temp.mp3")            // Locución generada por Azure
            .complexFilter([
                "[0:a][1:a]sidechaincompress=threshold=0.03:ratio=12[out]"   // Mezcla (ducker)
            ])
            .outputOptions(["-map [out]", "-q:a 2"])                          // Codificar en mp3
            .audioBitrate("128k")
            .output("pipe:1")  // Enviar el resultado al stream sin archivos intermedios
            .on('end', () => {
                console.log("🎚️ Mezcla completa y transmitida.");
                resolve();
            })
            .on('error', (err) => {
                console.error("❌ Error al mezclar:", err);
                reject(err);
            })
            .run();   // Inicia la transmisión en vivo
    });
}

/**
 * 📡 ENVIAR AUDIO AL STREAM DE AZURACAST EN TIEMPO REAL
 */
async function enviarAudioAlStream() {
    return new Promise((resolve, reject) => {
        const cmd = `ffmpeg -re -i pipe:1 -c:a libmp3lame -b:a 128k -content_type audio/mpeg -f mp3 "http://fronterisima:fronterisima@az.azurafree.eu:8225/fronterisima"`;

        // Ejecutar el comando de FFmpeg para inyectar al stream
        console.log("🚀 Inyectando locución al stream...");
        exec(cmd, (err) => {
            if (err) {
                console.error("❌ Error al inyectar al stream:", err);
                reject(err);
            } else {
                console.log("🎧 Locución transmitida con éxito.");
                resolve();
            }
        });
    });
}

/**
 * 🎙️ LOCUCIÓN COMPLETA EN VIVO
 */
async function locucionEnVivo(texto) {
    console.log("🎙️ Generando voz...");
    await generarAudioAzure(texto);

    console.log("🎚️ Mezclando audio en tiempo real...");
    await mezclarAudioEnVivo();

    console.log("🚀 Enviando al stream...");
    await enviarAudioAlStream();
}

/**
 * ⏰ LOCUCIÓN DE LA HORA CADA 15 MINUTOS
 */
function obtenerHoraActual() {
    const ahora = new Date();
    const h = ahora.getHours().toString().padStart(2, "0");
    const m = ahora.getMinutes().toString().padStart(2, "0");
    return `La hora actual es ${h} horas con ${m} minutos.`;
}

// Llamar a la locución de la hora cada 15 minutos
setInterval(async () => {
    try {
        await locucionEnVivo(obtenerHoraActual());
    } catch (err) {
        console.error("❌ Error al anunciar la hora:", err.message);
    }
}, 15 * 60 * 1000); // cada 15 minutos

/**
 * 🧠 DETECTAR CAMBIO DE CANCIÓN EN AZURACAST
 */
async function detectarCambio() {
    try {
        const res = await axios.get(`${AZURA_API_URL}/nowplaying/${STATION_ID}`);
        const data = res.data;

        const actual = data.now_playing.song.text;

        if (actual !== ultimaCancion) {
            console.log("🎵 Nueva canción detectada:", actual);
            await locucionEnVivo(`Ahora suena ${actual}`);
            ultimaCancion = actual;
        }
    } catch (err) {
        console.error("❌ Error al detectar el cambio de canción:", err.response?.data || err.message);
    }
}

// Detectar cambios de canción cada 20 segundos
setInterval(detectarCambio, 20000);

/**
 * 🌐 Web Service mínimo para mantener activo el servicio en Render Free
 */
const http = require("http");

const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
    res.writeHead(200, {"Content-Type": "text/plain"});
    res.end("Radio IA en vivo 🎧");
}).listen(PORT, "0.0.0.0", () => {
    console.log("🌐 Servidor activo en puerto", PORT);
});