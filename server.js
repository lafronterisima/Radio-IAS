
require('dotenv').config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const Parser = require('rss-parser');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const parser = new Parser();

// ======= CONFIGURACIÓN =======
const API_KEY_GEMINI = process.env.GOOGLE_API_KEY;
const AZURA_KEY = process.env.AZURA_KEY;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const STATION_ID = "24"; // ¡Verifica que este sea tu ID en Azura!
const AZURA_API_URL = `https://az.azurafree.eu/api/station/${STATION_ID}/files`;

// Ruta para el Health Check del hosting
app.get('/', (req, res) => res.send("🎙️ La Fronterísima AI está operando correctamente."));

// --- 1. OBTENER DATOS (CLIMA Y NOTICIAS) ---
async function obtenerContexto() {
    try {
        const ahora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' });
        const clima = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const noticias = await parser.parseURL('https://feeds.bbci.co.uk/mundo/rss.xml');
        
        return {
            hora: ahora,
            temp: Math.round(clima.data.current_weather.temperature),
            titular: noticias.items[0].title
        };
    } catch (e) {
        return { hora: "al momento", temp: "24", titular: "Sigue la mejor programación." };
    }
}

// --- 2. REDACTAR CON GEMINI (VÍA REST DIRECTO - EVITA EL 404) ---
async function redactarIA(idea, datos = null) {
    try {
        const prompt = datos 
            ? `Eres locutor de "La Fronterísima" en Cali. Datos: Hora ${datos.hora}, Temp ${datos.temp}°C, Noticia: ${datos.titular}. Redacta un guion corto y profesional con el eslogan "Notas surcando fronteras". Solo el texto.`
            : `Eres locutor de "La Fronterísima". Idea: ${idea}. Eslogan: "Notas surcando fronteras". Redacta un guion dinámico. Solo el texto.`;

        // Usamos la URL de la API estable de Google
        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${API_KEY_GEMINI}`;
        
        const response = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }]
        });

        return response.data.candidates[0].content.parts[0].text.trim();
    } catch (error) {
        console.error("❌ Error en Gemini API:", error.response?.data || error.message);
        return "Estás en sintonía con La Fronterísima, notas surcando fronteras. La radio que te acompaña en Cali.";
    }
}

// --- 3. GENERAR VOZ (AZURE GONZALO) ---
async function generarVoz(texto) {
    return new Promise((resolve, reject) => {
        const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
        speechConfig.speechSynthesisVoiceName = "es-CO-GonzaloNeural";
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

        const ssml = `
            <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO">
                <voice name="es-CO-GonzaloNeural">
                    <prosody rate="0.95" pitch="low">${texto}</prosody>
                </voice>
            </speak>`;

        synthesizer.speakSsmlAsync(ssml, result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync("voz_temp.mp3", Buffer.from(result.audioData));
                synthesizer.close();
                resolve();
            } else {
                synthesizer.close();
                reject("Error en Azure Speech");
            }
        }, err => reject(err));
    });
}

// --- 4. PROCESAR Y SUBIR ---
async function producirYSubir(nombreArchivo, conFondo) {
    return new Promise((resolve, reject) => {
        const comando = (conFondo && fs.existsSync("fondo.mp3"))
            ? `ffmpeg -y -i fondo.mp3 -i voz_temp.mp3 -filter_complex "[0:a]volume=0.2[bg];[1:a]volume=1.3[v];[bg][v]sidechaincompress=threshold=0.1:ratio=20[out]" -map "[out]" -shortest -c:a libmp3lame -b:a 128k salida.mp3`
            : `ffmpeg -y -i voz_temp.mp3 -c:a libmp3lame -b:a 128k salida.mp3`;

        exec(comando, async (err) => {
            if (err) return reject("Fallo FFmpeg");

            try {
                const form = new FormData();
                form.append("file", fs.createReadStream("salida.mp3"));
                form.append("path", nombreArchivo);

                await axios.post(AZURA_API_URL, form, {
                    headers: { ...form.getHeaders(), "X-API-Key": AZURA_KEY }
                });
                resolve();
            } catch (e) {
                reject("Error al subir a AzuraCast: " + e.message);
            }
        });
    });
}

// ======= ENDPOINTS =======

app.post("/redactar-guion", async (req, res) => {
    const texto = await redactarIA(req.body.idea);
    res.json({ guion: texto });
});

app.post("/procesar-locucion", async (req, res) => {
    try {
        await generarVoz(req.body.texto);
        await producirYSubir(req.body.nombreArchivo || "manual.mp3", req.body.conFondo);
        res.send("✅ Éxito");
    } catch (e) {
        res.status(500).send(e.toString());
    }
});

// ======= AUTOMATIZACIÓN (CADA 15 MINUTOS) =======

async function tick() {
    console.log(`🎙️ [${new Date().toLocaleTimeString()}] Iniciando reporte...`);
    try {
        const datos = await obtenerContexto();
        const guion = await redactarIA(null, datos);
        await generarVoz(guion);
        await producirYSubir("dj_auto.mp3", true);
        console.log("✅ Reporte de 15 min actualizado.");
    } catch (e) {
        console.error("⚠️ Error en el tick:", e);
    }
}

setInterval(tick, 15 * 60 * 1000);

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`🚀 La Fronterísima activa en el puerto ${PORT}`);
    // Lanzar primer reporte a los 5 segundos de iniciar
    setTimeout(tick, 5000);
});
