require('dotenv').config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const { pipeline } = require('stream/promises');
const sherpa_onnx = require('sherpa-onnx-node');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = { 
    GEMINI: safeTrim(process.env.GEMINI_API_KEY),
    GROQ: safeTrim(process.env.GROQ_API_KEY),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    JAMENDO_ID: safeTrim(process.env.JAMENDO_CLIENT_ID) || "c230e1f4"
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

// Configuración Sherpa-ONNX (Voz Salomé local)
const SHERPA_CONFIG = {
    vits: {
        model: "./modelos/vits-piper-es_CO-salome-medium/es_CO-salome-medium.onnx",
        tokens: "./modelos/vits-piper-es_CO-salome-medium/tokens.txt",
        dataDir: "./modelos/vits-piper-es_CO-salome-medium/espeak-ng-data",
    },
    modelType: "vits",
    numThreads: 2,
    debug: 0,
};

// ======= 2. TELEGRAM (SALUDOS) =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
let ultimoSaludo = { texto: "", fecha: null };

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    ultimoSaludo = { texto: msg.text, fecha: new Date() };
    bot.sendMessage(msg.chat.id, "¡Recibido! Tu mensaje saldrá pronto al aire en La Fronterísima.");
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

// ======= 4. IA (GEMINI + RESPALDO) =======

async function redactarIA(prompt) {
    const systemPrompt = "Eres el locutor de La Fronterísima. Habla en español de Colombia, tono profesional y dinámico. No uses jerga pesada.";
    
    if (KEYS.GEMINI) {
        try {
            const genAI = new GoogleGenerativeAI(KEYS.GEMINI);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent(`${systemPrompt}\n\n${prompt}`);
            return limpiarTexto(result.response.text());
        } catch (e) { console.log("⚠️ Gemini falló, usando Groq..."); }
    }

    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }]
        }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 7000 });
        return limpiarTexto(res.data.choices[0].message.content);
    } catch (e) { return "Conectando tus sentidos, esta es La Fronterísima."; }
}

// ======= 5. VOZ Y PRODUCCIÓN (SHERPA OFFLINE) =======

async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        try {
            const tts = new sherpa_onnx.OfflineTts(SHERPA_CONFIG);
            const audio = tts.generate({ text: texto, sid: 0, speed: 1.0 });
            
            const wavPath = archivoDestino.replace('.mp3', '.wav');
            audio.save(wavPath);

            // Conversión a MP3 para AzuraCast
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
    let cmd = (conFondo && fs.existsSync(fondo))
        ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.08,atrim=duration=80[bg];[1:a]volume=1.6[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.5" -c:a libmp3lame -b:a 128k ${tempSalida}`;

    try {
        await new Promise((resolve) => exec(cmd, resolve));
        const form = new FormData();
        form.append('path', ''); 
        form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
        await axios.post(AZURA_API_UPLOAD, form, { 
            headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, 
            timeout: 60000 
        });
        [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
    } catch (e) { console.error("Error en producción/subida:", e.message); }
}

// ======= 6. AUTOMATIZACIÓN =======

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) 
            ? ` Saludo del oyente: "${ultimoSaludo.texto}".` : "";

        const prompt = `Hora: ${hora}. Clima Cali: ${Math.round(clim.data.current_weather.temperature)}°C. Sonando: ${np.titulo}. ${extras} Estilo locutor amigable.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        ultimoSaludo.fecha = null; 
        console.log("✅ Reporte (30m) actualizado.");
    } catch (e) { console.error("Error Reporte:", e.message); }
}

async function autoRedactorIA() {
    try {
        const prompt = `Redacta una reflexión o curiosidad musical. Extensión: exactamente 80 palabras. Tono profesional.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_red_${Date.now()}.mp3`;
        
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
        console.log("✅ Mensaje (60m) actualizado.");
    } catch (e) { console.error("Error Redactor:", e.message); }
}

// ======= 7. RUTAS (CON LOGIN Y MANUAL) =======

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Contraseña incorrecta" });
    }
});

app.post("/procesar-locucion", async (req, res) => {
    // Verificación básica de password opcional si lo envías en el body
    const pathVoz = `v_man_${Date.now()}.mp3`;
    try {
        await generarVoz(req.body.texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", req.body.conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

app.get("/health", (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Online en puerto ${PORT}`);
    
    // Inicios retardados
    setTimeout(autoReporte, 5000); 
    setTimeout(autoRedactorIA, 20000);

    // Intervalos
    setInterval(autoReporte, 30 * 60 * 1000);   // Reporte 30 min
    setInterval(autoRedactorIA, 60 * 60 * 1000); // Reflexión 60 min
});
