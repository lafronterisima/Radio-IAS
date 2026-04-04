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

// ======= CONFIGURACIÓN DE LLAVES =======
const KEYS = {
    GEMINI: process.env.GOOGLE_API_KEY,
    GROQ: process.env.GROQ_API_KEY,
    AZURE: process.env.AZURE_SPEECH_KEY,
    AZURE_REGION: process.env.AZURE_REGION,
    AZURA: process.env.AZURA_KEY,
    STATION_ID: process.env.STATION_ID || "24"
};

const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;

// ======= 1. NÚCLEO DE INTELIGENCIA (CON FAILOVER) =======
async function redactarIA(idea, datos = null) {
    const prompt = datos 
        ? `Eres locutora de "La Fronterísima" en Cali. Hora ${datos.hora}, Temp ${datos.temp}°C. Genera un saludo alegre de 30 palabras con el eslogan: "Notas surcando fronteras". Menciona el clima actual de Cali.`
        : `Idea: ${idea}. Genera un guion de locución de 40 palabras para la emisora La Fronterísima. Incluye el eslogan: "Notas surcando fronteras".`;

    // INTENTO 1: GEMINI 1.5 FLASH
    try {
        console.log("🤖 Intentando con Gemini...");
        const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(urlGemini, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 5000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
    } catch (e) {
        console.warn("⚠️ Gemini falló, saltando a Groq...");
    }

    // INTENTO 2: GROQ (LLAMA 3.1) - El respaldo ultra rápido
    try {
        console.log("⚡ Usando Respaldo: Groq Cloud");
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [{ role: "system", content: "Locutora profesional de Cali, Colombia." }, { role: "user", content: prompt }]
        }, { 
            headers: { "Authorization": `Bearer ${KEYS.GROQ}` },
            timeout: 5000 
        });
        return limpiarTexto(res.data?.choices?.[0]?.message?.content);
    } catch (e) {
        console.error("❌ Ambas IAs fallaron.");
        return "Sintonizas La Fronterísima, notas surcando fronteras desde Cali.";
    }
}

function limpiarTexto(t) {
    return t.replace(/[*#]/g, '').replace(/Locutor:|Guion:|Respuesta:/gi, '').trim();
}

// ======= 2. SÍNTESIS DE VOZ (AZURE) =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        if (!KEYS.AZURE) return reject("Falta AZURE_SPEECH_KEY");
        const speechConfig = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural"; 
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
        
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural"><mstts:express-as style="cheerful" styledegree="1.4">
            <prosody rate="+8%" pitch="+2%">${texto}</prosody></mstts:express-as></voice></speak>`;

        synthesizer.speakSsmlAsync(ssml, result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync(archivoDestino, Buffer.from(result.audioData));
                synthesizer.close();
                resolve();
            } else {
                synthesizer.close();
                reject("Error TTS Azure");
            }
        }, err => { synthesizer.close(); reject(err); });
    });
}

// ======= 3. PRODUCCIÓN MUSICAL (FFMPEG) =======
async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    return new Promise((resolve, reject) => {
        // Sidechain: La música baja al 12% cuando Salomé habla
        const cmd = (conFondo && fs.existsSync("fondo.mp3"))
    ? `ffmpeg -y -i fondo.mp3 -i ${archivoVoz} -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
    : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;

        exec(cmd, async (err) => {
            if (err) return reject("FFmpeg Error");
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                form.append('path', nombreFinal);

                await axios.post(AZURA_API_UPLOAD, form, {
                    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }
                });

                [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                resolve();
            } catch (e) {
                reject("Error Subida Azura");
            }
        });
    });
}

// ======= 4. RUTAS Y AUTOMATIZACIÓN =======
app.get("/health", (req, res) => res.status(200).send("LIVE"));

app.post("/redactar-guion", async (req, res) => {
    const guion = await redactarIA(req.body.idea);
    res.json({ guion });
});

app.post("/procesar-locucion", async (req, res) => {
    const { texto, nombreArchivo, conFondo } = req.body;
    const pathVoz = `v_${Date.now()}.mp3`;
    try {
        await generarVoz(texto, pathVoz);
        await producirYSubir(pathVoz, nombreArchivo, conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send(e.toString()); }
});

async function autoReporte() {
    console.log("🎙️ Generando reporte automático para Cali...");
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const datos = { 
            hora: new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' }),
            temp: Math.round(clim.data.current_weather.temperature)
        };
        const guion = await redactarIA(null, datos);
        const pathAuto = `auto_ref.mp3`;
        await generarVoz(guion, pathAuto);
        await producirYSubir(pathAuto, "reporte_cali.mp3", true);
        console.log("✅ Reporte subido a AzuraCast.");
    } catch (e) { console.error("❌ Fallo en tick:", e.message); }
}

// ======= 5. ARRANQUE =======
const PORT = process.env.PORT || 8000;

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro operando en puerto ${PORT}`);
    
    // Iniciamos la automatización después de 10 segundos
    setTimeout(() => {
        console.log("▶️ Iniciando ciclo de reportes automáticos...");
        autoReporte();
        setInterval(autoReporte, 15 * 60 * 1000);
    }, 10000); 
});

// Manejador de errores para evitar que la app crashee si el puerto está ocupado
server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`❌ ERROR: El puerto ${PORT} ya está ocupado por otro proceso.`);
        console.error(`👉 Intenta cerrar procesos viejos o usa: lsof -ti:${PORT} | xargs kill -9`);
        process.exit(1);
    } else {
        console.error("❌ Error al iniciar el servidor:", e);
    }
});
