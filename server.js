 
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
app.use(express.static('public')); // Sirve el frontend automático

const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// ======= CONFIGURACIÓN DE ESTACIÓN =======
const AZURA_KEY = process.env.AZURA_KEY;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const STATION_ID = "42"; 
const AZURA_API = `https://az.azurafree.eu/api/station/${STATION_ID}/files`;

// --- 1. OBTENER DATOS (HORA, CLIMA, NOTICIAS) ---
async function obtenerDatos() {
    try {
        const ahora = new Date().toLocaleTimeString("es-CO", { 
            timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' 
        });
        const weather = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const rss = await parser.parseURL('https://feeds.bbci.co.uk/mundo/rss.xml');
        
        return {
            hora: ahora,
            temp: Math.round(weather.data.current_weather.temperature),
            noticia: rss.items[0].title
        };
    } catch (e) {
        console.error("⚠️ Error obteniendo datos externos:", e.message);
        return { hora: "al momento", temp: "agradable", noticia: "Sigue la mejor música." };
    }
}

// --- 2. REDACTAR CON GEMINI (CORREGIDO v1) ---
async function redactarGuion(idea, datos = null) {
    try {
        // Forzamos la apiVersion 'v1' para evitar el error 404
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            apiVersion: 'v1' 
        });

        let prompt;
        if (datos) {
            // Guion para el reporte automático de 15 min
            prompt = `Actúa como el locutor principal de "La Fronterísima" en Cali. 
            Datos actuales: Hora ${datos.hora}, Temp ${datos.temp}°C, Noticia: ${datos.noticia}.
            Redacta un guion corto y profesional con el eslogan "Notas surcando fronteras". Solo el texto.`;
        } else {
            // Guion para peticiones manuales desde el Frontend
            prompt = `Eres locutor de "La Fronterísima" en Cali. Idea: ${idea}. 
            Eslogan: "Notas surcando fronteras". Redacta un guion dinámico para voz masculina neutra. Solo el texto.`;
        }

        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        console.error("❌ Error en Gemini:", error.message);
        return "Continuamos en La Fronterísima con la mejor programación, notas surcando fronteras.";
    }
}

// --- 3. GENERAR VOZ (GONZALO NEUTRAL) ---
async function generarAudioVoz(texto) {
    return new Promise((resolve, reject) => {
        const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
        speechConfig.speechSynthesisVoiceName = "es-CO-GonzaloNeural";
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

        const ssml = `
            <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO">
                <voice name="es-CO-GonzaloNeural">
                    <prosody rate="0.95" pitch="low">${texto}</prosody>
                    <break time="800ms" />
                </voice>
            </speak>`;

        synthesizer.speakSsmlAsync(ssml, result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync("voz_temp.mp3", Buffer.from(result.audioData));
                synthesizer.close();
                resolve();
            } else {
                synthesizer.close();
                reject("Error Azure: " + result.errorDetails);
            }
        }, err => {
            synthesizer.close();
            reject(err);
        });
    });
}

// --- 4. MEZCLA CON FFmpeg Y SUBIDA ---
async function mezclarYSubir(nombreFinal, conFondo) {
    return new Promise((resolve, reject) => {
        const comando = (conFondo && fs.existsSync("fondo.mp3"))
            ? `ffmpeg -y -i fondo.mp3 -i voz_temp.mp3 -filter_complex "[0:a]volume=0.2[bg];[1:a]volume=1.3[v];[bg][v]sidechaincompress=threshold=0.1:ratio=20[out]" -map "[out]" -shortest -c:a libmp3lame -b:a 128k salida_final.mp3`
            : `ffmpeg -y -i voz_temp.mp3 -c:a libmp3lame -b:a 128k salida_final.mp3`;

        exec(comando, async (err) => {
            if (err) return reject("Error FFmpeg: " + err);

            try {
                const form = new FormData();
                form.append("file", fs.createReadStream("salida_final.mp3"));
                form.append("path", nombreFinal);

                await axios.post(AZURA_API, form, {
                    headers: { ...form.getHeaders(), "X-API-Key": AZURA_KEY }
                });
                resolve();
            } catch (e) {
                reject("Error Azura: " + e.message);
            }
        });
    });
}

// ======= ENDPOINTS PARA EL FRONTEND =======

app.post("/redactar-guion", async (req, res) => {
    const guion = await redactarGuion(req.body.idea);
    res.json({ guion });
});

app.post("/procesar-locucion", async (req, res) => {
    const { texto, nombreArchivo, conFondo } = req.body;
    try {
        await generarAudioVoz(texto);
        await mezclarYSubir(nombreArchivo || "manual.mp3", conFondo);
        res.send("✅ Ok");
    } catch (e) {
        res.status(500).send(e);
    }
});

// ======= PROCESO AUTOMÁTICO (CADA 15 MIN) =======

async function tickAutomatico() {
    console.log(`\n🎙️ [${new Date().toLocaleTimeString()}] Iniciando reporte automático...`);
    try {
        const datos = await obtenerDatos();
        const guion = await redactarGuion(null, datos);
        console.log("📝 Guion Auto:", guion);
        
        await generarAudioVoz(guion);
        await mezclarYSubir("dj_auto.mp3", true);
        console.log("✅ Reporte de 15 min actualizado en AzuraCast.");
    } catch (error) {
        console.error("⚠️ Fallo en el tick automático:", error);
    }
}

// Configurar intervalo (15 minutos)
setInterval(tickAutomatico, 15 * 60 * 1000);

// Lanzar servidor
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`🚀 La Fronterísima AI activa en puerto ${PORT}`);
    // Ejecutar reporte inicial a los 10 segundos del arranque
    setTimeout(tickAutomatico, 10000);
});
