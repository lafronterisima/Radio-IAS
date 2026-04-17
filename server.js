require('dotenv').config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require("openai");
const { EdgeTTS } = require("@juntao/edge-tts"); // Librería funcional

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = {
    OPENAI: safeTrim(process.env.OPENAI_API_KEY),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    JAMENDO_ID: safeTrim(process.env.JAMENDO_CLIENT_ID) || "c230e1f4"
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

const openai = new OpenAI({ apiKey: KEYS.OPENAI });
const tts = new EdgeTTS(); // Salomé lista

// ======= 2. TELEGRAM =======
const bot = KEYS.TELEGRAM_TOKEN ? new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true }) : null;
let ultimoSaludo = { nombre: "", texto: "", fecha: null };

if (bot) {
    console.log("✅ Bot conectado. Lupe (Salomé) al aire.");
    bot.on('voice', async (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, "🎤 Lupe está escuchando tu audio...");
        const tempVoice = path.join(__dirname, `v_${Date.now()}.ogg`);
        try {
            const fileUrl = await bot.getFileLink(msg.voice.file_id);
            const response = await axios({ url: fileUrl, responseType: 'stream' });
            const writer = fs.createWriteStream(tempVoice);
            response.data.pipe(writer);
            writer.on('finish', async () => {
                const transcription = await openai.audio.transcriptions.create({
                    file: fs.createReadStream(tempVoice),
                    model: "whisper-1"
                });
                ultimoSaludo = { nombre: msg.from.first_name, texto: transcription.text, fecha: new Date() };
                bot.sendMessage(chatId, "¡Recibido! Procesando tu pedido...");
                if (fs.existsSync(tempVoice)) fs.unlinkSync(tempVoice);
            });
        } catch (e) { console.error(e); }
    });
    bot.on('message', (msg) => {
        if (msg.text && !msg.text.startsWith('/')) {
            ultimoSaludo = { nombre: msg.from.first_name, texto: msg.text, fecha: new Date() };
        }
    });
}

// ======= 3. FUNCIONES IA Y VOZ =======
async function redactarIA(prompt) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: "Eres locutora de radio rumbera colombiana carismática. No digas tu nombre." }, { role: "user", content: prompt }],
            max_tokens: 150
        });
        return response.choices[0].message.content.replace(/[*#_~]/g, '');
    } catch (e) { return "Sintonía total en La Fronterísima."; }
}

async function generarVoz(texto, archivoDestino) {
    try {
        // La voz es es-CO-SalomeNeural
        await tts.getAudio(texto, "es-CO-SalomeNeural");
        // Esta librería guarda un buffer, así que lo escribimos a mano
        const buffer = await tts.getAudio(texto, "es-CO-SalomeNeural");
        fs.writeFileSync(archivoDestino, buffer);
        console.log("🎙️ Audio de Salomé creado.");
    } catch (e) { console.error("Error TTS:", e); }
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondo = "fondo.mp3";
    let cmd = (conFondo && fs.existsSync(fondo))
    ? `ffmpeg -y -i ${archivoVoz} -i ${fondo} -filter_complex "[0:a]volume=1.8[v];[1:a]volume=0.15[bg];[v][bg]amix=inputs=2:duration=first" -c:a libmp3lame ${tempSalida}`
    : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame ${tempSalida}`;
    
    return new Promise((resolve) => {
        exec(cmd, async () => {
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                form.append('path', nombreFinal);
                await axios.post(AZURA_API_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA } });
                [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                resolve();
            } catch (e) { resolve(); }
        });
    });
}

// ======= 4. AUTOMATIZACIÓN =======
async function autoReporte() {
    try {
        const np = await axios.get(`${AZURA_BASE}/nowplaying`).then(r => r.data.now_playing.song.title).catch(() => "éxitos");
        const hora = new Date().toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit' });
        const prompt = `Reporte: Hora ${hora}, suena ${np}. 40 palabras rumberas.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
    } catch (e) { console.log(e); }
}

// ======= 5. RUTAS Y SERVIDOR =======
app.post("/procesar-locucion", async (req, res) => {
    const pathVoz = `v_${Date.now()}.mp3`;
    await generarVoz(req.body.texto, pathVoz);
    await producirYSubir(pathVoz, "Redactor_ia.mp3", req.body.conFondo);
    res.send("OK");
});

app.get("/health", (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima escuchando en ${PORT}`);
    setInterval(autoReporte, 15 * 60 * 1000);
});
