require('dotenv').config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const sherpa_onnx = require('sherpa-onnx-node');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN DE SEGURIDAD Y LLAVES =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = { 
    GEMINI: safeTrim(process.env.GEMINI_API_KEY),
    GROQ: safeTrim(process.env.GROQ_API_KEY),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD), // Password from .env
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN)
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

// Configuración Sherpa-ONNX (Local Offline TTS)
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

// ======= 2. TELEGRAM BOT (SALUDOS DE OYENTES) =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
let ultimoSaludo = { texto: "", fecha: null };

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    ultimoSaludo = { texto: msg.text, fecha: new Date() };
    bot.sendMessage(msg.chat.id, "¡Recibido! Salomé procesará tu mensaje para La Fronterísima.");
    console.log(`📩 Nuevo saludo recibido: ${msg.text}`);
});

// ======= 3. FUNCIONES DE APOYO (NOW PLAYING / LIMPIEZA) =======

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios", titulo: "música increíble" };
    } catch (e) { return { artista: "varios", titulo: "tu música favorita" }; }
}

function limpiarTexto(t) {
    if (!t) return "";
    return t.replace(/[*#_~]/g, '').replace(/Locutor:|Guion:|Respuesta:|Salomé:|Gemini:/gi, '').trim();
}

// ======= 4. REDACCIÓN CON INTELIGENCIA ARTIFICIAL =======

async function redactarIA(prompt) {
    const systemPrompt = "Eres Salomé, la locutora oficial de La Fronterísima en Colombia. Habla con entusiasmo, tono profesional y fluido. Usa español de Colombia sin exagerar.";
    
    if (KEYS.GEMINI) {
        try {
            const genAI = new GoogleGenerativeAI(KEYS.GEMINI);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent(`${systemPrompt}\n\n${prompt}`);
            return limpiarTexto(result.response.text());
        } catch (e) { console.log("⚠️ Gemini fail, checking backup..."); }
    }

    // Respaldo Groq/Llama
    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }]
        }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 7000 });
        return limpiarTexto(res.data.choices[0].message.content);
    } catch (e) { return "Transmitiendo desde el corazón de Colombia, esta es La Fronterísima."; }
}

// ======= 5. GENERACIÓN DE VOZ Y PRODUCCIÓN (SHERPA-ONNX) =======

async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        try {
            const tts = new sherpa_onnx.OfflineTts(SHERPA_CONFIG);
            const audio = tts.generate({ text: texto, sid: 0, speed: 1.0 });
            const wavPath = archivoDestino.replace('.mp3', '.wav');
            audio.save(wavPath);

            // Convert to MP3 using FFmpeg
            exec(`ffmpeg -y -i ${wavPath} -acodec libmp3lame -b:a 128k ${archivoDestino}`, (err) => {
                if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
                if (err) reject(err);
                else resolve();
            });
        } catch (e) { reject(e); }
    });
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondo = "fondo.mp3";
    
    // Si hay fondo y existe, mezclamos. Si no, solo subimos la voz normalizada.
    let cmd = (conFondo && fs.existsSync(fondo))
        ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.09,atrim=duration=100[bg];[1:a]volume=1.7[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.5" -c:a libmp3lame -b:a 128k ${tempSalida}`;

    try {
        await new Promise((resolve, reject) => exec(cmd, (err) => err ? reject(err) : resolve()));
        
        const form = new FormData();
        form.append('path', ''); 
        form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
        
        await axios.post(AZURA_API_UPLOAD, form, { 
            headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, 
            timeout: 60000 
        });

        console.log(`✅ ${nombreFinal} uploaded to AzuraCast.`);
        // Limpieza
        [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
    } catch (e) { console.error("❌ Upload Error:", e.message); }
}

// ======= 6. LOGIN & ROUTES (ENGLISH) =======

app.post('/login', (req, res) => {
    const { password } = req.body;
    console.log(`[Auth] Login attempt received.`);
    
    if (password === KEYS.PASSWORD) {
        res.status(200).json({ status: "success", message: "Login successful" });
    } else {
        res.status(401).json({ status: "error", message: "Invalid password" });
    }
});

app.post("/procesar-locucion", async (req, res) => {
    const { texto, conFondo, password } = req.body;
    if (password !== KEYS.PASSWORD) return res.status(403).send("Forbidden");

    const pathVoz = `v_man_${Date.now()}.mp3`;
    try {
        await generarVoz(texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", conFondo);
        res.send("Success");
    } catch (e) { res.status(500).send("Error"); }
});

app.get("/health", (req, res) => res.sendStatus(200));

// ======= 7. AUTOMATION TASKS (REPORT & REFLECTION) =======

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=4.81&longitude=-75.69&current_weather=true");
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 40 * 60 * 1000)) 
            ? ` Un oyente nos escribió esto: "${ultimoSaludo.texto}". Mándale un saludo.` : "";

        const prompt = `Son las ${hora}. El clima en Pereira es ${Math.round(clim.data.current_weather.temperature)}°C. Estamos escuchando a ${np.artista} con ${np.titulo}.${extras} Haz una locución corta y enérgica.`;
        
        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        ultimoSaludo.fecha = null; // Clear greeting after use
    } catch (e) { console.error("AutoReport error:", e.message); }
}

async function autoRedactorIA() {
    try {
        const prompt = `Genera una reflexión breve sobre la música o un dato curioso de un artista famoso. Máximo 60 palabras.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_red_${Date.now()}.mp3`;
        
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
    } catch (e) { console.error("AutoRedactor error:", e.message); }
}

// ======= 8. SERVER START =======

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`
    ==================================================
    🎙️  LA FRONTERÍSIMA - AI RADIO ENGINE START
    🌐  Port: ${PORT}
    🔈  TTS Mode: SHERPA-ONNX (Local)
    🛡️  Login: English Enabled
    ==================================================
    `);
    
    // Initial runs
    setTimeout(autoReporte, 5000); 
    setTimeout(autoRedactorIA, 20000);

    // Loops
    setInterval(autoReporte, 15 * 60 * 1000);    // Every 30 mins
    setInterval(autoRedactorIA, 60 * 60 * 1000);  // Every 60 mins
});
