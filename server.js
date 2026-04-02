require('dotenv').config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json());
app.use(express.static('public'));

const parser = new Parser();
// Forzamos la configuración de la API Key
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const AZURA_KEY = process.env.AZURA_KEY;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const STATION_ID = "42"; 
const AZURA_API = `https://az.azurafree.eu/api/station/${STATION_ID}/files`;

// --- 1. OBTENER DATOS ---
async function obtenerDatos() {
    try {
        const ahora = new Date().toLocaleTimeString("es-CO", { 
            timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' 
        });
        const weather = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const rss = await parser.parseURL('https://feeds.bbci.co.uk/mundo/rss.xml');
        return { hora: ahora, temp: Math.round(weather.data.current_weather.temperature), noticia: rss.items[0].title };
    } catch (e) {
        return { hora: "ahora", temp: "24", noticia: "Sigue la música en La Fronterísima." };
    }
}

// --- 2. REDACTAR CON GEMINI (SOLUCIÓN DEFINITIVA AL 404) ---
async function redactarGuion(idea, datos = null) {
    try {
        // Usamos la versión 'v1' explícitamente para evitar el error v1beta
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }, { apiVersion: 'v1' });

        let promptText = `Eres locutor de "La Fronterísima" en Cali. Eslogan: "Notas surcando fronteras". `;
        if (datos) {
            promptText += `Reporte: Hora ${datos.hora}, Temp ${datos.temp}°C, Noticia: ${datos.noticia}. Redacta un guion corto y profesional. Solo texto.`;
        } else {
            promptText += `Idea: ${idea}. Redacta un guion dinámico para locutor neutro. Solo texto.`;
        }

        const result = await model.generateContent(promptText);
        const response = await result.response;
        return response.text().trim();
    } catch (error) {
        console.error("❌ Fallo en Gemini:", error.message);
        return "Son las notas que surcan fronteras. Estás en sintonía con La Fronterísima, la radio que te acompaña en Cali.";
    }
}

// --- 3. GENERAR VOZ ---
async function generarAudioVoz(texto) {
    return new Promise((resolve, reject) => {
        const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
        speechConfig.speechSynthesisVoiceName = "es-CO-GonzaloNeural";
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

        const ssml = `<speak version="1.0" xml:lang="es-CO"><voice name="es-CO-GonzaloNeural"><prosody pitch="low" rate="0.95">${texto}</prosody></voice></speak>`;

        synthesizer.speakSsmlAsync(ssml, result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync("voz_temp.mp3", Buffer.from(result.audioData));
                synthesizer.close();
                resolve();
            } else {
                synthesizer.close();
                reject(result.errorDetails);
            }
        }, err => { synthesizer.close(); reject(err); });
    });
}

// --- 4. MEZCLAR Y SUBIR ---
async function mezclarYSubir(nombreFinal, conFondo) {
    return new Promise((resolve, reject) => {
        // Aseguramos que el archivo de voz exista antes de mezclar
        if (!fs.existsSync("voz_temp.mp3")) return reject("No existe archivo de voz");

        const comando = (conFondo && fs.existsSync("fondo.mp3"))
            ? `ffmpeg -y -i fondo.mp3 -i voz_temp.mp3 -filter_complex "[0:a]volume=0.2[bg];[1:a]volume=1.3[v];[bg][v]sidechaincompress=threshold=0.1:ratio=20[out]" -map "[out]" -shortest -c:a libmp3lame -b:a 128k salida_final.mp3`
            : `ffmpeg -y -i voz_temp.mp3 -c:a libmp3lame -b:a 128k salida_final.mp3`;

        exec(comando, async (err) => {
            if (err) return reject(err);

            try {
                const form = new FormData();
                form.append("file", fs.createReadStream("salida_final.mp3"));
                form.append("path", nombreFinal);

                await axios.post(AZURA_API, form, {
                    headers: { ...form.getHeaders(), "X-API-Key": AZURA_KEY }
                });
                resolve();
            } catch (e) {
                reject("Error Azura subida: " + e.message);
            }
        });
    });
}

// --- ENDPOINTS ---
app.post("/redactar-guion", async (req, res) => {
    const guion = await redactarGuion(req.body.idea);
    res.json({ guion });
});

app.post("/procesar-locucion", async (req, res) => {
    try {
        await generarAudioVoz(req.body.texto);
        await mezclarYSubir(req.body.nombreArchivo, req.body.conFondo);
        res.send("✅ Ok");
    } catch (e) { res.status(500).send(e.toString()); }
});

// --- AUTOMATIZACIÓN ---
async function tickAutomatico() {
    console.log(`🎙️ [${new Date().toLocaleTimeString()}] Iniciando reporte...`);
    try {
        const datos = await obtenerDatos();
        const guion = await redactarGuion(null, datos);
        await generarAudioVoz(guion);
        await mezclarYSubir("dj_auto.mp3", true);
        console.log("✅ Éxito en reporte de 15 min.");
    } catch (error) {
        console.error("⚠️ Fallo tick:", error);
    }
}

setInterval(tickAutomatico, 15 * 60 * 1000);
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`🚀 La Fronterísima AI activa en puerto ${PORT}`);
    setTimeout(tickAutomatico, 5000); // Primer reporte a los 5 segundos
});
