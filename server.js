require('dotenv').config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

// ======= 1. CONFIGURACIÓN =======
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");
const KEYS = {
    GEMINI: (process.env.GOOGLE_API_KEY || "").trim(),
    GROQ: (process.env.GROQ_API_KEY || "").trim(),
    AZURE: (process.env.AZURE_SPEECH_KEY || "").trim(),
    AZURE_REGION: (process.env.AZURE_REGION || "eastus").trim(),
    AZURA: (process.env.AZURA_KEY || "").trim(),
    STATION_ID: sID,
    TELEGRAM_TOKEN: (process.env.TELEGRAM_TOKEN || "").trim(),
    JAMENDO_ID: (process.env.JAMENDO_CLIENT_ID || "c230e1f4").trim()
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_UPLOAD = `${AZURA_BASE}/files/upload`;

// ======= 2. TELEGRAM =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
bot.on('polling_error', (err) => { }); // Ignorar errores de conexión

let ultimoSaludo = { nombre: "", texto: "", fecha: null };
let cancionRecienDescubierta = null;

bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (msg.text === '/descubrir') {
        const track = await buscarMusicaJamendo('latin');
        if (track) {
            await descargarYSubirAzura(track);
            cancionRecienDescubierta = track.info;
            bot.sendMessage(msg.chat.id, `✅ Subí: ${track.info}`);
        }
        return;
    }
    if (!msg.text.startsWith('/')) {
        ultimoSaludo = { nombre: msg.from.first_name, texto: msg.text, fecha: new Date() };
        bot.sendMessage(msg.chat.id, "¡Saludo recibido! 🎙️");
    }
});

// ======= 3. FUNCIONES IA Y MÚSICA =======

async function buscarMusicaJamendo(genero) {
    try {
        const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&order=random&fuzzytags=${genero}&audioformat=mp32`;
        const res = await axios.get(url);
        const t = res.data.results[0];
        return { url: t.audio, nombre: `${t.artist_name} - ${t.name}.mp3`.replace(/[/\\?%*:|"<>]/g, '-'), info: `${t.name} de ${t.artist_name}` };
    } catch (e) { return null; }
}

async function descargarYSubirAzura(track) {
    const tmp = path.join(__dirname, 'tmp.mp3');
    try {
        const res = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const w = fs.createWriteStream(tmp);
        res.data.pipe(w);
        return new Promise((resolve) => {
            w.on('finish', async () => {
                const f = new FormData();
                f.append('file', fs.createReadStream(tmp), { filename: track.nombre });
                f.append('path', `Musica_Nueva/${track.nombre}`);
                await axios.post(AZURA_UPLOAD, f, { headers: { ...f.getHeaders(), "X-API-Key": KEYS.AZURA } });
                fs.unlinkSync(tmp); resolve();
            });
        });
    } catch (e) { }
}

async function redactarIA(prompt) {
    try {
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`, { contents: [{ parts: [{ text: prompt }] }] });
        return res.data.candidates[0].content.parts[0].text.replace(/[*#_~]/g, '').trim();
    } catch {
        return "Sintonizas La Fronterísima, notas surcando fronteras.";
    }
}

// ======= 4. AUDIO Y REPORTE =======

async function generarVoz(texto, archivo) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
        const synth = new sdk.SpeechSynthesizer(config);
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO"><voice name="es-CO-SalomeNeural"><prosody rate="+8%">${texto}</prosody></voice></speak>`;
        synth.speakSsmlAsync(ssml, r => { fs.writeFileSync(archivo, Buffer.from(r.audioData)); synth.close(); resolve(); }, e => { synth.close(); reject(e); });
    });
}

async function producirYSubir(archivoVoz, nombreFinal) {
    const salida = `p_${Date.now()}.mp3`;
    const cmd = `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${salida}`;
    return new Promise((resolve) => {
        exec(cmd, async () => {
            try {
                const f = new FormData();
                f.append('file', fs.createReadStream(salida), { filename: nombreFinal });
                f.append('path', nombreFinal);
                await axios.post(AZURA_UPLOAD, f, { headers: { ...f.getHeaders(), "X-API-Key": KEYS.AZURA } });
                [archivoVoz, salida].forEach(x => { if(fs.existsSync(x)) fs.unlinkSync(x); });
            } catch (e) { }
            resolve();
        });
    });
}

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=4.57&longitude=-74.30&current_weather=true");
        const t = Math.round(clim.data.current_weather.temperature);
        const resNp = await axios.get(`${AZURA_BASE}/nowplaying`);
        const np = resNp.data.now_playing?.song?.title || "Éxitos";
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' });

        const prompt = `Actúa como Salomé de La Fronterísima. Colombia, ${hora}, ${t}°C. Suena: ${np}. Escribe un guion de 50 palabras alegre. Termina: Notas surcando fronteras.`;
        const guion = await redactarIA(prompt);
        await generarVoz(guion, "v.mp3");
        await producirYSubir("v.mp3", "dj_auto.mp3");
        console.log(`✅ Reporte OK [${hora}]`);
    } catch (e) { console.error("Error Auto:", e.message); }
}

// ======= 5. ARRANQUE =======
app.get("/health", (req, res) => res.sendStatus(200));
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Puerto ${PORT}`);
    setInterval(autoReporte, 15 * 60 * 1000);
    setTimeout(autoReporte, 5000);
});
