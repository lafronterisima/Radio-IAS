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
// Servir archivos estáticos (para el panel de control)
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN DE LLAVES Y ENTORNO =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = { 
    GEMINI: safeTrim(process.env.GEMINI_API_KEY),
    GROQ: safeTrim(process.env.GROQ_API_KEY),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD), // Tu contraseña en el .env
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

// Configuración Sherpa-ONNX (Voz Salomé local)
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

// ======= 2. TELEGRAM (CONTROL DE SALUDOS) =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
let ultimoSaludo = { texto: "", fecha: null };

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    ultimoSaludo = { texto: msg.text, fecha: new Date() };
    bot.sendMessage(msg.chat.id, "¡Recibido! Salomé procesará tu mensaje para La Fronterísima.");
});

// ======= 3. FUNCIONES DE APOYO =======

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios", titulo: "excelente música" };
    } catch (e) { return { artista: "varios", titulo: "su música favorita" }; }
}

function limpiarTexto(t) {
    if (!t) return "";
    return t.replace(/[*#_~]/g, '').replace(/Locutor:|Guion:|Respuesta:|Salomé:|Gemini:/gi, '').trim();
}

// ======= 4. REDACCIÓN CON IA (GEMINI / GROQ) =======

async function redactarIA(prompt) {
    const systemPrompt = "Eres Salomé, locutora de la emisora La Fronterísima. Habla en español de Colombia, tono profesional, alegre y dinámico. No uses etiquetas de guion.";
    
    if (KEYS.GEMINI) {
        try {
            const genAI = new GoogleGenerativeAI(KEYS.GEMINI);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent(`${systemPrompt}\n\n${prompt}`);
            return limpiarTexto(result.response.text());
        } catch (e) { console.log("⚠️ Gemini offline, intentando respaldo..."); }
    }

    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }]
        }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 7000 });
        return limpiarTexto(res.data.choices[0].message.content);
    } catch (e) { return "En sintonía con tus sentidos, suena La Fronterísima."; }
}

// ======= 5. MOTOR DE VOZ (EXCLUSIVO SHERPA-ONNX) =======

async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        try {
            console.log(`🎙️ Sherpa-ONNX procesando: "${texto.substring(0, 30)}..."`);
            const tts = new sherpa_onnx.OfflineTts(SHERPA_CONFIG);
            const audio = tts.generate({ text: texto, sid: 0, speed: 1.0 });
            
            const wavPath = archivoDestino.replace('.mp3', '.wav');
            audio.save(wavPath);

            // Convertir a MP3 para compatibilidad total con AzuraCast
            exec(`ffmpeg -y -i ${wavPath} -acodec libmp3lame -b:a 128k ${archivoDestino}`, (err) => {
                if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
                if (err) {
                    console.error("❌ Error FFmpeg:", err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        } catch (e) { 
            console.error("❌ Error crítico en Sherpa-ONNX:", e);
            reject(e); 
        }
    });
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondo = "fondo.mp3"; // Asegúrate de tener este archivo en la raíz
    
    let cmd = (conFondo && fs.existsSync(fondo))
        ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.10,atrim=duration=120[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;

    try {
        await new Promise((resolve, reject) => exec(cmd, (err) => err ? reject(err) : resolve()));
        
        const form = new FormData();
        form.append('path', ''); 
        form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
        
        await axios.post(AZURA_API_UPLOAD, form, { 
            headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, 
            timeout: 90000 
        });

        console.log(`🚀 ${nombreFinal} subido con éxito a AzuraCast.`);
        // Limpieza de temporales
        [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
    } catch (e) { 
        console.error("❌ Error en subida Azura:", e.message); 
    }
}

// ======= 6. RUTAS Y LOGIN =======

// Ruta de Login (Contraseña en inglés según pedido)
app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === KEYS.PASSWORD) {
        return res.json({ success: true, message: "Login successful" });
    }
    return res.status(401).json({ success: false, message: "Invalid password" });
});

// Ruta Manual Protegida
app.post("/procesar-locucion", async (req, res) => {
    const { texto, conFondo, password } = req.body;
    
    // Verificación de seguridad simple
    if (password !== KEYS.PASSWORD) {
        return res.status(403).send("Unauthorized");
    }

    const pathVoz = `v_man_${Date.now()}.mp3`;
    try {
        await generarVoz(texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", conFondo);
        res.send("Locución procesada y subida.");
    } catch (e) { 
        res.status(500).send("Error en el procesamiento."); 
    }
});

// ======= 7. AUTOMATIZACIÓN (TAREAS PROGRAMADAS) =======

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=4.81&longitude=-75.69&current_weather=true"); // Coordenadas Pereira
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 40 * 60 * 1000)) 
            ? ` Un oyente nos dice: "${ultimoSaludo.texto}".` : "";

        const prompt = `Hora actual: ${hora}. Clima en Pereira: ${Math.round(clim.data.current_weather.temperature)}°C. Sonando ahora: ${np.titulo} de ${np.artista}.${extras} Haz un comentario breve y fluye hacia la música.`;
        
        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        ultimoSaludo.fecha = null; 
    } catch (e) { console.error("Error en AutoReporte:", e.message); }
}

async function autoRedactorIA() {
    try {
        const prompt = `Cuenta una curiosidad de la música de los 80 o una reflexión sobre la radio online. Sé breve (60 palabras).`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_red_${Date.now()}.mp3`;
        
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
    } catch (e) { console.error("Error en AutoRedactor:", e.message); }
}

// ======= 8. ARRANQUE DEL SERVIDOR =======

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`
    --------------------------------------------------
    📻 LA FRONTERÍSIMA - RADIO COGNITIVA ONLINE
    🚀 Puerto: ${PORT}
    🎙️ TTS: Sherpa-ONNX (Offline)
    🧠 IA: Gemini 1.5 Flash
    --------------------------------------------------
    `);
    
    // Ejecuciones iniciales
    setTimeout(autoReporte, 5000); 
    setTimeout(autoRedactorIA, 25000);

    // Ciclos automáticos
    setInterval(autoReporte, 30 * 60 * 1000);   // Cada 30 min
    setInterval(autoRedactorIA, 60 * 60 * 1000); // Cada 60 min
});
