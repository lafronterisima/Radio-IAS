require('dotenv').config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const TelegramBot = require('node-telegram-bot-api');
const sherpa_onnx = require('sherpa-onnx-node');
const Groq = require("groq-sdk");

// Configuración de FFmpeg usando tus dependencias estáticas
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json());

// ======= 1. CONFIGURACIÓN DE ENTORNO =======
const KEYS = {
    GROQ: process.env.GROQ_API_KEY?.trim(),
    AZURA: process.env.AZURA_KEY?.trim(),
    STATION_ID: process.env.STATION_ID || "24",
    PASSWORD: process.env.APP_PASSWORD?.trim(),
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN?.trim(),
    CODEC: process.env.AUDIO_CODEC || "libmp3lame",
    BITRATE: process.env.AUDIO_BITRATE || "128k"
};

const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;
const groq = new Groq({ apiKey: KEYS.GROQ });

// Rutas absolutas para evitar errores en Koyeb/Docker
const modelBase = path.resolve(__dirname, "modelos/vits-piper-es_CO-salome-low");
const SHERPA_CONFIG = {
    vits: {
        model: path.join(modelBase, "es_CO-salome-low.onnx"),
        tokens: path.join(modelBase, "tokens.txt"),
        dataDir: path.join(modelBase, "espeak-ng-data"),
    },
    modelType: "vits",
    numThreads: 2,
    debug: 0,
};

// ======= 2. TELEGRAM BOT (CON ANTICONFLICTO) =======
let bot;
let ultimoSaludo = { texto: "", fecha: null };

setTimeout(() => {
    try {
        bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
        bot.on('message', (msg) => {
            if (!msg.text || msg.text.startsWith('/')) return;
            ultimoSaludo = { texto: msg.text, fecha: new Date() };
            bot.sendMessage(msg.chat.id, "¡Recibido! Salomé lo mencionará pronto en la radio.");
        });
        bot.on('polling_error', (err) => {
            if (!err.message.includes('409 Conflict')) console.error("Telegram Error:", err.message);
        });
        console.log("🤖 Bot de Telegram sincronizado.");
    } catch (e) { console.error("⚠️ Error inicializando Bot:", e.message); }
}, 8000); // Retraso para evitar el error 409 al reiniciar en Koyeb

// ======= 3. REDACCIÓN CON GROQ =======
async function redactarIA(prompt) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "Eres Salomé, locutora de La Fronterísima en Pereira. Estilo colombiano, profesional y alegre. No uses etiquetas ni emojis." },
                { role: "user", content: prompt }
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.7,
        });
        return completion.choices[0]?.message?.content.trim();
    } catch (e) {
        console.error("⚠️ Groq Error:", e.message);
        return "Sintoniza La Fronterísima, la radio que te mueve desde Pereira.";
    }
}

// ======= 4. MOTOR DE AUDIO (SHERPA + FFMPEG) =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(SHERPA_CONFIG.vits.model)) {
            return reject(new Error(`Modelo ausente en: ${SHERPA_CONFIG.vits.model}`));
        }
        try {
            const tts = new sherpa_onnx.OfflineTts(SHERPA_CONFIG);
            const audio = tts.generate({ text: texto, sid: 0, speed: 1.0 });
            const wavPath = archivoDestino.replace('.mp3', '.wav');
            audio.save(wavPath);

            ffmpeg(wavPath)
                .audioCodec(KEYS.CODEC)
                .audioBitrate(KEYS.BITRATE)
                .on('end', () => {
                    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
                    resolve();
                })
                .on('error', (err) => reject(err))
                .save(archivoDestino);
        } catch (e) { reject(e); }
    });
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondo = "fondo.mp3";
    
    return new Promise((resolve, reject) => {
        let command = ffmpeg();
        if (conFondo && fs.existsSync(fondo)) {
            command = command.input(fondo).input(archivoVoz)
                .complexFilter(['[0:a]volume=0.08,atrim=duration=60[bg]', '[1:a]volume=1.8[v]', '[bg][v]amix=inputs=2:duration=shortest']);
        } else {
            command = command.input(archivoVoz).audioFilters('volume=1.6');
        }

        command.audioCodec(KEYS.CODEC).audioBitrate(KEYS.BITRATE)
            .on('end', async () => {
                try {
                    const form = new FormData();
                    form.append('path', '');
                    form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                    await axios.post(AZURA_API_UPLOAD, form, {
                        headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
                        timeout: 90000
                    });
                    [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                    resolve();
                } catch (e) { reject(e); }
            })
            .on('error', (err) => reject(err))
            .save(tempSalida);
    });
}

// ======= 5. RUTAS Y AUTOMATIZACIÓN =======
app.get('/health', (req, res) => res.status(200).send("OK"));

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === KEYS.PASSWORD) return res.json({ status: "success", message: "Login successful" });
    res.status(401).json({ status: "error", message: "Invalid password" });
});

async function autoLocucion() {
    console.log("🎙️ Generando locución automática...");
    try {
        const hora = new Date().toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit', hour12: true });
        let prompt = `Anuncia que son las ${hora} en La Fronterísima.`;
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            prompt += ` Saluda al oyente que escribió: "${ultimoSaludo.texto}"`;
            ultimoSaludo.fecha = null;
        }
        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        console.log("✅ Locución automática enviada a AzuraCast.");
    } catch (e) { console.error("❌ Error en Automática:", e.message); }
}

// ======= 6. ARRANQUE =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`-----------------------------------------`);
    console.log(`📻 LA FRONTERÍSIMA IA ENGINE ONLINE`);
    console.log(`🚀 Puerto: ${PORT} | Motor: Groq + Sherpa`);
    console.log(`-----------------------------------------`);
    setInterval(autoLocucion, 30 * 60 * 1000); 
    setTimeout(autoLocucion, 15000); 
});
