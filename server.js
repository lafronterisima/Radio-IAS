require('dotenv').config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");

const app = express();
app.use(express.json());

// ======= CONFIGURACIÓN DE VARIABLES =======
const API_KEY_GEMINI = process.env.GOOGLE_API_KEY;
const AZURA_KEY = process.env.AZURA_KEY;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_REGION;
const STATION_ID = process.env.STATION_ID || "24"; 
const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${STATION_ID}/files/upload`;

// ======= 1. LÓGICA DE REDACCIÓN (SOLUCIÓN ERROR 404) =======
async function redactarIA(idea, datos = null) {
    try {
        const prompt = datos 
            ? `Locutor de "La Fronterísima" en Cali. Hora ${datos.hora}, Temp ${datos.temp}°C. Guion corto (30 palabras). Eslogan: "Notas surcando fronteras".`
            : `Idea: ${idea}. Genera un guion de radio fluido (40 palabras). Eslogan: "Notas surcando fronteras". Solo texto plano.`;

        // URL CORREGIDA: v1beta y modelo base sin "-latest" para evitar el 404
       const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY_GEMINI}`;
        
        const response = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }]
        });

        const texto = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return texto.replace(/[*#]/g, '').replace(/Locutor:|Guion:/gi, '').trim();
    } catch (error) {
        console.error("❌ Error Gemini:", error.response?.data || error.message);
        return "Sintonizas La Fronterísima, la emisora que te acompaña con la mejor energía. Notas surcando fronteras.";
    }
}

// ======= 2. GENERACIÓN DE VOZ (AZURE) =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
        speechConfig.speechSynthesisVoiceName = "es-CO-GonzaloNeural";
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
        
        const ssml = `
            <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO">
                <voice name="es-CO-GonzaloNeural">
                    <prosody rate="1.0" pitch="-2%">${texto}</prosody>
                </voice>
            </speak>`;

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

