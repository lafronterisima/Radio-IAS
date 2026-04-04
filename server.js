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

// 1. SERVIR FRONTEND Y HEALTH CHECK
app.get("/health", (req, res) => {
    res.status(200).send("OK - La Fronterísima is live");
});

// ======= CONFIGURACIÓN DE VARIABLES =======
// Asegúrate de que estos nombres coincidan con tu panel de Koyeb/Render
const API_KEY_GEMINI = process.env.GOOGLE_API_KEY; 
const AZURA_KEY = process.env.AZURA_KEY;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const STATION_ID = process.env.STATION_ID || "24"; 
const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${STATION_ID}/files/upload`;

// ======= 2. LÓGICA DE REDACCIÓN (GEMINI 1.5 FLASH) =======
async function redactarIA(idea, datos = null) {
    try {
        const prompt = datos 
            ? `Eres locutora de "La Fronterísima" en Cali. Hora ${datos.hora}, Temp ${datos.temp}°C. Genera un saludo corto y alegre de 30 palabras con el eslogan: "Notas surcando fronteras". Menciona algo breve sobre el clima de Cali.`
            : `Idea: ${idea}. Genera un guion de locución de 40 palabras para la emisora La Fronterísima. Incluye el eslogan: "Notas surcando fronteras". Sé muy dinámica.`;

        // Endpoint v1beta es el más robusto para evitar errores 404 de modelos
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY_GEMINI}`;
        
        const response = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }]
        });

        const texto = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return texto.replace(/[*#]/g, '').replace(/Locutor:|Guion:/gi, '').trim();
    } catch (error) {
        console.error("❌ Error Gemini:", error.response?.data || error.message);
        return "Sintonizas La Fronterísima, la emisora que te acompaña con la mejor energía desde Cali. Notas surcando fronteras.";
    }
}

// ======= 3. GENERACIÓN DE VOZ (AZURE) =======
async function generarVoz(texto, archivoDestino) {
    if (!AZURE_KEY || !AZURE_REGION) {
        throw new Error("Faltan credenciales de Azure Speech Key/Region.");
    }
    return new Promise((resolve, reject) => {
        const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
        speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural"; 
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
        
        const ssml = `
            <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" 
                   xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="es-CO">
                <voice name="es-CO-SalomeNeural">
                    <mstts:express-as style="cheerful" styledegree="1.5">
                        <prosody rate="+10%" pitch="+5%">
                            ${texto}
                        </prosody>
                    </mstts:express-as>
                </voice>
            </speak>`;

        synthesizer.speakSsmlAsync(ssml, result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync(archivoDestino, Buffer.from(result.audioData));
                synthesizer.close();
                resolve();
            } else {
                synthesizer.close();
                reject("Error en síntesis de Azure: " + result.errorDetails);
            }
        }, err => { synthesizer.close(); reject(err); });
    });
}

// ======= 4. MEZCLA FFmpeg Y SUBIDA =======
async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `final_${Date.now()}.mp3`;
    return new Promise((resolve, reject) => {
        // AJUSTE PROFESIONAL: Sidechain (baja la música cuando hay voz)
        const comando = (conFondo && fs.existsSync("fondo.mp3"))
            ? `ffmpeg -y -i fondo.mp3 -i ${archivoVoz} -filter_complex "[0:a]volume=0.12[bg];[1:a]volume=1.5,bass=g=3[v];[bg][v]sidechaincompress=threshold=0.05:ratio=20:attack=10:release=500[out]" -map "[out]" -shortest -c:a libmp3lame -b:a 128k ${tempSalida}`
            : `ffmpeg -y -i ${archivoVoz} -af "volume=1.4,bass=g=3" -c:a libmp3lame -b:a 128k ${tempSalida}`;

        exec(comando, async (err) => {
            if (err) return reject("Error FFmpeg: " + err);
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), {
                    filename: nombreFinal,
                    contentType: 'audio/mpeg',
                });
                form.append('path', nombreFinal);

                await axios.post(AZURA_API_UPLOAD, form, {
                    headers: { ...form.getHeaders(), "X-API-Key": AZURA_KEY }
                });

                if (fs.existsSync(archivoVoz)) fs.unlinkSync(archivoVoz);
                if (fs.existsSync(tempSalida)) fs.unlinkSync(tempSalida);
                resolve();
            } catch (e) {
                console.error("❌ Error AzuraCast:", e.response?.data || e.message);
                reject("Error de subida a la radio.");
            }
        });
    });
}

// ======= 5. RUTAS DEL SERVIDOR =======
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

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
        console.error("❌ Error en proceso:", e);
        res.status(500).send(e.toString());
    }
});

// ======= 6. AUTOMATIZACIÓN (CADA 15 MIN) =======
async function tick() {
    console.log(`🎙️ [${new Date().toISOString()}] Iniciando reporte para Cali...`);
    const autoFile = `auto_${Date.now()}.mp3`;
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const datos = { 
            hora: new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' }),
            temp: Math.round(clim.data.current_weather.temperature)
        };
        const guion = await redactarIA(null, datos);
        await generarVoz(guion, autoFile);
        await producirYSubir(autoFile, "dj_auto.mp3", true);
        console.log("✅ Reporte automático enviado exitosamente.");
    } catch (e) {
        console.error("⚠️ Fallo en el reporte automático:", e.message);
    }
}

// ======= 7. ARRANQUE =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro operando en puerto ${PORT}`);
    
    // Retraso de 5 min para salud del servidor en la nube
    setTimeout(() => {
        tick();
        setInterval(tick, 15 * 60 * 1000);
    }, 300000); 
});
