
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

// ======= 1. NÚCLEO DE INTELIGENCIA (FAILOVER) =======
async function redactarIA(idea, datos = null) {
    const prompt = datos 
        ? `Eres locutora de "La Fronterísima" en Cali. Hora ${datos.hora}, Temp ${datos.temp}°C. Saludo alegre de 30 palabras con el eslogan: "Notas surcando fronteras". Menciona el clima de Cali.`
        : `Idea: ${idea}. Genera un guion de locución de 40 palabras para la emisora La Fronterísima. Incluye el eslogan: "Notas surcando fronteras".`;

    // INTENTO 1: GEMINI
    try {
        console.log("🤖 Intentando con Gemini...");
        const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(urlGemini, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 5000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
    } catch (e) {
        console.warn("⚠️ Gemini falló, saltando a Groq...");
    }

    // INTENTO 2: GROQ
    try {
        console.log("⚡ Usando Respaldo: Groq Cloud");
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [{ role: "system", content: "Locutora profesional de Cali, Colombia. Responde SOLO con el guion." }, { role: "user", content: prompt }]
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
    return t.replace(/[*#_]/g, '').replace(/Locutor:|Guion:|Respuesta:/gi, '').trim();
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
    const fondoExiste = fs.existsSync("fondo.mp3");

    return new Promise((resolve, reject) => {
        const cmd = (conFondo && fondoExiste)
    ? `ffmpeg -y -i fondo.mp3 -i ${archivoVoz} -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
    : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;

        exec(cmd, async (err, stdout, stderr) => {
            if (err) {
                console.error("FFmpeg Error:", stderr);
                return reject("FFmpeg Error");
            }
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
                if (fs.existsSync(tempSalida)) fs.unlinkSync(tempSalida);
                reject("Error Subida Azura");
            }
        });
    });
}

// ======= 4. RUTAS =======
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

// FRONTEND INTEGRADO
app.get("/", (req, res) => {
    res.send(`
    <html>
        <head>
            <title>La Fronterísima Pro</title>
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-slate-900 text-white flex items-center justify-center min-h-screen p-4">
            <div class="bg-slate-800 p-8 rounded-3xl shadow-2xl w-full max-w-lg border border-slate-700">
                <h1 class="text-3xl font-black text-blue-400 text-center uppercase mb-6">La Fronterísima</h1>
                <div class="space-y-4">
                    <input type="text" id="idea" class="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-sm" placeholder="Idea para el guion...">
                    <button onclick="redactar()" class="w-full bg-indigo-600 p-3 rounded-xl font-bold">✨ Redactar Guion</button>
                    <textarea id="guion" rows="4" class="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-sm text-slate-300"></textarea>
                    <input type="text" id="filename" class="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-sm" placeholder="nombre_archivo (ej: promo_lunes)">
                    <button onclick="producir()" class="w-full bg-green-600 p-4 rounded-2xl font-black text-lg shadow-lg">🚀 PRODUCIR Y SUBIR</button>
                    <div id="status" class="text-center text-sm font-bold min-h-[20px]"></div>
                </div>
            </div>
            <script>
                async function redactar() {
                    const idea = document.getElementById('idea').value;
                    document.getElementById('status').innerText = "🤖 Redactando...";
                    const res = await fetch('/redactar-guion', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ idea })
                    });
                    const data = await res.json();
                    document.getElementById('guion').value = data.guion;
                    document.getElementById('status').innerText = "";
                }
                async function producir() {
                    const texto = document.getElementById('guion').value;
                    const nombre = document.getElementById('filename').value || "locucion";
                    document.getElementById('status').innerText = "🎙️ Procesando audio...";
                    const res = await fetch('/procesar-locucion', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ texto, nombreArchivo: nombre + ".mp3", conFondo: true })
                    });
                    if(res.ok) document.getElementById('status').innerText = "✅ Éxito al subir.";
                    else document.getElementById('status').innerText = "❌ Error.";
                }
            </script>
        </body>
    </html>`);
});

// ======= 5. AUTOMATIZACIÓN =======
async function autoReporte() {
    console.log("🎙️ Generando reporte automático...");
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const datos = { 
            hora: new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' }),
            temp: Math.round(clim.data.current_weather.temperature)
        };
        const guion = await redactarIA(null, datos);
        const pathAuto = `v_auto.mp3`;
        await generarVoz(guion, pathAuto);
        await producirYSubir(pathAuto, "reporte_cali.mp3", true);
        console.log("✅ Reporte subido.");
    } catch (e) { console.error("❌ Fallo en tick:", e.message); }
}

// ======= 6. ARRANQUE =======
// ======= 6. ARRANQUE =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor listo y escuchando en puerto: ${PORT}`);
    
    // IMPORTANTE: Aumentamos el retraso a 1 minuto (60000 ms) 
    // para que Koyeb termine de hacer el Health Check con calma.
    setTimeout(() => {
        console.log("▶️ Iniciando primer reporte automático...");
        autoReporte();
        setInterval(autoReporte, 15 * 60 * 1000);
    }, 60000); 
});
