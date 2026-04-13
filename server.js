require('dotenv').config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const TelegramBot = require('node-telegram-bot-api');
const sherpa_onnx = require('sherpa-onnx-node');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Configuración de FFmpeg usando tus dependencias estáticas
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN DE ENTORNO =======
const safeTrim = (val) => val ? val.trim() : "";
const KEYS = {
    GEMINI: safeTrim(process.env.GEMINI_API_KEY),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: (process.env.STATION_ID || "24").replace(/\D/g, ""),
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    CODEC: safeTrim(process.env.AUDIO_CODEC) || "libmp3lame",
    BITRATE: safeTrim(process.env.AUDIO_BITRATE) || "128k"
};

const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;

// ======= 2. CONFIGURACIÓN SHERPA-ONNX (CORREGIDA) =======
// El error "Please provide exactly one tts model" ocurre si las rutas son nulas o incorrectas.
const modelBase = path.join(__dirname, "modelos", "vits-piper-es_CO-salome-low");

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

// ======= 3. TELEGRAM BOT =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
let ultimoSaludo = { texto: "", fecha: null };

bot.on('message', (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    ultimoSaludo = { texto: msg.text, fecha: new Date() };
    bot.sendMessage(msg.chat.id, "¡Recibido! Salomé lo presentará pronto en La Fronterísima.");
});

// ======= 4. MOTOR DE AUDIO =======

async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        try {
            // Verificación de archivos antes de iniciar Sherpa
            if (!fs.existsSync(SHERPA_CONFIG.vits.model)) {
                return reject(new Error(`Modelo no encontrado en: ${SHERPA_CONFIG.vits.model}`));
            }

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
            command = command
                .input(fondo)
                .input(archivoVoz)
                .complexFilter([
                    '[0:a]volume=0.08,atrim=duration=120[bg]',
                    '[1:a]volume=1.8[v]',
                    '[bg][v]amix=inputs=2:duration=shortest'
                ]);
        } else {
            command = command.input(archivoVoz).audioFilters('volume=1.6');
        }

        command
            .audioCodec(KEYS.CODEC)
            .audioBitrate(KEYS.BITRATE)
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

// ======= 5. INTELIGENCIA ARTIFICIAL =======

async function redactarIA(prompt) {
    try {
        const genAI = new GoogleGenerativeAI(KEYS.GEMINI);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const system = "Eres Salomé, locutora de La Fronterísima. Habla en español de Colombia, dinámica y breve.";
        const result = await model.generateContent(`${system}\n\n${prompt}`);
        return result.response.text().replace(/[*#_~]/g, '').trim();
    } catch (e) { 
        console.error("⚠️ IA Error:", e.message);
        return "Sintoniza La Fronterísima, la radio que te mueve."; 
    }
}

// ======= 6. RUTAS (LOGIN EN INGLÉS) =======

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === KEYS.PASSWORD) {
        res.status(200).json({ status: "success", message: "Login successful" });
    } else {
        res.status(401).json({ status: "error", message: "Invalid password" });
    }
});

app.post("/procesar-locucion", async (req, res) => {
    const { texto, conFondo, password } = req.body;
    if (password !== KEYS.PASSWORD) return res.status(403).json({ error: "Forbidden" });

    const pathVoz = `v_man_${Date.now()}.mp3`;
    try {
        await generarVoz(texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", conFondo);
        res.json({ message: "Success" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======= 7. AUTOMATIZACIÓN =======

async function autoLocucion() {
    try {
        const hora = new Date().toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit', hour12: true });
        let prompt = `Anuncia que son las ${hora} en La Fronterísima.`;
        
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            prompt += ` Saluda a un oyente que envió un mensaje: "${ultimoSaludo.texto}"`;
            ultimoSaludo.fecha = null;
        }

        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        console.log("✅ Reporte automático generado.");
    } catch (e) { console.error("❌ Error Auto:", e.message); }
}

// ======= 8. LANZAMIENTO =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`-----------------------------------------`);
    console.log(`📻 LA FRONTERÍSIMA IA ENGINE ONLINE`);
    console.log(`🚀 Puerto: ${PORT} | Motor: Sherpa-ONNX`);
    console.log(`-----------------------------------------`);
    
    setInterval(autoLocucion, 30 * 60 * 1000); 
    setTimeout(autoLocucion, 10000); 
});
