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

// ======= CONEXIÓN CON EL FRONTEND (Carpeta Public) =======
// Esta línea permite que al entrar a la URL se cargue tu index.html
app.use(express.static(path.join(__dirname, "public")));

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

// ======= 1. OBTENER NOTICIAS REALES (RSS) =======
async function obtenerNoticia() {
    try {
        const res = await axios.get("https://news.google.com/rss/search?q=Colombia+Cali&hl=es-419&gl=CO&ceid=CO:es-419");
        const match = res.data.match(/<title>([^<]+)<\/title>/g);
        if (match && match.length > 2) {
            const index = Math.floor(Math.random() * (match.length - 1)) + 1;
            return match[index].replace(/<title>|<\/title>/g, '').split(' - ')[0];
        }
        return "El mundo sigue girando con la mejor energía.";
    } catch (e) {
        return "Nuevas tendencias en tecnología y música surcan las fronteras.";
    }
}

// ======= 2. NÚCLEO DE INTELIGENCIA (FAILOVER) =======
async function redactarIA(idea, datos = null) {
    let prompt;
    if (datos) {
        prompt = `Eres la locutora estrella de "La Fronterísima" en Cali. 
        DATOS ACTUALES: Hora: ${datos.hora}, Clima: ${datos.temp}°C, Noticia: ${datos.noticia}.
        INSTRUCCIÓN: Crea un guion alegre de 45 palabras. Debes incluir la hora, la temperatura de Cali y mencionar la noticia. 
        Termina siempre con el eslogan: "Notas surcando fronteras". 
        SOLO responde con el texto de locución, sin títulos ni etiquetas.`;
    } else {
        prompt = `Idea: ${idea}. Genera un guion de locución de 40 palabras para la emisora La Fronterísima. Incluye el eslogan: "Notas surcando fronteras".`;
    }

    try {
        console.log("🤖 Intentando con Gemini...");
        const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(urlGemini, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 6000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
    } catch (e) {
        console.warn("⚠️ Gemini falló, saltando a Groq...");
    }

    try {
        console.log("⚡ Usando Respaldo: Groq Cloud (Llama 3.1)");
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: "Locutora profesional colombiana. Natural, alegre y concisa." },
                { role: "user", content: prompt }
            ]
        }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 6000 });
        return limpiarTexto(res.data?.choices?.[0]?.message?.content);
    } catch (e) {
        return `Son las ${datos?.hora || 'un nuevo momento'} en Cali, con ${datos?.temp || 'un clima increíble'} grados. Notas surcando fronteras.`;
    }
}

function limpiarTexto(t) {
    return t.replace(/[*#_]/g, '')
            .replace(/Locutor:|Guion:|Respuesta:|Locutora:|Titular:|Noticia:/gi, '')
            .trim();
}

// ======= 3. SÍNTESIS DE VOZ (AZURE) =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
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

// ======= 4. PRODUCCIÓN (FFMPEG) Y SUBIDA =======
async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondoExiste = fs.existsSync("fondo.mp3");

    return new Promise((resolve, reject) => {
        const cmd = (conFondo && fondoExiste)
            ? `ffmpeg -y -i fondo.mp3 -i ${archivoVoz} -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
            : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;

        exec(cmd, async (err) => {
            if (err) return reject("FFmpeg Error");
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

// ======= 5. RUTAS DE API =======
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

async function autoReporte() {
    console.log("🎙️ Iniciando ciclo completo: Hora + Clima + Noticias...");
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const noticiaFresca = await obtenerNoticia();
        
        const datos = { 
            hora: new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' }),
            temp: Math.round(clim.data.current_weather.temperature),
            noticia: noticiaFresca
        };

        const guion = await redactarIA(null, datos);
        const pathAuto = `v_auto.mp3`;
        
        await generarVoz(guion, pathAuto);
        await producirYSubir(pathAuto, "reporte_cali.mp3", true);
        console.log(`✅ Ciclo exitoso. Hora: ${datos.hora}.`);
    } catch (e) { 
        console.error("❌ Fallo en ciclo automático:", e.message); 
    }
}

// ======= 6. ARRANQUE =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor Pro de La Fronterísima en puerto ${PORT}`);
    
    setTimeout(() => {
        autoReporte();
        setInterval(autoReporte, 15 * 60 * 1000); 
    }, 60000); 
});
