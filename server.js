
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
const STATION_ID = "24"; 
const AZURA_API_URL = `https://az.azurafree.eu/api/station/${STATION_ID}/files`;

// Ruta para el Health Check
app.get('/', (req, res) => res.send("🎙️ La Fronterísima AI está operando correctamente."));

// --- 1. OBTENER DATOS (CLIMA Y NOTICIAS) ---
async function obtenerContexto() {
    try {
        const ahora = new Date().toLocaleTimeString("es-CO", { 
            timeZone: "America/Bogota", 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        const clima = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const noticias = await parser.parseURL('https://feeds.bbci.co.uk/mundo/rss.xml');
        
        return {
            hora: ahora,
            temp: Math.round(clima.data.current_weather.temperature),
            titular: noticias.items[0].title
        };
    } catch (e) {
        console.error("⚠️ Error obteniendo contexto:", e.message);
        return { hora: "al momento", temp: "24", titular: "Sigue la mejor programación musical." };
    }
}

// --- 2. REDACTAR CON GEMINI (REST DIRECTO) ---
async function redactarIA(idea, datos = null) {
    try {
        const prompt = datos 
            ? `Eres locutor de "La Fronterísima" en Cali. Datos: Hora ${datos.hora}, Temp ${datos.temp}°C, Noticia: ${datos.titular}. 
               Redacta un guion de locución corto (máximo 40 palabras), dinámico y profesional. 
               Usa el eslogan "Notas surcando fronteras". No uses emojis ni asteriscos, solo el texto plano.`
            : `Eres locutor de "La Fronterísima". Idea: ${idea}. Eslogan: "Notas surcando fronteras". Redacta un guion corto. Solo el texto.`;

        // Usamos v1beta para mayor compatibilidad con Gemini 1.5 Flash
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY_GEMINI}`;
        
        const response = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }]
        });

        const texto = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!texto) throw new Error("Respuesta de Gemini vacía");

        return texto.trim();
    } catch (error) {
        console.error("❌ Error en Gemini API:", error.response?.data || error.message);
        return "Estás en sintonía con La Fronterísima, notas surcando fronteras. La radio que te acompaña en Cali con la mejor energía.";
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
                reject("Error en síntesis de voz de Azure");
            }
        }, err => {
            synthesizer.close();
            reject(err);
        });
    });
}

// --- 4. PROCESAR CON FFMPEG Y SUBIR A AZURACAST ---
async function producirYSubir(nombreArchivo, conFondo) {
    return new Promise((resolve, reject) => {
        // Filtro sidechain: baja el volumen del fondo automáticamente cuando hay voz
        const comando = (conFondo && fs.existsSync("fondo.mp3"))
            ? `ffmpeg -y -i fondo.mp3 -i voz_temp.mp3 -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.4[v];[bg][v]sidechaincompress=threshold=0.1:ratio=20[out]" -map "[out]" -shortest -c:a libmp3lame -b:a 128k salida.mp3`
            : `ffmpeg -y -i voz_temp.mp3 -c:a libmp3lame -b:a 128k salida.mp3`;

        exec(comando, async (err) => {
            if (err) return reject("Fallo en procesamiento FFmpeg: " + err);

            try {
                const form = new FormData();
                form.append("file", fs.createReadStream("salida.mp3"));

                // Se envía el 'path' como parámetro en la URL según requerimientos de AzuraCast
                await axios.post(AZURA_API_URL, form, {
                    headers: { ...form.getHeaders(), "X-API-Key": AZURA_KEY },
                    params: { path: nombreArchivo }
                });

                // Limpieza de archivos temporales
                if (fs.existsSync("voz_temp.mp3")) fs.unlinkSync("voz_temp.mp3");
                if (fs.existsSync("salida.mp3")) fs.unlinkSync("salida.mp3");

                resolve();
            } catch (e) {
                const errorLog = e.response?.data?.message || e.message;
                reject("Error en subida a AzuraCast: " + errorLog);
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
        res.send("✅ Locución procesada y subida con éxito.");
    } catch (e) {
        console.error(e);
        res.status(500).send("Error: " + e.toString());
    }
});

// ======= AUTOMATIZACIÓN (CADA 15 MINUTOS) =======

async function tick() {
    console.log(`🎙️ [${new Date().toLocaleTimeString()}] Generando reporte automático...`);
    try {
        const datos = await obtenerContexto();
        const guion = await redactarIA(null, datos);
        await generarVoz(guion);
        await producirYSubir("dj_auto.mp3", true);
        console.log("✅ Reporte de 15 min actualizado en el servidor.");
    } catch (e) {
        console.error("⚠️ Error en el ciclo automático:", e);
    }
}

// Intervalo de 15 minutos
setInterval(tick, 15 * 60 * 1000);

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`🚀 La Fronterísima activa en el puerto ${PORT}`);
    // Lanzar primer reporte a los 10 segundos de iniciar para asegurar conexión
    setTimeout(tick, 10000);
});     
