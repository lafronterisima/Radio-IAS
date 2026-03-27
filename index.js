
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");

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
 * 🎚️ MEZCLA PRO (DUCKING)
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
 * 📡 SUBIR A AZURACAST
 */
async function subirAAzuraCast(filePath) {
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));

    const fileName = `radio_ia_${Date.now()}.mp3`;

    await axios.post(
        `${AZURA_API_URL}/station/${STATION_ID}/files`,
        form,
        {
            headers: {
                ...form.getHeaders(),
                "X-API-Key": AZURA_API_KEY
            },
            params: { path: `ia_automations/${fileName}` }
        }
    );

    console.log("🚀 Subido:", fileName);
}

/**
 * 🎙️ LOCUCIÓN COMPLETA
 */
async function locucionAutomatica(texto) {
    await generarAudioAzure(texto);
    await mezclarAudio();
    await subirAAzuraCast("final_radio.mp3");
}

/**
 * 🧠 DETECTAR CAMBIO DE CANCIÓN (🔥 CLAVE)
 */
async function detectarCambio() {
    try {
        const res = await axios.get(`${AZURA_API_URL}/nowplaying/${STATION_ID}`);
        const data = res.data;

        const actual = data.now_playing.song.text;

        if (actual !== ultimaCancion) {
            console.log("🎵 Nueva:", actual);

            await locucionAutomatica(`Ahora suena ${actual}`);

            ultimaCancion = actual;
        }

    } catch (err) {
        console.error("Error:", err.message);
    }
}

/**
 * 🔁 LOOP AUTOMÁTICO 24/7
 */
setInterval(detectarCambio, 20000);