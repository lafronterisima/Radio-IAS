require('dotenv').config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const Parser = require('rss-parser');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const parser = new Parser();

// ======= CONFIGURACIÓN =======
const API_KEY_GEMINI = process.env.GOOGLE_API_KEY;
const AZURA_KEY = process.env.AZURA_KEY;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const STATION_ID = process.env.STATION_ID || "24"; 
const AZURA_API_URL = `https://az.azurafree.eu/api/station/${STATION_ID}/files`;

// ======= 1. OBTENER CONTEXTO (CALI) =======
async function obtenerContexto() {
    try {
        const ahora = new Date().toLocaleTimeString("es-CO", { 
            timeZone: "America/Bogota", 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        
        const climaRes = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const temp = climaRes.data?.current_weather?.temperature;
        const noticias = await parser.parseURL('https://feeds.bbci.co.uk/mundo/rss.xml');
        
        return {
            hora: ahora,
            temp: temp ? Math.round(temp) : "24",
            titular: noticias.items[0]?.title || "la mejor música del momento"
        };
    } catch (e) {
        console.error("⚠️ Error en contexto:", e.message);
        return { hora: "ahora", temp: "25", titular: "sintonía total" };
    }
}

// ======= 2. REDACTAR CON GEMINI (SOLUCIÓN ERROR 404) =======
async function redactarIA(idea, datos = null) {
    try {
        const prompt = datos 
            ? `Eres el locutor de "La Fronterísima" en Cali. Datos: Hora ${datos.hora}, Temp ${datos.temp}°C, Noticia: ${datos.titular}. Redacta un guion corto (max 35 palabras), dinámico. Eslogan: "Notas surcando fronteras". Solo texto plano.`
            : `Eres locutor de La Fronterísima. Idea: ${idea}. Eslogan: "Notas surcando fronteras". Guion corto.`;

        // Usamos gemini-1.5-flash-latest en v1 para máxima estabilidad
        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-latest:generateContent?key=${API_KEY_GEMINI}`;
        
        const response = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }]
        });

        const texto = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return texto.replace(/[*#]/g, '').replace(/Locutor:|Guion:|Guión:/gi, '').trim();
    } catch (error) {
        console.error("❌ Error Gemini:", error.response?.data || error.message);
        return "Estás en sintonía con La Fronterísima, notas surcando fronteras en Cali.";
    }
}

// ======= 3. GENERAR VOZ (AZURE) =======
async function generarVoz(texto, nombreArchivoVoz) {
    return new Promise((resolve, reject) => {
        const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
        speechConfig.speechSynthesisVoiceName = "es-CO-GonzaloNeural";
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

        const ssml = `
            <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO">
                <voice name="es-CO-GonzaloNeural">
                    <prosody rate="0.95" pitch="-5%">${texto}</prosody>
                </voice>
            </speak>`;

        synthesizer.speakSsmlAsync(ssml, result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync(nombreArchivoVoz, Buffer.from(result.audioData));
                synthesizer.close();
                resolve();
            } else {
                synthesizer.close();
                reject("Error Azure TTS: " + result.errorDetails);
            }
        }, err => {
            synthesizer.close();
            reject(err);
        });
    });
}

// ======= 4. FFMPEG Y SUBIDA (SOLUCIÓN ERROR CONSTRUCTOR AZURA) =======
async function producirYSubir(archivoVoz, nombreFinalDestino, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    
    return new Promise((resolve, reject) => {
        const comando = (conFondo && fs.existsSync("fondo.mp3"))
            ? `ffmpeg -y -i fondo.mp3 -i ${archivoVoz} -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.4[v];[bg][v]sidechaincompress=threshold=0.1:ratio=15[out]" -map "[out]" -shortest -c:a libmp3lame -b:a 128k ${tempSalida}`
            : `ffmpeg -y -i ${archivoVoz} -af "volume=1.3" -c:a libmp3lame -b:a 128k ${tempSalida}`;

        exec(comando, async (err) => {
            if (err) return reject("Error FFmpeg: " + err);

            try {
                const form = new FormData();
                // Adjuntamos el archivo
                form.append("file", fs.createReadStream(tempSalida));
                // IMPORTANTE: Enviamos el 'path' dentro del form para evitar el error de constructor
                form.append("path", nombreFinalDestino); 

                await axios.post(AZURA_API_URL, form, {
                    headers: { 
                        ...form.getHeaders(), 
                        "X-API-Key": AZURA_KEY 
                    }
                });

                if (fs.existsSync(archivoVoz)) fs.unlinkSync(archivoVoz);
                if (fs.existsSync(tempSalida)) fs.unlinkSync(tempSalida);
                resolve();
            } catch (e) {
                console.error("❌ Detalle AzuraCast:", e.response?.data || e.message);
                reject("Error AzuraCast: " + (e.response?.data?.message || e.message));
            }
        });
    });
}

// ======= ENDPOINTS =======

app.get('/', (req, res) => res.send("🎙️ La Fronterísima AI operando correctamente."));

app.post("/procesar-locucion", async (req, res) => {
    const { texto, conFondo, nombreArchivo } = req.body;
    const vozId = `manual_${Date.now()}.mp3`;
    try {
        await generarVoz(texto, vozId);
        await producirYSubir(vozId, nombreArchivo || "locucion.mp3", conFondo);
        res.send("✅ Locución procesada con éxito.");
    } catch (e) {
        res.status(500).send(e.toString());
    }
});

// ======= AUTOMATIZACIÓN =======

async function tick() {
    const autoId = `auto_${Date.now()}.mp3`;
    console.log(`🎙️ [${new Date().toLocaleTimeString()}] Generando reporte automático...`);
    try {
        const datos = await obtenerContexto();
        const guion = await redactarIA(null, datos);
        console.log("📝 Guion:", guion);
        await generarVoz(guion, autoId);
        await producirYSubir(autoId, "dj_auto.mp3", true);
        console.log("✅ Ciclo completado.");
    } catch (e) {
        console.error("⚠️ Error en ciclo:", e.message);
    }
}

// Intervalo 15 min
setInterval(tick, 15 * 60 * 1000);

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima activa en el puerto ${PORT}`);
    // Delay de 45 segundos para que pase el Health Check de Koyeb antes de la carga pesada
    setTimeout(tick, 45000); 
});
