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

// ======= 1. CONFIGURACIÓN Y LLAVES =======
const KEYS = {
    GEMINI: process.env.GOOGLE_API_KEY,
    GROQ: process.env.GROQ_API_KEY,
    AZURE: process.env.AZURE_SPEECH_KEY,
    AZURE_REGION: process.env.AZURE_REGION,
    AZURA: process.env.AZURA_KEY,
    STATION_ID: process.env.STATION_ID || "24",
    PASSWORD: process.env.APP_PASSWORD,
    URL_APP: process.env.URL_APP || `http://localhost:${process.env.PORT || 8000}`
};

const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;

app.use(express.static(path.join(__dirname, "public")));

// ======= 2. VALIDACIÓN / LOGIN =======
app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === KEYS.PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Clave incorrecta" });
    }
});

// ======= 3. FUNCIONES DE DATOS (MÚSICA Y NOTICIAS) =======

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`https://az.azurafree.eu/api/nowplaying/${KEYS.STATION_ID}`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios artistas", titulo: "la mejor música" };
    } catch (e) {
        return { artista: "varios artistas", titulo: "tu música favorita" };
    }
}

async function obtenerNoticiasBBC() {
    try {
        const res = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml", { timeout: 5000 });
        const matches = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>([^<]+)<\/title>/g);
        if (matches && matches.length > 2) {
            const n1 = matches[1].replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').trim();
            const n2 = matches[2].replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').trim();
            return `${n1}. Además: ${n2}`;
        }
        return "El mundo sigue vibrando con la mejor energía.";
    } catch (e) {
        return "Sigue en sintonía para más información.";
    }
}

// ======= 4. INTELIGENCIA ARTIFICIAL (FAILOVER) =======
async function redactarIA(promptPersonalizado) {
    // Intento 1: Gemini
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: promptPersonalizado }] }] }, { timeout: 6000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
    } catch (e) { console.warn("⚠️ Gemini falló, usando Groq..."); }

    // Intento 2: Groq
    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [{ role: "system", content: "Locutora colombiana alegre y profesional." }, { role: "user", content: promptPersonalizado }]
        }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 6000 });
        return limpiarTexto(res.data?.choices?.[0]?.message?.content);
    } catch (e) { return "Sintonizas La Fronterísima, notas surcando fronteras."; }
}

function limpiarTexto(t) {
    return t.replace(/[*#_]/g, '').replace(/Locutor:|Guion:|Respuesta:|Locutora:/gi, '').trim();
}

// ======= 5. VOZ Y PRODUCCIÓN =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural"; 
        const synth = new sdk.SpeechSynthesizer(config);
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural"><mstts:express-as style="cheerful" styledegree="1.4">
            <prosody rate="+8%">${texto}</prosody></mstts:express-as></voice></speak>`;
        
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
            } catch (e) { reject("Error Azura"); }
        });
    });
}

// ======= 6. RUTAS API =======
app.get("/health", (req, res) => res.status(200).send("OK"));

app.post("/redactar-guion", async (req, res) => {
    const guion = await redactarIA(req.body.idea);
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

// ======= 7. AUTOMATIZACIONES =======

// A. Reporte de noticias y música (15 min -> dj_auto.mp3)
async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const bbc = await obtenerNoticiasBBC();
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' });
        const temp = Math.round(clim.data.current_weather.temperature);

        // Busca esta parte en tu función autoReporte y cámbiala:
 const prompt = `Eres locutora estrella de La Fronterísima. 
        IMPORTANTE: Debes empezar diciendo la hora exacta: ${hora}.
        Contexto: Temperatura de ${temp}°C. 
        Música que suena: "${np.titulo}" de ${np.artista}. 
        Noticias BBC Mundo: ${bbc}.
        Instrucción: Crea un guion dinámico de 50 palabras. Menciona la hora PRIMERO, luego la música, el clima nacional y las noticias. 
        No menciones ciudades. Habla para toda nuestra audiencia.
        Termina con el eslogan: "La Fronterísima, notas surcando fronteras". SOLO el texto del guion.`;

        const guion = await redactarIA(prompt);
        const pathAuto = `v_auto.mp3`;
        await generarVoz(guion, pathAuto);
        await producirYSubir(pathAuto, "dj_auto.mp3", true);
        console.log("✅ Auto-Reporte (BBC + Música) subido.");
    } catch (e) { console.error("❌ Error Auto-Reporte:", e.message); }
}

// B. Contenido creativo (50 min -> Redactor_ia.mp3)
async function autoContenidoCreativo() {
    const temas = ["un dato curioso musical", "un pensamiento positivo", "una efeméride del día", "un saludo rumbero"];
    const tema = temas[Math.floor(Math.random() * temas.length)];
    const prompt = `Genera un mensaje de locución de 35 palabras sobre ${tema}. Tono alegre y dinámico para La Fronterísima. Incluye eslogan final.`;

    try {
        const guion = await redactarIA(prompt);
        const pathC = `v_crea.mp3`;
        await generarVoz(guion, pathC);
        await producirYSubir(pathC, "Redactor_ia.mp3", true);
        console.log(`✅ Contenido creativo automático subido: ${tema}`);
    } catch (e) { console.error("❌ Error Creativo:", e.message); }
}

// ======= 8. MANTENER INSTANCIA DESPIERTA =======
setInterval(async () => {
    try {
        await axios.get(`${KEYS.URL_APP}/health`);
        console.log("⚓ Ping de supervivencia enviado.");
    } catch (e) { console.warn("⚠️ Error en Auto-Ping"); }
}, 5 * 60 * 1000);

// ======= 9. INICIO DEL SERVIDOR =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro en puerto ${PORT}`);
    
    setTimeout(() => {
        autoReporte();
        setInterval(autoReporte, 15 * 60 * 1000);
    }, 10000);

    setTimeout(() => {
        autoContenidoCreativo();
        setInterval(autoContenidoCreativo, 50 * 60 * 1000);
    }, 30000);
});
