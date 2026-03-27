
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const axios = require("axios");
const fs = require("fs");
const { exec } = require("child_process");

// 🔐 VARIABLES SEGURAS (Render ENV)
const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const AZURA_API_URL = process.env.AZURA_API_URL;
const AZURA_API_KEY = process.env.AZURA_API_KEY;
const STATION_ID = process.env.STATION_ID;

// 🎧 Estado
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
        synthesizer.speakTextAsync(
            texto,
            () => {
                synthesizer.close();
                resolve("voz_temp.mp3");
            },
            reject
        );
    });
}

/**
 * 🎚️ MEZCLAR AUDIO (DUCKING)
 */
async function mezclarAudio() {
    return new Promise((resolve, reject) => {
        const cmd = `ffmpeg -y -i cortina.mp3 -i voz_temp.mp3 -filter_complex "[0:a][1:a]sidechaincompress=threshold=0.03:ratio=12[out]" -map "[out]" -c:a libmp3lame -q:a 2 final_radio.mp3`;
        exec(cmd, (err) => {
            if (err) reject(err);
            else resolve("final_radio.mp3");
        });
    });
}

/**
 * 📡 ENVIAR AUDIO AL STREAM DE AZURACAST
 */
async function enviarAlStream(filePath) {
    return new Promise((resolve, reject) => {
        const cmd = `ffmpeg -re -i ${filePath} -c:a libmp3lame -b:a 128k -content_type audio/mpeg -f mp3 "http://fronterisima:fronterisima@az.azurafree.eu:8225/fronterisima"`;
        exec(cmd, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

/**
 * 🎙️ LOCUCIÓN COMPLETA EN VIVO
 */
async function locucionEnVivo(texto) {
    console.log("🎙️ Generando voz...");
    await generarAudioAzure(texto);
    console.log("🎚️ Mezclando con cortina...");
    await mezclarAudio();
    console.log("🚀 Enviando al stream...");
    await enviarAlStream("final_radio.mp3");
    console.log("✅ Locución transmitida: ", texto);
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

setInterval(async () => {
    try {
        await locucionEnVivo(obtenerHoraActual());
    } catch (err) {
        console.error("❌ Error al anunciar la hora:", err.message);
    }
}, 15 * 60 * 1000);

/**
 * 🧠 DETECTAR CAMBIO DE CANCIÓN
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
        console.error("❌ Error al detectar cambio de canción:", err.response?.data || err.message);
    }
}

setInterval(detectarCambio, 20000);

/**
 * 🌐 Web Service mínimo para mantener activo Render Free
 */
const http = require("http");
const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Radio IA en vivo 🎧");
}).listen(PORT, "0.0.0.0", () => {
    console.log("🌐 Servidor activo en puerto", PORT);
});