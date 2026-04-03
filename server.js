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

const parser = new Parser();

// ======= CONFIGURACIÓN =======
const API_KEY_GEMINI = process.env.GOOGLE_API_KEY;
const AZURA_KEY = process.env.AZURA_KEY;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const STATION_ID = process.env.STATION_ID || "24"; 
// Cambiamos el endpoint a la versión base de archivos
const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${STATION_ID}/files/upload`;

// ======= 1. REDACTAR CON GEMINI (URL ACTUALIZADA) =======
async function redactarIA(idea, datos = null) {
    try {
        const prompt = datos 
            ? `Locutor de radio en Cali. Hora ${datos.hora}, Temp ${datos.temp}°C, Noticia: ${datos.titular}. Guion corto (30 palabras). Eslogan: "Notas surcando fronteras".`
            : `Idea: ${idea}. Guion de radio profesional (40 palabras). Eslogan: "Notas surcando fronteras".`;

        // Cambiamos a v1beta y el nombre del modelo a gemini-1.5-flash (sin -latest)
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY_GEMINI}`;
        
        const response = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }]
        });

        const texto = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return texto.replace(/[*#]/g, '').trim();
    } catch (error) {
        console.error("❌ Error Gemini:", error.response?.data || error.message);
        return "En sintonía con La Fronterísima, notas surcando fronteras.";
    }
}

// ======= 2. GENERAR VOZ =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
        speechConfig.speechSynthesisVoiceName = "es-CO-GonzaloNeural";
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO"><voice name="es-CO-GonzaloNeural"><prosody rate="1.0" pitch="-2%">${texto}</prosody></voice></speak>`;

        synthesizer.speakSsmlAsync(ssml, result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync(archivoDestino, Buffer.from(result.audioData));
                synthesizer.close();
                resolve();
            } else {
                synthesizer.close();
                reject("Error Azure TTS");
            }
        }, err => { synthesizer.close(); reject(err); });
    });
}

// ======= 3. SUBIR A AZURACAST (SOLUCIÓN AL $FILE) =======
async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `final_${Date.now()}.mp3`;
    return new Promise((resolve, reject) => {
        const comando = (conFondo && fs.existsSync("fondo.mp3"))
            ? `ffmpeg -y -i fondo.mp3 -i ${archivoVoz} -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.4[v];[bg][v]sidechaincompress=threshold=0.1:ratio=15[out]" -map "[out]" -shortest -c:a libmp3lame -b:a 128k ${tempSalida}`
            : `ffmpeg -y -i ${archivoVoz} -af "volume=1.3" -c:a libmp3lame -b:a 128k ${tempSalida}`;

        exec(comando, async (err) => {
            if (err) return reject("Error FFmpeg");
            try {
                const form = new FormData();
                // IMPORTANTE: El stream debe pasarse directamente y con los metadatos correctos
                const fileStream = fs.createReadStream(tempSalida);
                
                form.append('file', fileStream, {
                    filename: nombreFinal,
                    contentType: 'audio/mpeg',
                });
                form.append('path', nombreFinal);

                await axios.post(AZURA_API_UPLOAD, form, {
                    headers: { 
                        ...form.getHeaders(), 
                        "X-API-Key": AZURA_KEY 
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                });

                if (fs.existsSync(archivoVoz)) fs.unlinkSync(archivoVoz);
                if (fs.existsSync(tempSalida)) fs.unlinkSync(tempSalida);
                resolve();
            } catch (e) {
                console.error("❌ Detalle AzuraCast:", e.response?.data || e.message);
                reject("Fallo subida");
            }
        });
    });
}

// ======= ENDPOINTS =======

app.get("/", (req, res) => res.send("La Fronterísima está Online."));

app.post("/redactar-guion", async (req, res) => {
    const texto = await redactarIA(req.body.idea);
    res.json({ guion: texto });
});

app.post("/procesar-locucion", async (req, res) => {
    const { texto, nombreArchivo, conFondo } = req.body;
    const tempId = `v_${Date.now()}.mp3`;
    try {
        await generarVoz(texto, tempId);
        await producirYSubir(tempId, nombreArchivo, conFondo);
        res.send("OK");
    } catch (e) {
        res.status(500).send(e.toString());
    }
});

// ======= AUTOMATIZACIÓN =======

async function tick() {
    console.log(`🎙️ [${new Date().toLocaleTimeString()}] Iniciando ciclo automático...`);
    const autoFile = `auto_${Date.now()}.mp3`;
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const datos = { 
            hora: new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' }),
            temp: Math.round(clim.data.current_weather.temperature),
            titular: "la mejor música"
        };
        const guion = await redactarIA(null, datos);
        console.log("📝 Guion generado:", guion);
        await generarVoz(guion, autoFile);
        await producirYSubir(autoFile, "dj_auto.mp3", true);
        console.log("✅ Ciclo automático completado con éxito.");
    } catch (e) {
        console.error("⚠️ Error en ciclo:", e.message);
    }
}

// Intervalo cada 15 min
setInterval(tick, 15 * 60 * 1000);

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
    // Delay largo para asegurar que Koyeb pase el Health Check antes de empezar FFmpeg
    setTimeout(tick, 60000); 
});
