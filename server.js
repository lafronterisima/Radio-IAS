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

// Rutas de modelos corregidas para asegurar compatibilidad
const modelDir = path.join(__dirname, "modelos", "vits-piper-es_CO-salome-low");
const modelPath = path.join(modelDir, "es_CO-salome-low.onnx");
const tokensPath = path.join(modelDir, "tokens.txt");
const dataDirPath = path.join(modelDir, "espeak-ng-data");

const SHERPA_CONFIG = {
    vits: { 
        model: modelPath, 
        tokens: tokensPath, 
        dataDir: dataDirPath,
        noiseScale: 0.667,
        noiseW: 0.8,
        lengthScale: 1.0 
    },
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
        console.error("❌ Error en Groq:", e.message);
        return "Acompañándote con la mejor energía, esta es La Fronterísima.";
    }
}

// ======= MOTOR DE VOZ (SHERPA) =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(modelPath)) {
            return reject(new Error(`Modelo ausente en: ${modelPath}`));
        }
        try {
            // Se recomienda crear la instancia dentro para evitar fugas de memoria en algunos entornos
            const tts = new sherpa_onnx.OfflineTts(SHERPA_CONFIG);
            const audio = tts.generate({ text: texto, sid: 0, speed: 1.0 });
            audio.save(archivoDestino);
            resolve();
        } catch (e) { 
            reject(new Error(`Error en Sherpa-ONNX: ${e.message}`)); 
        }
    });
}

// ======= SUBIDA A AZURACAST =======
async function subirAAzura(archivoLocal, nombreRemoto) {
    try {
        if (!fs.existsSync(archivoLocal)) throw new Error("Archivo local no encontrado para subir.");

        const form = new FormData();
        // Importante: AzuraCast espera el parámetro 'path' o simplemente el archivo
        form.append('file', fs.createReadStream(archivoLocal));

        const url = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;
        
        await axios.post(url, form, {
            headers: { 
                ...form.getHeaders(), 
                "X-API-Key": KEYS.AZURA 
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        console.log(`✅ Archivo ${nombreRemoto} subido a AzuraCast.`);
        // Borramos el temporal después de confirmar la subida
        if (fs.existsSync(archivoLocal)) fs.unlinkSync(archivoLocal);
    } catch (e) {
        console.error("❌ Error subiendo a AzuraCast:", e.response?.data || e.message);
    }
}

// ======= TAREA AUTOMÁTICA =======
async function ejecutarCicloRadio() {
    console.log("🎙️ Iniciando generación de saludo automático...");
    const hora = new Date().toLocaleTimeString("es-CO", { hour: '2-digit', minute: '2-digit', hour12: true });
    
    const guion = await redactarIA(`Saluda a la audiencia de Pereira, menciona que son las ${hora} y que están en La Fronterísima.`);
    const tempFile = path.join(__dirname, `auto_dj_temp.wav`);

    try {
        await generarVoz(guion, tempFile);
        await subirAAzura(tempFile, "auto_dj.wav");
    } catch (e) {
        console.error("🚨 Error en ciclo automático:", e.message);
    }
}

// ======= BOT DE TELEGRAM (CON MANEJO DE CONFLICTO MEJORADO) =======
let bot;
function startBot() {
    if (bot) {
        console.log("🔄 Reiniciando bot de Telegram...");
    }
    
    bot = new TelegramBot(KEYS.TELEGRAM, { polling: true });

    bot.on('polling_error', (err) => {
        if (err.message.includes('409 Conflict')) {
            console.warn("⚠️ Conflicto de Telegram detectado (409). Reintentando en 15s...");
            bot.stopPolling();
            setTimeout(startBot, 15000); // Aumentamos a 15s para dar tiempo a que la otra instancia muera
        } else {
            console.error("❌ Error de polling:", err.message);
        }
    });

    bot.on('message', (msg) => {
        if (msg.text === '/start') {
            bot.sendMessage(msg.chat.id, "¡Hola! Soy Salomé de La Fronterísima. Pronto podré procesar tus pedidos.");
        }
    });
}

// Ejecutar bot
startBot();

// ======= SERVIDOR Y RUTAS =======
app.get('/health', (req, res) => res.status(200).send("Sistema Salomé Operativo ✅"));

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`
    =========================================
    📻 LA FRONTERÍSIMA - SISTEMA AUTOMÁTICO
    🚀 Puerto: ${PORT} | Motor: Groq + Sherpa
    ⏰ Ciclo: Cada 15 minutos
    =========================================
    `);

    setTimeout(ejecutarCicloRadio, 5000); 
    setInterval(ejecutarCicloRadio, 15 * 60 * 1000); 
});
