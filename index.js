const sdk = require("microsoft-cognitiveservices-speech-sdk");
const axios = require("axios");
const fs = require("fs");
const { exec } = require("child_process");
const FormData = require("form-data");
const http = require("http");

// 🔐 ENV
const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const AZURA_API_URL = process.env.AZURA_API_URL;
const AZURA_API_KEY = process.env.AZURA_API_KEY;
const STATION_ID = process.env.STATION_ID;

// 🎧 Estado
let ultimaCancion = "";
let contador = 0;

// 🎲 FRASES
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
function obtenerHora() {
    const ahora = new Date();
    return `Son las ${ahora.getHours()} con ${ahora.getMinutes()} minutos en La Fronterísima.`;
}

// 🎙️ VOZ (DOBLE OPCIONAL)
async function generarAudio(texto1, texto2 = null) {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    const audioConfig = sdk.AudioConfig.fromAudioFileOutput("voz.mp3");
    const synth = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

    let ssml;

    if (texto2) {
        ssml = `
        <speak xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="es-ES">
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
        <speak xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="es-ES">
            <voice name="es-ES-AlvaroNeural">
                <mstts:express-as style="cheerful">
                    <prosody rate="1.05">${texto1}</prosody>
                </mstts:express-as>
            </voice>
        </speak>`;
    }

    return new Promise((res, rej) => {
        synth.speakSsmlAsync(ssml, () => {
            synth.close();
            res();
        }, rej);
    });
}

// 🎚️ MEZCLA
async function mezclar() {
    return new Promise((res, rej) => {
        const cmd = `
        ffmpeg -y -i cortina.mp3 -i voz.mp3 \
        -filter_complex "[0:a]volume=0.25[a0];[1:a]volume=1.4[a1];[a0][a1]sidechaincompress=threshold=0.02:ratio=10[out]" \
        -map "[out]" -c:a libmp3lame -q:a 2 final.mp3
        `;
        exec(cmd, err => err ? rej(err) : res());
    });
}

// 📤 SUBIR A AZURACAST
async function subir(filePath) {
    const name = `ia_${Date.now()}.mp3`;
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));

    await axios.post(`${AZURA_API_URL}/station/${STATION_ID}/files`, form, {
        headers: {
            ...form.getHeaders(),
            "X-API-Key": AZURA_API_KEY
        },
        params: { path: `ia/${name}` }
    });

    console.log("📻 Subido:", name);
}

// 🧹 LIMPIAR
async function limpiar() {
    const res = await axios.get(`${AZURA_API_URL}/station/${STATION_ID}/files`, {
        headers: { "X-API-Key": AZURA_API_KEY }
    });

    const lista = res.data.filter(f => f.path.startsWith("ia/"));

    if (lista.length > 10) {
        for (let f of lista.slice(0, lista.length - 10)) {
            await axios.delete(`${AZURA_API_URL}/station/${STATION_ID}/file/${f.id}`, {
                headers: { "X-API-Key": AZURA_API_KEY }
            });
        }
    }
}

// 🎙️ EMITIR
async function emitir(texto1, texto2 = null) {
    await generarAudio(texto1, texto2);
    await mezclar();
    await subir("final.mp3");
    await limpiar();
}

// 🎵 CAMBIO DE CANCIÓN
async function detectar() {
    const res = await axios.get(`${AZURA_API_URL}/nowplaying/${STATION_ID}`);
    const actual = res.data.now_playing.song.text;

    if (actual !== ultimaCancion) {
        contador++;

        if (contador % 2 === 0) {
            await emitir(
                generarFrase(actual),
                "Estás en La Fronterísima, la emisora que cruza fronteras."
            );
        }

        ultimaCancion = actual;
    }
}

setInterval(detectar, 20000);

// ⏰ LOCUCIÓN DE HORA
setInterval(async () => {
    await emitir(obtenerHora());
}, 15 * 60 * 1000);

// 🌐 SERVER (Render)
http.createServer((req, res) => {
    res.end("Radio IA activa 🎧");
}).listen(process.env.PORT || 10000);  