// ======= 3. PRODUCCIÓN FFmpeg Y SUBIDA (SOLUCIÓN ERROR $FILE) =======
async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `final_${Date.now()}.mp3`;
    return new Promise((resolve, reject) => {
        const comando = (conFondo && fs.existsSync("fondo.mp3"))
            ? `ffmpeg -y -i fondo.mp3 -i ${archivoVoz} -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.4[v];[bg][v]sidechaincompress=threshold=0.1:ratio=15[out]" -map "[out]" -shortest -c:a libmp3lame -b:a 128k ${tempSalida}`
            : `ffmpeg -y -i ${archivoVoz} -af "volume=1.3" -c:a libmp3lame -b:a 128k ${tempSalida}`;

        exec(comando, async (err) => {
            if (err) return reject("Error FFmpeg: " + err);
            try {
                const form = new FormData();
                const fileStream = fs.createReadStream(tempSalida);
                
                // IMPORTANTE: Definir el campo 'file' explícitamente para AzuraCast
                form.append('file', fileStream, {
                    filename: nombreFinal,
                    contentType: 'audio/mpeg',
                });
                form.append('path', nombreFinal);

                await axios.post(AZURA_API_UPLOAD, form, {
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
                reject("Error de subida");
            }
        });
    });
}

// ======= 4. FRONTEND INTEGRADO =======
app.get("/", (req, res) => {
    res.send(`
    <html>
        <head>
            <title>Fronterisima DJ Pro</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <style>
                .btn-ai { background: linear-gradient(90deg, #4f46e5, #9333ea); color: white; }
                .status-loading { color: #fbbf24; font-weight: bold; }
                .status-success { color: #34d399; font-weight: bold; }
                .status-error { color: #f87171; font-weight: bold; }
            </style>
        </head>
        <body class="bg-slate-900 text-white flex items-center justify-center min-h-screen p-4">
            <div class="bg-slate-800 p-8 rounded-3xl shadow-2xl w-full max-w-lg border border-slate-700">
                <div class="text-center mb-8">
                    <h1 class="text-3xl font-black text-blue-400 tracking-tighter uppercase">La Fronterísima</h1>
                    <p class="text-slate-400 text-sm">Notas surcando fronteras</p>
                </div>
                <div class="space-y-6">
                    <div>
                        <label class="block text-xs font-bold text-slate-500 uppercase mb-2">1. ¿Qué quieres decir hoy?</label>
                        <div class="flex gap-2">
                            <input type="text" id="ideaInput" class="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-sm" placeholder="Ej: Invitación al festival de Cali">
                            <button id="btnRedactar" onclick="redactarManual()" class="btn-ai px-4 py-2 rounded-xl text-sm font-bold active:scale-95 transition-all">✨ Redactar</button>
                        </div>
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-slate-500 uppercase mb-2">2. Guion de Locución</label>
                        <textarea id="guionText" rows="4" class="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-sm text-slate-300 italic"></textarea>
                    </div>
                    <div class="grid grid-cols-1 gap-4">
                        <input type="text" id="filename" class="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-sm" placeholder="nombre_archivo">
                        <label class="flex items-center gap-3 cursor-pointer bg-slate-900 p-3 rounded-xl border border-slate-700">
                            <input type="checkbox" id="conFondo" checked class="w-5 h-5">
                            <span class="text-xs text-slate-300">Incluir fondo musical automático</span>
                        </label>
                    </div>
                    <button id="btnProduccion" onclick="procesarProduccion()" class="w-full bg-blue-600 p-4 rounded-2xl font-black text-lg hover:bg-blue-500 transition-all shadow-lg">🚀 PRODUCIR Y SUBIR</button>
                    <div id="status-box" class="text-center text-sm py-2 min-h-[40px]"></div>
                    <div class="flex justify-between items-center pt-4 border-t border-slate-700 text-[10px] text-slate-500 font-mono">
                        <span>🎙️ VOZ: GONZALO NEURAL</span>
                        <span id="reloj-digital">00:00:00</span>
                    </div>
                </div>
            </div>
            <script>
                function updateReloj() { document.getElementById('reloj-digital').innerText = new Date().toLocaleTimeString(); }
                setInterval(updateReloj, 1000);
                function showStatus(msg, type) {
                    const box = document.getElementById('status-box');
                    box.innerText = msg;
                    box.className = 'text-center text-sm py-2 status-' + type;
                }
                async function redactarManual() {
                    const idea = document.getElementById('ideaInput').value;
                    if(!idea) return alert("Escribe una idea.");
                    showStatus("🤖 Gemini redactando...", "loading");
                    const res = await fetch('/redactar-guion', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ idea })
                    });
                    const data = await res.json();
                    document.getElementById('guionText').value = data.guion;
                    showStatus("✅ Guion listo.", "success");
                }
                async function procesarProduccion() {
                    const texto = document.getElementById('guionText').value;
                    let nombre = document.getElementById('filename').value.trim();
                    const conFondo = document.getElementById('conFondo').checked;
                    if(!texto || !nombre) return alert("Falta guion o nombre.");
                    nombre = nombre.replace(/[^a-z0-9_]/gi, '_').toLowerCase() + ".mp3";
                    showStatus("🎙️ Procesando audio y subiendo...", "loading");
                    const res = await fetch('/procesar-locucion', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ texto, nombreArchivo: nombre, conFondo })
                    });
                    if(res.ok) showStatus("🚀 ¡ÉXITO! Enviado a AzuraCast.", "success");
                    else showStatus("❌ Error en el proceso.", "error");
                }
            </script>
        </body>
    </html>`);
});

// ======= 5. ENDPOINTS DE API =======
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

// ======= 6. AUTOMATIZACIÓN (CADA 15 MIN) =======
async function tick() {
    console.log(`🎙️ [${new Date().toLocaleTimeString()}] Reporte automático...`);
    const autoFile = `auto_${Date.now()}.mp3`;
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const datos = { 
            hora: new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' }),
            temp: Math.round(clim.data.current_weather.temperature),
            titular: "lo mejor de La Fronterísima"
        };
        const guion = await redactarIA(null, datos);
        await generarVoz(guion, autoFile);
        await producirYSubir(autoFile, "dj_auto.mp3", true);
        console.log("✅ Ciclo completado.");
    } catch (e) { console.error("⚠️ Error en ciclo:", e.message); }
}

setInterval(tick, 15 * 60 * 1000);

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
    // Esperamos 60 segundos antes del primer reporte para que Koyeb pase el Health Check
    setTimeout(tick, 60000); 
});
