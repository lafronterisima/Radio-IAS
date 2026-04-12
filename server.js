require('dotenv').config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN =======
const KEYS = {
    GEMINI: process.env.GOOGLE_API_KEY,
    GROQ: process.env.GROQ_API_KEY,
    AZURE: process.env.AZURE_SPEECH_KEY,
    AZURE_REGION: process.env.AZURE_REGION,
    AZURA: process.env.AZURA_KEY,
    STATION_ID: process.env.STATION_ID || "24",
    PASSWORD: process.env.APP_PASSWORD
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

// ======= 2. SISTEMA DE SEGURIDAD =======
app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === KEYS.PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Clave incorrecta" });
    }
});

// ======= 3. FUNCIONES DE APOYO (Noticias y Radio) =======
async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios", titulo: "éxitos rumberos" };
    } catch (e) { return { artista: "varios", titulo: "la mejor música" }; }
}

async function obtenerNoticiasBBC() {
    try {
        // Usamos Euronews o BBC según disponibilidad
        const res = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml", { timeout: 5000 });
        const match = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>([^<]+)<\/title>/);
        return match ? match[1] || match[2] : "El mundo sigue vibrando.";
    } catch (e) { return "Noticias internacionales en desarrollo."; }
}

function limpiarTexto(t) {
    return t.replace(/[*#_]/g, '').replace(/Locutor:|Guion:|Respuesta:|Locutora:|Salomé:/gi, '').trim();
}

// ======= 4. INTELIGENCIA ARTIFICIAL (GEMINI + GROQ FAILOVER) =======
async function redactarIA(prompt) {
    try {
        console.log("📡 Intentando con Gemini...");
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 10000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
        throw new Error("Gemini vacío");
    } catch (e) {
        console.warn("⚠️ Gemini falló, saltando a Groq...");
        try {
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: "Locutora rumbera de Cali, alegre y carismática." },
                    { role: "user", content: prompt }
                ]
            }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 8000 });
            const textoGroq = res.data?.choices?.[0]?.message?.content;
            return textoGroq ? limpiarTexto(textoGroq) : "¡Sintonizas La Fronterísima!";
        } catch (err) {
            return "¡La Fronterísima, notas surcando fronteras con todo el sabor!";
        }
    }
}

// ======= 5. VOZ Y PRODUCCIÓN =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural"; 
        const synth = new sdk.SpeechSynthesizer(config);
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural"><mstts:express-as style="cheerful" styledegree="1.4">
            <prosody rate="+8%">${texto}</prosody></mstts:express-as></voice></speak>`;
        
        synth.speakSsmlAsync(ssml, r => {
            if (r.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync(archivoDestino, Buffer.from(r.audioData));
                synth.close(); resolve();
            } else { synth.close(); reject("Error TTS"); }
        }, e => { synth.close(); reject(e); });
    });
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondo = "fondo.mp3";
    const cmd = (conFondo && fs.existsSync(fondo))
        ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.15,atrim=duration=60[bg]; [1:a]volume=1.8[v]; [bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;

    return new Promise((resolve, reject) => {
        exec(cmd, async (err) => {
            if (err) return reject("FFmpeg Fail");
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                form.append('path', nombreFinal);
                await axios.post(AZURA_API_UPLOAD, form, {
                    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
                    timeout: 60000
                });
                [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                resolve();
            } catch (e) { reject("Upload Fail"); }
        });
    });
}

// ======= 6. RUTAS API =======
app.get("/health", (req, res) => res.status(200).send("LIVE"));

app.post("/redactar-guion", async (req, res) => {
    const guion = await redactarIA(req.body.idea || "Saludo rumbero");
    res.json({ guion });
});

app.post("/procesar-locucion", async (req, res) => {
    const { texto, conFondo } = req.body;
    const pathVoz = `v_man_${Date.now()}.mp3`;
    try {
        await generarVoz(texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send(e.toString()); }
});

// ======= 7. AUTOMATIZACIÓN (CADA 15 MINUTOS) =======
async function autoReporte() {
    console.log("🎙️ Generando reporte automático...");
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true", { timeout: 5000 });
        const bbc = await obtenerNoticiasBBC();
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        const temp = clim.data?.current_weather?.temperature ? `${Math.round(clim.data.current_weather.temperature)}°C` : "clima sabroso";

        const prompt = `Salomé de La Fronterísima Cali. Hora: ${hora}. Música actual: ${np.titulo} de ${np.artista}. Clima en Cali: ${temp}. Noticias: ${bbc}. Redacta un guion de 50 palabras rumbero. Termina: Notas surcando fronteras.`;
        
        const guion = await redactarIA(prompt);
        await generarVoz(guion, "v_auto.mp3");
        await producirYSubir("v_auto.mp3", "dj_auto.mp3", true);
        
        console.log(`✅ dj_auto.mp3 actualizado exitosamente.`);
    } catch (e) {
        console.error("❌ Error Auto-Reporte:", e.message || e);
    }
}

// ======= 8. INICIO DEL SERVIDOR =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro en puerto ${PORT}`);
    
    // Iniciar primer reporte a los 5 segundos
    setTimeout(autoReporte, 5000);
    
    // Ciclo de 15 minutos
    setInterval(autoReporte, 15 * 60 * 1000);

    // Self-ping para evitar que el servidor se duerma (Koyeb/Render)
    setInterval(() => {
        const url = process.env.URL_APP || `http://localhost:${PORT}`;
        axios.get(`${url}/health`).catch(() => {});
    }, 10 * 60 * 1000);
});
