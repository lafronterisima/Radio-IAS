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

// ======= CONFIG =======
const KEYS = {
    AZURA: process.env.AZURA_KEY?.trim(),
    STATION_ID: process.env.STATION_ID || "24",
    GROQ: process.env.GROQ_API_KEY?.trim(),
    TELEGRAM: process.env.TELEGRAM_TOKEN?.trim()
};

const BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_CO/salome/low";

// ======= RUTAS =======
const modelDir = path.join(__dirname, "modelos", "vits-piper-es_CO-salome-low");
const modelPath = path.join(modelDir, "es_CO-salome-low.onnx");
const tokensPath = path.join(modelDir, "tokens.txt");
const dataDirPath = path.join(modelDir, "espeak-ng-data");

// ======= DESCARGA AUTOMÁTICA =======
async function descargarArchivo(url, destino) {
    const writer = fs.createWriteStream(destino);
    const response = await axios({ url, method: "GET", responseType: "stream" });
    response.data.pipe(writer);
    return new Promise((res, rej) => {
        writer.on("finish", res);
        writer.on("error", rej);
    });
}

async function asegurarModelo() {
    if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });

    if (!fs.existsSync(modelPath)) {
        console.log("⬇️ Descargando modelo...");
        await descargarArchivo(`${BASE_URL}/es_CO-salome-low.onnx`, modelPath);
    }

    if (!fs.existsSync(tokensPath)) {
        console.log("⬇️ Descargando tokens...");
        await descargarArchivo(`${BASE_URL}/tokens.txt`, tokensPath);
    }

    if (!fs.existsSync(dataDirPath)) {
        console.log("⬇️ Descargando espeak-ng-data...");
        fs.mkdirSync(dataDirPath, { recursive: true });

        const files = ["phonemes.txt", "voices.txt"];
        for (const f of files) {
            await descargarArchivo(`${BASE_URL}/espeak-ng-data/${f}`, path.join(dataDirPath, f));
        }
    }

    console.log("✅ Modelo listo");
}

// ======= SHERPA CONFIG =======
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

// ======= IA =======
async function redactarIA(prompt) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "Eres Salomé, locutora de La Fronterísima en Pereira. Breve y profesional." },
                { role: "user", content: prompt }
            ],
            model: "llama-3.3-70b-versatile",
        });

        return completion.choices[0]?.message?.content || "La Fronterísima, contigo siempre.";
    } catch (e) {
        console.error("❌ Groq:", e.message);
        return "La Fronterísima sigue contigo.";
    }
}

// ======= VOZ =======
async function generarVoz(texto, archivoDestino) {
    if (!fs.existsSync(modelPath)) throw new Error("Modelo no existe");

    const tts = new sherpa_onnx.OfflineTts(SHERPA_CONFIG);
    const audio = tts.generate({ text: texto, sid: 0, speed: 1.0 });
    audio.save(archivoDestino);
}

// ======= AZURACAST =======
async function subirAAzura(archivoLocal) {
    const form = new FormData();
    form.append('file', fs.createReadStream(archivoLocal));

    await axios.post(
        `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`,
        form,
        {
            headers: {
                ...form.getHeaders(),
                "X-API-Key": KEYS.AZURA
            }
        }
    );

    console.log("✅ Subido a AzuraCast");
    fs.unlinkSync(archivoLocal);
}

// ======= CICLO RADIO =======
async function ejecutarCicloRadio() {
    console.log("🎙️ Generando audio...");

    const hora = new Date().toLocaleTimeString("es-CO", {
        hour: '2-digit',
        minute: '2-digit'
    });

    const texto = await redactarIA(`Di la hora ${hora} en Pereira y saluda`);

    const temp = path.join(__dirname, "temp.wav");

    try {
        await generarVoz(texto, temp);
        await subirAAzura(temp);
    } catch (e) {
        console.error("🚨 Error ciclo:", e.message);
    }
}

// ======= TELEGRAM FIX =======
let bot;

async function limpiarTelegram() {
    try {
        await axios.get(`https://api.telegram.org/bot${KEYS.TELEGRAM}/deleteWebhook`);
        console.log("🧹 Telegram limpio");
    } catch {}
}

function startBot() {
    bot = new TelegramBot(KEYS.TELEGRAM, { polling: true });

    bot.on("polling_error", (err) => {
        if (err.message.includes("409")) {
            console.log("⚠️ Conflicto Telegram...");
            bot.stopPolling();
            setTimeout(startBot, 15000);
        }
    });

    bot.on("message", (msg) => {
        if (msg.text === "/start") {
            bot.sendMessage(msg.chat.id, "🎙️ Bienvenido a La Fronterísima");
        }
    });
}

// ======= SERVER =======
app.get('/health', (req, res) => res.send("OK"));

const PORT = process.env.PORT || 8000;

(async () => {
    await asegurarModelo();
    await limpiarTelegram();
    startBot();

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`
📻 LA FRONTERÍSIMA ONLINE
🚀 Puerto ${PORT}
⏰ AutoDJ cada 15 min
        `);

        setTimeout(ejecutarCicloRadio, 5000);
        setInterval(ejecutarCicloRadio, 15 * 60 * 1000);
    });
})();
