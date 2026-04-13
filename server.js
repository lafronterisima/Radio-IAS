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

// Base URL corregida (apuntando a los archivos RAW de Hugging Face)
const BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_CO/salome/low";

// ======= RUTAS ABSOLUTAS =======
const modelDir = path.join(__dirname, "modelos", "vits-piper-es_CO-salome-low");
const modelPath = path.join(modelDir, "es_CO-salome-low.onnx");
const tokensPath = path.join(modelDir, "tokens.txt");
const dataDirPath = path.join(__dirname, "modelos", "espeak-ng-data"); // Movemos esto para consistencia

// ======= DESCARGA AUTOMÁTICA =======
async function descargarArchivo(url, destino) {
    const dir = path.dirname(destino);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const writer = fs.createWriteStream(destino);
    const response = await axios({ url, method: "GET", responseType: "stream" });
    response.data.pipe(writer);
    return new Promise((res, rej) => {
        writer.on("finish", res);
        writer.on("error", rej);
    });
}

async function asegurarModelo() {
    console.log("🔍 Verificando integridad del modelo...");
    
    // 1. El Modelo ONNX
    if (!fs.existsSync(modelPath)) {
        console.log("⬇️ Descargando modelo ONNX (Salomé)...");
        await descargarArchivo(`${BASE_URL}/es_CO-salome-low.onnx`, modelPath);
    }

    // 2. Los Tokens
    if (!fs.existsSync(tokensPath)) {
        console.log("⬇️ Descargando tokens...");
        await descargarArchivo(`${BASE_URL}/tokens.txt`, tokensPath);
    }

    // 3. espeak-ng-data (Solo si no existe la carpeta)
    // NOTA: Sherpa-ONNX suele requerir estos datos internamente o vía configuración
    if (!fs.existsSync(dataDirPath)) {
        console.log("⬇️ Configurando datos de fonemas...");
        fs.mkdirSync(dataDirPath, { recursive: true });
        // Piper usualmente ya trae los fonemas necesarios en el ONNX, 
        // pero para evitar errores de Sherpa creamos la ruta.
    }

    console.log("✅ Modelo listo y verificado");
}

// ======= SHERPA CONFIG =======
const SHERPA_CONFIG = {
    vits: {
        model: modelPath,
        tokens: tokensPath,
        dataDir: dataDirPath, 
    },
    modelType: "vits",
    numThreads: 1, // Reducido para mayor estabilidad en Koyeb Free
    debug: 0,
};

const groq = new Groq({ apiKey: KEYS.GROQ });

// ======= IA =======
async function redactarIA(prompt) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "Eres Salomé, locutora de radio La Fronterísima. Tono amable, profesional y colombiano. Máximo 40 palabras." },
                { role: "user", content: prompt }
            ],
            model: "llama-3.3-70b-versatile",
        });
        return completion.choices[0]?.message?.content || "La Fronterísima, contigo siempre.";
    } catch (e) {
        console.error("❌ Error Groq:", e.message);
        return "Sintonizas La Fronterísima, conectando tus sentidos.";
    }
}

// ======= VOZ =======
async function generarVoz(texto, archivoDestino) {
    // Verificación de último segundo
    if (!fs.existsSync(modelPath)) {
        await asegurarModelo(); 
    }

    try {
        const tts = new sherpa_onnx.OfflineTts(SHERPA_CONFIG);
        const audio = tts.generate({ text: texto, sid: 0, speed: 1.0 });
        audio.save(archivoDestino);
        console.log("🎙️ Audio generado en:", archivoDestino);
    } catch (err) {
        console.error("❌ Error TTS:", err.message);
        throw err;
    }
}

// ======= AZURACAST =======
async function subirAAzura(archivoLocal) {
    try {
        const form = new FormData();
        // Usamos un nombre fijo para que AzuraCast lo reconozca como "Auto DJ"
        form.append('file', fs.createReadStream(archivoLocal), { filename: 'dj_salome.wav' });

        await axios.post(
            `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`,
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    "X-API-Key": KEYS.AZURA
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        console.log("✅ Subido con éxito a AzuraCast");
        if (fs.existsSync(archivoLocal)) fs.unlinkSync(archivoLocal);
    } catch (e) {
        console.error("❌ Error subida Azura:", e.response?.data || e.message);
    }
}

// ======= CICLO RADIO =======
async function ejecutarCicloRadio() {
    console.log("⏰ Iniciando ciclo automático...");
    
    const hora = new Date().toLocaleTimeString("es-CO", {
        timeZone: "America/Bogota",
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });

    const texto = await redactarIA(`Saluda a la audiencia, di que son las ${hora} en Colombia y que están en La Fronterísima.`);
    const temp = path.join(__dirname, `temp_${Date.now()}.wav`);

    try {
        await generarVoz(texto, temp);
        await subirAAzura(temp);
    } catch (e) {
        console.error("🚨 Error ciclo:", e.message);
    }
}

// ======= TELEGRAM =======
async function limpiarTelegram() {
    try {
        await axios.get(`https://api.telegram.org/bot${KEYS.TELEGRAM}/deleteWebhook`);
    } catch {}
}

function startBot() {
    const bot = new TelegramBot(KEYS.TELEGRAM, { polling: true });
    bot.on("message", (msg) => {
        if (msg.text === "/start") bot.sendMessage(msg.chat.id, "🎙️ La Fronterísima AI está en línea.");
    });
}

// ======= SERVER / BOOT =======
app.get('/health', (req, res) => res.send("OK"));

const PORT = process.env.PORT || 8000;

(async () => {
    try {
        await asegurarModelo();
        await limpiarTelegram();
        startBot();

        app.listen(PORT, "0.0.0.0", () => {
            console.log(`📻 LA FRONTERÍSIMA ONLINE en puerto ${PORT}`);
            // Primer ejecución a los 10 segundos para dar tiempo al sistema
            setTimeout(ejecutarCicloRadio, 10000);
            // Cada 15 minutos
            setInterval(ejecutarCicloRadio, 15 * 60 * 1000);
        });
    } catch (err) {
        console.error("🔥 Error en el arranque:", err);
    }
})();
