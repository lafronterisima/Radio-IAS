require('dotenv').config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const TelegramBot = require('node-telegram-bot-api');
const sherpa_onnx = require('sherpa-onnx-node');
const Groq = require("groq-sdk");

const app = express();
app.use(express.json());

// ======= CONFIGURACIÓN DE RUTAS Y API =======
const KEYS = {
    AZURA: process.env.AZURA_KEY?.trim(),
    STATION_ID: process.env.STATION_ID || "24",
    GROQ: process.env.GROQ_API_KEY?.trim(),
    TELEGRAM: process.env.TELEGRAM_TOKEN?.trim()
};

const modelPath = path.join(__dirname, "modelos", "vits-piper-es_CO-salome-low", "es_CO-salome-low.onnx");
const tokensPath = path.join(__dirname, "modelos", "vits-piper-es_CO-salome-low", "tokens.txt");
const dataDirPath = path.join(__dirname, "modelos", "vits-piper-es_CO-salome-low", "espeak-ng-data");

const SHERPA_CONFIG = {
    vits: { model: modelPath, tokens: tokensPath, dataDir: dataDirPath },
    modelType: "vits",
    numThreads: 2,
    debug: 0,
};

const groq = new Groq({ apiKey: KEYS.GROQ });

// ======= MOTOR DE REDACCIÓN (GROQ) =======
async function redactarIA(prompt) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "Eres Salomé, locutora de La Fronterísima en Pereira. Estilo alegre, profesional y muy breve (máximo 20 segundos de habla)." },
                { role: "user", content: prompt }
            ],
            model: "llama-3.3-70b-versatile",
        });
        return completion.choices[0]?.message?.content || "Sintoniza La Fronterísima, la radio que te mueve.";
    } catch (e) {
        return "Acompañándote con la mejor energía, esta es La Fronterísima.";
    }
}

// ======= MOTOR DE VOZ (SHERPA) =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(modelPath)) return reject(new Error(`Modelo ausente en: ${modelPath}`));
        try {
            const tts = new sherpa_onnx.OfflineTts(SHERPA_CONFIG);
            const audio = tts.generate({ text: texto, sid: 0, speed: 1.0 });
            audio.save(archivoDestino);
            resolve();
        } catch (e) { reject(e); }
    });
}

// ======= SUBIDA A AZURACAST =======
async function subirAAzura(archivoLocal, nombreRemoto) {
    try {
        const form = new FormData();
        form.append('path', ''); // Sube a la raíz de Media
        form.append('file', fs.createReadStream(archivoLocal), { filename: nombreRemoto });

        const url = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;
        
        await axios.post(url, form, {
            headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
            timeout: 60000
        });
        
        console.log(`✅ Archivo ${nombreRemoto} subido a AzuraCast.`);
        if (fs.existsSync(archivoLocal)) fs.unlinkSync(archivoLocal);
    } catch (e) {
        console.error("❌ Error subiendo a AzuraCast:", e.response?.data || e.message);
    }
}

// ======= TAREA AUTOMÁTICA (CADA 15 MINUTOS) =======
async function ejecutarCicloRadio() {
    console.log("🎙️ Iniciando generación de saludo automático...");
    const hora = new Date().toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit', hour12: true });
    
    const guion = await redactarIA(`Saluda a la audiencia de Pereira, menciona que son las ${hora} y que están en La Fronterísima.`);
    const tempFile = path.join(__dirname, `auto_dj_${Date.now()}.wav`);

    try {
        await generarVoz(guion, tempFile);
        // Lo subimos con un nombre fijo para que AzuraCast lo identifique siempre igual (ej: auto_dj.wav)
        await subirAAzura(tempFile, "auto_dj.wav");
    } catch (e) {
        console.error("🚨 Error en ciclo automático:", e.message);
    }
}

// ======= BOT DE TELEGRAM (ANTICONFLICTO) =======
let bot;
function startBot() {
    if (bot) bot.stopPolling();
    bot = new TelegramBot(KEYS.TELEGRAM, { polling: true });
    bot.on('polling_error', (err) => {
        if (err.message.includes('409 Conflict')) {
            bot.stopPolling();
            setTimeout(startBot, 10000);
        }
    });
}
startBot();

// ======= SERVIDOR Y RUTAS =======
app.get('/health', (req, res) => res.status(200).send("OK"));

app.listen(8000, "0.0.0.0", () => {
    console.log(`
    =========================================
    📻 LA FRONTERÍSIMA - SISTEMA AUTOMÁTICO
    🚀 Puerto: 8000 | Motor: Groq + Sherpa
    ⏰ Ciclo: Cada 15 minutos
    =========================================
    `);

    // Iniciar ciclo: Primero a los 10 segundos de arrancar, luego cada 15 min
    setTimeout(ejecutarCicloRadio, 10000); 
    setInterval(ejecutarCicloRadio, 15 * 60 * 1000); 
});
