require('dotenv').config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const sherpa_onnx = require('sherpa-onnx-node');
const Groq = require("groq-sdk"); // Cambiamos a Groq por velocidad y para evitar el error 404 de Gemini

const app = express();
app.use(express.json());

// ======= CONFIGURACIÓN DE RUTAS =======
// Esto asegura que encuentre los modelos en Koyeb
const modelPath = path.join(__dirname, "modelos", "vits-piper-es_CO-salome-low", "es_CO-salome-low.onnx");
const tokensPath = path.join(__dirname, "modelos", "vits-piper-es_CO-salome-low", "tokens.txt");
const dataDirPath = path.join(__dirname, "modelos", "vits-piper-es_CO-salome-low", "espeak-ng-data");

const SHERPA_CONFIG = {
    vits: {
        model: modelPath,
        tokens: tokensPath,
        dataDir: dataDirPath,
    },
    modelType: "vits",
    numThreads: 2,
    debug: 0,
};

// ======= INICIALIZACIÓN DE GROQ (Más estable) =======
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function redactarIA(prompt) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "Eres Salomé, locutora de La Fronterísima en Pereira. Estilo alegre y profesional." },
                { role: "user", content: prompt }
            ],
            model: "llama-3.3-70b-versatile",
        });
        return completion.choices[0]?.message?.content || "Sintoniza La Fronterísima.";
    } catch (e) {
        return "Transmitiendo desde Pereira, esta es La Fronterísima.";
    }
}

// ======= BOT DE TELEGRAM (EVITAR CONFLICTO 409) =======
let bot;
function startBot() {
    if (bot) bot.stopPolling();
    bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
    
    bot.on('polling_error', (err) => {
        if (err.message.includes('409 Conflict')) {
            console.log("⚠️ Conflicto de Bot detectado. Reintentando en 10s...");
            bot.stopPolling();
            setTimeout(startBot, 10000); // Espera a que la instancia vieja muera
        }
    });
}
startBot();

// ======= MOTOR DE VOZ =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(modelPath)) {
            return reject(new Error(`🚨 MODELO NO ENCONTRADO EN: ${modelPath}`));
        }
        try {
            const tts = new sherpa_onnx.OfflineTts(SHERPA_CONFIG);
            const audio = tts.generate({ text: texto, sid: 0, speed: 1.0 });
            audio.save(archivoDestino);
            resolve();
        } catch (e) { reject(e); }
    });
}

// ======= RUTAS DE SERVIDOR =======
app.get('/health', (req, res) => res.status(200).send("OK"));

app.listen(8000, "0.0.0.0", () => {
    console.log(`
    =========================================
    📻 LA FRONTERÍSIMA - ENGINE REPARADO
    🚀 Puerto: 8000 | Motor: Groq + Sherpa
    =========================================
    `);
});
