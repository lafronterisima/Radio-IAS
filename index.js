    const sdk = require("microsoft-cognitiveservices-speech-sdk");
const axios = require("axios");
const fs = require("fs");
const { exec } = require("child_process");
const FormData = require("form-data");
const Parser = require("rss-parser");
const http = require("http");

const parser = new Parser();

// 🔐 ENV
const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const AZURA_API_URL = process.env.AZURA_API_URL;
const AZURA_API_KEY = process.env.AZURA_API_KEY;
const STATION_ID = process.env.STATION_ID;

// 🎧 Estado
let ultimaCancion = "";
let contador = 0;
let ultimoMinutoHora = -1;

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

// 🕒 HORA TEXTO
function obtenerHora() {
    const now = new Date();
    return `Son las ${now.getHours()} con ${now.getMinutes()} minutos en La Fronterísima.`;
}

// 🌍 NOTICIAS
const RSS_URL = "https://www.euronews.com/rss?level=theme&name=news";

function resumir(texto) {
    return texto.split(".").slice(0, 2).join(".") + ".";
}

async function obtenerNoticias() {
    const feed = await parser.parseURL(RSS_URL);
    const items = feed.items.slice(0, 3);
    return items.map(n => resumir(n.contentSnippet || n.title));
}

// 🎙️ VOZ AZURE (DOBLE)
async function generarAudio(texto1, texto2 = null) {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    const audioConfig = sdk.AudioConfig.fromAudioFileOutput("voz.mp3");
    const synth = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

    let ssml;

    if (texto2) {
        ssml = `
        <speak xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="es-ES">
            <voice name="es-ES-AlvaroNeural">
                <mstts:express-as style="serious">${texto1}</mstts:express-as>
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
                <mstts:express-as style="cheerful">${texto1}</mstts:express-as>
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

// 📤 SUBIR A AZURACAST (CARPETA radio_ia)
async function subir(filePath) {
    const fileName = `radio_ia_${Date.now()}.mp3`;
    const ruta = `radio_ia/${fileName}`;

    const form = new FormData();
    form.append("file", fs.createReadStream(filePath));

    try {
        await axios.post(
            `${AZURA_API_URL}/station/${STATION_ID}/files`,
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    "X-API-Key": AZURA_API_KEY
                },
                params: { path: ruta },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        console.log("📻 Subido:", ruta);
        return ruta;

    } catch (error) {
        console.error("❌ Error al subir:", error.response?.data || error.message);
    }
}

// 🧹 LIMPIAR
async function limpiar() {
    const res = await axios.get(`${AZURA_API_URL}/station/${STATION_ID}/files`, {
        headers: { "X-API-Key": AZURA_API_KEY }
    });

    const lista = res.data.filter(f => f.path.startsWith("radio_ia/"));

    if (lista.length > 15) {
        for (let f of lista.slice(0, lista.length - 15)) {
            await axios.delete(`${AZURA_API_URL}/station/${STATION_ID}/file/${f.id}`, {
                headers: { "X-API-Key": AZURA_API_KEY }
            });
            console.log("🗑️ Eliminado:", f.path);
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

// 🎵 DETECTAR CANCIÓN
async function detectar() {
    try {
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

    } catch (err) {
        console.error("❌ Error canción:", err.message);
    }
}

setInterval(detectar, 20000);

// ⏰ HORA EXACTA
setInterval(async () => {
    const now = new Date();
    const min = now.getMinutes();

    if (min % 15 === 0 && min !== ultimoMinutoHora) {
        ultimoMinutoHora = min;

        await emitir(
            "Atención...",
            obtenerHora()
        );
    }
}, 60000);

// 📰 NOTICIAS
async function emitirNoticias() {
    try {
        const noticias = await obtenerNoticias();

        await emitir(
            "Atención, boletín informativo...",
            `${noticias.join(" ")} Hasta aquí las noticias.`
        );

    } catch (err) {
        console.error("❌ Error noticias:", err.message);
    }
}

setInterval(emitirNoticias, 60 * 60 * 1000);

// 🌐 SERVER
http.createServer((req, res) => {
    res.end("Radio IA activa 🎧");
}).listen(process.env.PORT || 10000);
