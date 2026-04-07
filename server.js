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

// ======= SEGURIDAD Y FRONTEND =======
app.use(express.static(path.join(__dirname, "public")));

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) return res.json({ success: true });
    res.status(401).json({ success: false, message: "Clave incorrecta" });
});

app.get("/health", (req, res) => res.status(200).send("LIVE"));

// ======= 1. OBTENER CANCIÓN ACTUAL (AZURACAST) =======
async function obtenerCancionActual() {
    try {
        const res = await axios.get(AZURA_API_NOWPLAYING, { timeout: 4000 });
        const np = res.data[0]?.now_playing?.song || res.data?.now_playing?.song;
        return np ? `${np.title} de ${np.artist}` : "la mejor selección musical";
    } catch (e) {
        return "nuestra programación especial";
    }
}

// ======= 2. OBTENER NOTICIAS (RSS MUNDIAL) =======
async function obtenerNoticia() {
    try {
        const res = await axios.get("https://news.google.com/rss/search?q=source:Euronews+espanol&hl=es-419&gl=CO&ceid=CO:es-419", {
            timeout: 7000,
            headers: { 'User-Agent': 'Mozilla/5.0 (LaFronterisima-Bot)' }
        });
        const match = res.data.match(/<title>([^<]+)<\/title>/g);
        if (match && match.length > 2) {
            const index = Math.floor(Math.random() * (match.length - 2)) + 1;
            return match[index].replace(/<title>|<\/title>/g, '').replace(/<!\[CDATA\[|\]\]>/g, '').split(' - ')[0].trim();
        }
        return "El panorama mundial se mantiene en constante movimiento.";
    } catch (e) { return "Información internacional en desarrollo para todos ustedes."; }
}

// ======= 3. INTELIGENCIA ARTIFICIAL (LENGUAJE NEUTRO COLOMBIA) =======
async function redactarIA(idea, datos = null) {
    let prompt;
    const cancion = await obtenerCancionActual();
    const horaActual = new Date().getHours();
    
    let saludo = "Buen día";
    if (horaActual >= 12 && horaActual < 18) saludo = "Feliz tarde";
    if (horaActual >= 18 || horaActual < 5) saludo = "Feliz noche";

    if (datos) {
        prompt = `Eres la locutora oficial de "La Fronterísima". Lenguaje: Español Neutro de Colombia.
        CONTEXTO: ${saludo}. Colombia registra ${datos.temp}°C. Noticia: ${datos.noticia}.
        MÚSICA: Presenta brevemente que suena "${cancion}".
        GUION: Crea una intervención de 45 palabras. Tono profesional y cálido. 
        Menciona la hora (${datos.hora}). Termina con: "La Fronterisima, notas surcando fronteras".`;
    } else if (idea && idea.trim() !== "") {
        prompt = `Locutora de "La Fronterísima". Estilo Neutro Colombiano.
        IDEA: ${idea}. MÚSICA: "${cancion}".
        Redacta un guion carismático de 40 palabras integrando la idea y la canción.
        Termina con: "La Fronterisima, notas surcando fronteras".`;
    } else {
        prompt = `Eres la voz de "La Fronterísima". Genera un saludo institucional de 30 palabras.
        Menciona que disfrutamos de "${cancion}". Tono amable y optimista para toda Colombia.
        Termina con: "La Fronterisima, notas surcando fronteras".`;
    }

    // Intento con Gemini (Timeout extendido para evitar fallos)
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 12000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
    } catch (e) { console.warn("⚠️ Gemini lento o falló, usando Groq..."); }

    // Respaldo con Groq
    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [{ role: "system", content: "Locutora profesional colombiana, lenguaje neutro." }, { role: "user", content: prompt }]
        }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 8000 });
        return limpiarTexto(res.data?.choices?.[0]?.message?.content);
    } catch (e) { return `Sintonizan La Fronterísima. Disfrutamos de ${cancion}. Notas surcando fronteras.`; }
}

function limpiarTexto(t) {
    return t.replace(/[*#_]/g, '').replace(/Locutor:|Guion:|Respuesta:|Locutora:/gi, '').trim();
}

// ======= 4. VOZ Y PRODUCCIÓN =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural"; 
        const synth = new sdk.SpeechSynthesizer(config);
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural"><mstts:express-as style="cheerful" styledegree="1.1">
            <prosody rate="+5%">${texto}</prosody></mstts:express-as></voice></speak>`;
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
    return new Promise((resolve, reject) => {
        const cmd = (conFondo && fondoExiste)
            ? `ffmpeg -y -i fondo.mp3 -i ${archivoVoz} -filter_complex "[0:a]volume=0.12[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
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
            } catch (e) { reject("Error Azura"); }
        });
    });
}

// ======= 5. RUTAS PARA EL PANEL =======
app.post("/redactar-guion", async (req, res) => {
    const guion = await redactarIA(req.body.idea || "");
    res.json({ guion });
});

app.post("/procesar-locucion", async (req, res) => {
    const { texto, conFondo } = req.body;
    const pathVoz = `v_${Date.now()}.mp3`;
    try {
        await generarVoz(texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send(e.toString()); }
});

// ======= 6. CICLOS AUTOMÁTICOS =======
async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=4.57&longitude=-74.30&current_weather=true", { timeout: 5000 }); 
        const noticia = await obtenerNoticia();
        const datos = { 
            hora: new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' }),
            temp: Math.round(clim.data.current_weather.temperature),
            noticia
        };
        const guion = await redactarIA(null, datos);
        const pathAuto = `v_auto_${Date.now()}.mp3`;
        await generarVoz(guion, pathAuto);
        await producirYSubir(pathAuto, "dj_auto.mp3", true);
        console.log(`✅ Auto-Reporte exitoso (${datos.hora})`);
    } catch (e) { console.error("Error Auto-Reporte:", e.message); }
}

async function autoManual() {
    try {
        const guion = await redactarIA(""); 
        const pathVoz = `v_hr_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
        console.log("✅ Refuerzo horario actualizado.");
    } catch (e) { console.error("Error Auto-Manual:", e.message); }
}

// ======= INICIO DEL SERVIDOR =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro en puerto ${PORT}`);
    
    // Primer reporte a los 10 segundos del inicio
    setTimeout(() => {
        autoReporte();
        setInterval(autoReporte, 15 * 60 * 1000); 
        setInterval(autoManual, 60 * 60 * 1000); 
    }, 10000);

    // Self-Ping Mejorado para Koyeb (Evita que la instancia se detenga)
    setInterval(async () => {
        try {
            await axios.get(`${KEYS.KOYEB_URL}/health`, { timeout: 5000 });
            console.log("⚓ Self-ping: Pulso de vida enviado.");
        } catch (e) {
            console.warn("⚠️ Self-ping fallido, pero el servidor sigue escuchando.");
        }
    }, 5 * 60 * 1000); // Cada 5 minutos
});
