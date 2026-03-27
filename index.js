
 const sdk = require("microsoft-cognitiveservices-speech-sdk");
const axios = require("axios");
const fs = require("fs");
const { exec } = require("child_process");
const http = require("http");

// 🔐 VARIABLES (Render ENV)
const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const AZURA_API_URL = process.env.AZURA_API_URL;
const AZURA_API_KEY = process.env.AZURA_API_KEY;
const STATION_ID = process.env.STATION_ID;

// 🎧 Estado
let ultimaCancion = "";
let contador = 0;

// 🎲 FRASES DINÁMICAS
function generarFrase(cancion) {
    const frases = [
        `Atención porque esto está sonando ahora mismo... ${cancion}`,
        `Sube el volumen porque llega... ${cancion}`,
        `Esto es puro ritmo con... ${cancion}`,
        `Momento de buena música con... ${cancion}`
    ];
    return frases[Math.floor(Math.random() * frases.length)];
}

// 🕒 HORA NATURAL
function obtenerHoraActual() {
    const ahora = new Date();
    const h = ahora.getHours();
    const m = ahora.getMinutes();
    return `Son las ${h} con ${m} minutos en La Fronterísima.`;
}

// 🎙️ VOZ DOBLE (CABINA PRO)
async function generarAudioAzure(texto1, texto2 = null) {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    const audioConfig = sdk.AudioConfig.fromAudioFileOutput("voz_temp.mp3");
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

    let ssml;

    if (texto2) {
        ssml = `
        <speak version="1.0" xml:lang="es-ES"
        xmlns:mstts="https://www.w3.org/2001/mstts">
            <voice name="es-ES-AlvaroNeural">
                <mstts:express-as style="cheerful">${texto1}</mstts:express-as>
            </voice>
            <break time="400ms"/>
            <voice name="es-ES-ElviraNeural">
                <mstts:express-as style="friendly">${texto2}</mstts:express-as>
            </voice>
        </speak>`;
    } else {
        ssml = `
        <speak version="1.0" xml:lang="es-ES"
        xmlns:mstts="https://www.w3.org/2001/mstts">
            <voice name="es-ES-AlvaroNeural">
                <mstts:express-as style="cheerful">
                    <prosody rate="1.05" pitch="+2%">
                        ${texto1}
                    </prosody>
                </mstts:express-as>
            </voice>
        </speak>`;
    }

    return new Promise((resolve, reject) => {
        synthesizer.speakSsmlAsync(
            ssml,
            () => {
                synthesizer.close();
                resolve("voz_temp.mp3");
            },
            reject
        );
    });
}

// 🎚️ MEZCLA PRO (DUCKING REAL)
async function mezclarAudio() {
    return new Promise((resolve, reject) => {
        const cmd = `
        ffmpeg -y \
        -i cortina.mp3 \
        -i voz_temp.mp3 \
        -filter_complex "
        [0:a]volume=0.25[a0];
        [1:a]volume=1.4[a1];
        [a0][a1]sidechaincompress=threshold=0.02:ratio=10[out]
        " \
        -map "[out]" -c:a libmp3lame -q:a 2 final_radio.mp3
        `;
        exec(cmd, (err) => {
            if (err) reject(err);
            else resolve("final_radio.mp3");
        });
    });
}

// 📡 ENVIAR AL STREAM (LIVE)
async function enviarAlStream(filePath) {
    return new Promise((resolve, reject) => {
        const cmd = `ffmpeg -re -i ${filePath} -c:a libmp3lame -b:a 128k -f mp3 "http://fronterisima:fronterisima@az.azurafree.eu:8225/fronterisima"`;
        exec(cmd, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// 🎙️ LOCUCIÓN COMPLETA
async function locucion(texto1, texto2 = null) {
    console.log("🎙️ Generando voz...");
    await generarAudioAzure(texto1, texto2);

    console.log("🎚️ Mezclando...");
    await mezclarAudio();

    console.log("🚀 Enviando...");
    await enviarAlStream("final_radio.mp3");

    console.log("✅ Emitido:", texto1);
}

// 🎵 DETECTAR CAMBIO DE CANCIÓN
async function detectarCambio() {
    try {
        const res = await axios.get(`${AZURA_API_URL}/nowplaying/${STATION_ID}`);
        const actual = res.data.now_playing.song.text;

        if (actual !== ultimaCancion) {
            console.log("🎵 Nueva:", actual);
            contador++;

            if (contador % 2 === 0) {
                const frase = generarFrase(actual);

                await locucion(
                    frase,
                    "Y recuerda que estás en La Fronterísima, la emisora que cruza fronteras."
                );
            }

            ultimaCancion = actual;
        }

    } catch (err) {
        console.error("❌ Error:", err.message);
    }
}

// 🔁 LOOP CANCIÓN
setInterval(detectarCambio, 20000);

// ⏰ LOCUCIÓN DE HORA
setInterval(async () => {
    try {
        await locucion(obtenerHoraActual());
    } catch (err) {
        console.error("❌ Hora error:", err.message);
    }
}, 15 * 60 * 1000);

// 🌐 SERVER (Render keep-alive)
const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Radio IA activa 🎧");
}).listen(PORT, "0.0.0.0", () => {
    console.log("🌐 Server activo en puerto", PORT);
});
