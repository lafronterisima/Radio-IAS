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

// Configuración de Sherpa-ONNX (Voz de Salomé)
const SHERPA_CONFIG = {
    vits: {
        model: "./modelos/vits-piper-es_CO-salome-low/es_CO-salome-low.onnx",
        tokens: "./modelos/vits-piper-es_CO-salome-low/tokens.txt",
        dataDir: "./modelos/vits-piper-es_CO-salome-low/espeak-ng-data",
    },
    modelType: "vits",
    numThreads: 2,
    debug: 0,
};

// ======= 2. TELEGRAM BOT (SALUDOS) =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
let ultimoSaludo = { texto: "", fecha: null };

bot.on('message', (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    ultimoSaludo = { texto: msg.text, fecha: new Date() };
    bot.sendMessage(msg.chat.id, "¡Recibido! Salomé lo presentará pronto en La Fronterísima.");
});

// ======= 3. MOTOR DE AUDIO (SHERPA + FFMPEG) =======

async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
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

                    console.log(`✅ [${nombreFinal}] subido correctamente.`);
                    [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                    resolve();
                } catch (e) { reject(e); }
            })
            .on('error', (err) => reject(err))
            .save(tempSalida);
    });
}

// ======= 4. INTELIGENCIA ARTIFICIAL (GEMINI) =======

async function redactarIA(prompt) {
    try {
        const genAI = new GoogleGenerativeAI(KEYS.GEMINI);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const system = "Eres Salomé, locutora dinámica de La Fronterísima. Habla en español de Colombia. Sé breve y profesional.";
        const result = await model.generateContent(`${system}\n\n${prompt}`);
        return result.response.text().replace(/[*#_~]/g, '').trim();
    } catch (e) { 
        return "Sintoniza la mejor energía con La Fronterísima, siempre contigo."; 
    }
}

// ======= 5. RUTAS Y AUTENTICACIÓN =======

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

// ======= 6. AUTOMATIZACIÓN DE LA EMISORA =======

async function autoLocucion() {
    try {
        const hora = new Date().toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit' });
        let prompt = `Anuncia que son las ${hora} en La Fronterísima.`;
        
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            prompt += ` Además, saluda al oyente que dijo: "${ultimoSaludo.texto}"`;
            ultimoSaludo.fecha = null;
        }

        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
    } catch (e) { console.error("Error en autoLocucion:", e.message); }
}

// ======= 7. LANZAMIENTO =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`-----------------------------------------`);
    console.log(`📻 LA FRONTERÍSIMA IA ENGINE ONLINE`);
    console.log(`🚀 Puerto: ${PORT} | Motor: Sherpa-ONNX`);
    console.log(`-----------------------------------------`);
    
    // Ciclos automáticos
    setInterval(autoLocucion, 30 * 60 * 1000); // Cada 30 minutos
    setTimeout(autoLocucion, 10000); // Primera ejecución a los 10s
});
