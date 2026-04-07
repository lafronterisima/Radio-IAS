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

// ======= CONFIGURACIÓN =======
const KEYS = {
    GEMINI: process.env.GOOGLE_API_KEY,
    GROQ: process.env.GROQ_API_KEY,
    AZURE: process.env.AZURE_SPEECH_KEY,
    AZURE_REGION: process.env.AZURE_REGION,
    AZURA: process.env.AZURA_KEY,
    STATION_ID: process.env.STATION_ID || "24",
    PASSWORD: process.env.APP_PASSWORD
};

const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;

// ======= SISTEMA DE SEGURIDAD =======
app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password && password === KEYS.PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Clave incorrecta" });
    }
});

// ======= RUTA 1: REDACTAR GUION (IA) =======
app.post('/redactar-guion', async (req, res) => {
    const { idea } = req.body;
    const prompt = `Actúa como locutora de radio de Cali para "La Fronterísima". Redacta un guion corto (máximo 30 palabras) basado en esta idea: "${idea}". Sé alegre, usa jerga caleña suave y no uses asteriscos ni negritas.`;

    try {
        let guion = "";
        // Intento con Gemini
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
            const gRes = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 5000 });
            guion = gRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        } catch (e) {
            console.warn("⚠️ Gemini falló, usando Groq...");
            const groqRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: prompt }]
            }, { headers: { Authorization: `Bearer ${KEYS.GROQ}` } });
            guion = groqRes.data?.choices?.[0]?.message?.content;
        }
        
        res.json({ guion: guion.replace(/[*#_<>]/g, '').trim() });
    } catch (e) {
        res.status(500).json({ error: "Error al redactar" });
    }
});

// ======= RUTA 2: PROCESAR AUDIO Y SUBIR =======
app.post('/procesar-locucion', async (req, res) => {
    const { texto, nombreArchivo, conFondo } = req.body;
    const vozTmp = `manual_${Date.now()}.mp3`;

    try {
        await generarVoz(texto, vozTmp);
        await producirYSubir(vozTmp, nombreArchivo || "locucion_manual.mp3", conFondo);
        res.json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message || e });
    }
});

// ======= FUNCIONES DE APOYO (Azure y FFmpeg) =======
async function generarVoz(texto, archivo) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
        config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16Khz128KBitrateMonoMp3;
        const synth = new sdk.SpeechSynthesizer(config);
        
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural"><mstts:express-as style="cheerful"><prosody rate="+8%">${texto}</prosody></mstts:express-as></voice>
        </speak>`;

        synth.speakSsmlAsync(ssml, r => {
            if (r.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync(archivo, Buffer.from(r.audioData));
                synth.close(); resolve();
            } else { synth.close(); reject("Error Azure"); }
        }, e => { synth.close(); reject(e); });
    });
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const salida = `prod_${Date.now()}.mp3`;
    const fondo = path.join(__dirname, "fondo.mp3");

    return new Promise((resolve, reject) => {
        let cmd = `ffmpeg -y -i ${archivoVoz} -af "volume=1.8" -c:a libmp3lame -b:a 128k ${salida}`;
        if (conFondo && fs.existsSync(fondo)) {
            cmd = `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.08,atrim=duration=25,aresample=44100[bg];[1:a]volume=2.2,aresample=44100[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${salida}`;
        }

        exec(cmd, async (err) => {
            if (err) return reject(err);
            try {
                const form = new FormData();
                form.append("file", fs.createReadStream(salida), nombreFinal);
                await axios.post(AZURA_API_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA } });
                resolve();
            } catch (e) { reject(e); }
            finally {
                if (fs.existsSync(archivoVoz)) fs.unlinkSync(archivoVoz);
                if (fs.existsSync(salida)) fs.unlinkSync(salida);
            }
        });
    });
}

// Ruta de salud y Servidor
app.get("/health", (req, res) => res.send("OK"));
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`🔥 Panel conectado en puerto ${PORT}`));
