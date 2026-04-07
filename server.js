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

// ======= CONFIGURACIÓN DE VARIABLES =======
const KEYS = {
    GEMINI: process.env.GOOGLE_API_KEY,
    GROQ: process.env.GROQ_API_KEY,
    AZURE: process.env.AZURE_SPEECH_KEY,
    AZURE_REGION: process.env.AZURE_REGION,
    AZURA: process.env.AZURA_KEY,
    STATION_ID: process.env.STATION_ID || "24",
    STATION_URL: process.env.STATION_URL || "https://az.azurafree.eu",
    PASSWORD: process.env.APP_PASSWORD,
    KOYEB_URL: "https://indirect-kelsi-lafronterisima-c6a755f2.koyeb.app"
};

const AZURA_API_UPLOAD = `${KEYS.STATION_URL}/api/station/${KEYS.STATION_ID}/files/upload`;
const AZURA_API_NOWPLAYING = `${KEYS.STATION_URL}/api/nowplaying/${KEYS.STATION_ID}`;

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.status(200).send("LIVE"));

// ======= 1. OBTENER CANCIÓN ACTUAL =======
async function obtenerCancionActual() {
    try {
        const res = await axios.get(AZURA_API_NOWPLAYING, { timeout: 5000 });
        const np = res.data[0]?.now_playing?.song || res.data?.now_playing?.song;
        return np ? `${np.title} de ${np.artist}` : "la mejor selección musical";
    } catch (e) { return "nuestra programación especial"; }
}

// ======= 2. OBTENER NOTICIAS (CON FALLBACK) =======
async function obtenerNoticia() {
    try {
        const res = await axios.get("https://news.google.com/rss/search?q=source:Euronews+espanol&hl=es-419&gl=CO&ceid=CO:es-419", {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const match = res.data.match(/<title>([^<]+)<\/title>/g);
        if (match && match.length > 2) {
            return match[Math.floor(Math.random() * 3) + 1].replace(/<title>|<\/title>/g, '').split(' - ')[0].trim();
        }
    } catch (e) { console.warn("⚠️ Error en Noticias RSS"); }
    return "El mundo sigue en movimiento con la mejor información.";
}

// ======= 3. REDACCIÓN CON IA (GEMINI + GROQ) =======
async function redactarIA(idea, datos = null) {
    const cancion = await obtenerCancionActual();
    const hora = datos ? datos.hora : new Date().toLocaleTimeString("es-CO", {hour:'2-digit', minute:'2-digit'});
    
    const prompt = datos 
        ? `Eres la locutora de "La Fronterísima". Reporte: ${hora}, Temp: ${datos.temp}°C, Noticia: ${datos.noticia}. Música: "${cancion}". Crea un guion de 40 palabras en español neutro colombiano. Termina: "La Fronterisima, notas surcando fronteras".`
        : `Locutora de "La Fronterísima". Saludo carismático de 35 palabras mencionando "${cancion}". Termina: "La Fronterisima, notas surcando fronteras".`;

    // Intento 1: Gemini
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 12000 });
        return limpiarTexto(res.data.candidates[0].content.parts[0].text);
    } catch (e) {
        console.warn("⚠️ Gemini falló, intentando Groq...");
        // Intento 2: Groq
        try {
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: prompt }]
            }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 8000 });
            return limpiarTexto(res.data.choices[0].message.content);
        } catch (err) {
            return `Hola Colombia, son las ${hora}. Disfrutamos de ${cancion} en La Fronterisima, notas surcando fronteras.`;
        }
    }
}

function limpiarTexto(t) {
    return t.replace(/[*#_]/g, '').replace(/Locutor:|Guion:|Respuesta:|Locutora:/gi, '').trim();
}

// ======= 4. VOZ Y FFmpeg =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
        const synth = new sdk.SpeechSynthesizer(config);
        const ssml = `<speak version="1.0" xml:lang="es-CO"><voice name="es-CO-SalomeNeural"><mstts:express-as style="cheerful" xmlns:mstts="https://www.w3.org/2001/mstts"><prosody rate="+5%">${texto}</prosody></mstts:express-as></voice></speak>`;
        synth.speakSsmlAsync(ssml, r => {
            if (r.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync(archivoDestino, Buffer.from(r.audioData));
                synth.close(); resolve();
            } else { synth.close(); reject("Error TTS"); }
        }, e => { synth.close(); reject(e); });
    });
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondoExiste = fs.existsSync("fondo.mp3");
    const cmd = (conFondo && fondoExiste)
        ? `ffmpeg -y -i fondo.mp3 -i ${archivoVoz} -filter_complex "[0:a]volume=0.10[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;

    return new Promise((resolve, reject) => {
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
            } catch (e) { reject("Error Subida Azura"); }
        });
    });
}

// ======= 5. REPORTE AUTOMÁTICO (INDESTRUCTIBLE) =======

async function autoReporte() {
    console.log("🎙️ Generando reporte con clima real...");
    
    // 1. Obtener la temperatura real primero
    const t = await obtenerClimaReal();
    
    // 2. Obtener la noticia
    let n = "El panorama nacional e internacional se mantiene en movimiento.";
    try { n = await obtenerNoticia(); } catch(e) { console.warn("Error en noticia"); }

    try {
        // 3. Pasar los datos reales a la IA
        const guion = await redactarIA(null, { 
            hora: new Date().toLocaleTimeString("es-CO", { 
                hour: '2-digit', 
                minute: '2-digit', 
                timeZone: 'America/Bogota' 
            }), 
            temp: t, // Aquí va la temperatura real
            noticia: n 
        });

        const p = `v_${Date.now()}.mp3`;
        await generarVoz(guion, p);
        await producirYSubir(p, "dj_auto.mp3", true);
        console.log(`✅ Reporte enviado a Azura con ${t} grados.`);
    } catch(e) { 
        console.error("Fallo crítico en reporte:", e.message); 
    }

// ======= INICIO =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Puerto ${PORT}`);
    
    // Ciclos
    setTimeout(() => {
        autoReporte();
        setInterval(autoReporte, 15 * 60 * 1000);
    }, 10000);

    // Supervivencia Koyeb
    setInterval(() => {
        axios.get(`${KEYS.KOYEB_URL}/health`).catch(() => {});
    }, 4 * 60 * 1000);
});
