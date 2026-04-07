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

// ======= RUTAS DE SALUD Y SEGURIDAD =======
app.get("/health", (req, res) => res.status(200).send("LIVE"));

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) return res.json({ success: true });
    res.status(401).json({ success: false, message: "Clave incorrecta" });
});

// ======= 1. OBTENER DATOS EXTERNOS (CLIMA, NOTICIAS, MÚSICA) =======
async function obtenerClimaReal() {
    try {
        // Coordenadas de Bogotá para clima real en Colombia
        const url = `https://api.open-meteo.com/v1/forecast?latitude=4.6097&longitude=-74.0817&current_weather=true&timezone=America/Bogota`;
        const res = await axios.get(url, { timeout: 6000 });
        return Math.round(res.data.current_weather.temperature);
    } catch (e) { 
        console.warn("⚠️ Falló clima, usando 19°C por defecto.");
        return 19; 
    }
}

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
    return "El panorama mundial se mantiene en constante movimiento.";
}

async function obtenerCancionActual() {
    try {
        const res = await axios.get(AZURA_API_NOWPLAYING, { timeout: 4000 });
        const np = res.data[0]?.now_playing?.song || res.data?.now_playing?.song;
        return np ? `${np.title} de ${np.artist}` : "nuestra programación especial";
    } catch (e) { return "la mejor selección musical"; }
}

// ======= 2. REDACCIÓN CON INTELIGENCIA ARTIFICIAL =======
async function redactarIA(idea, datos = null) {
    const cancion = await obtenerCancionActual();
    const hora = datos ? datos.hora : new Date().toLocaleTimeString("es-CO", {hour:'2-digit', minute:'2-digit', timeZone: 'America/Bogota'});
    
    let prompt = `Eres la locutora estrella de "La Fronterísima". Estilo: Español Neutro de Colombia. 
    ${datos ? `CONTEXTO: Son las ${hora}, clima: ${datos.temp}°C, Noticia: ${datos.noticia}.` : `IDEA: ${idea}.`}
    Música sonando: "${cancion}". Crea un guion cálido de 45 palabras. 
    Termina siempre con la frase: "La Fronterisima, notas surcando fronteras".`;

    // Intento con Gemini
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 12000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
    } catch (e) { console.warn("⚠️ Gemini falló, saltando a Groq..."); }

    // Respaldo con Groq
    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [{ role: "system", content: "Locutora profesional colombiana." }, { role: "user", content: prompt }]
        }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 8000 });
        return limpiarTexto(res.data?.choices?.[0]?.message?.content);
    } catch (e) { 
        return `Hola Colombia, sintonizan La Fronterísima. Son las ${hora} y disfrutamos de ${cancion}. Notas surcando fronteras.`; 
    }
}

function limpiarTexto(t) {
    return t.replace(/[*#_]/g, '').replace(/Locutor:|Guion:|Respuesta:|Locutora:/gi, '').trim();
}

// ======= 3. VOZ Y PRODUCCIÓN (FFMPEG) =======
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
    
    // Comando FFmpeg con volumen optimizado para radio
    const cmd = (conFondo && fondoExiste)
        ? `ffmpeg -y -i fondo.mp3 -i ${archivoVoz} -filter_complex "[0:a]volume=0.12[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;

    return new Promise((resolve, reject) => {
        exec(cmd, async (err) => {
            if (err) return reject("FFmpeg Error");
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                form.append('path', nombreFinal);
                await axios.post(AZURA_API_UPLOAD, form, {
                    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
                    timeout: 30000 // Tiempo extra para subir el audio
                });
                // Limpieza de archivos temporales
                [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                resolve();
            } catch (e) { reject("Error Subida Azura"); }
        });
    });
}

// ======= 4. CICLOS DE REPORTE (AUTOMÁTICOS) =======
async function autoReporte() {
    console.log("🎙️ Generando reporte automático...");
    try {
        const temp = await obtenerClimaReal();
        const noticia = await obtenerNoticia();
        const hora = new Date().toLocaleTimeString("es-CO", { 
            hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' 
        });

        const guion = await redactarIA(null, { hora, temp, noticia });
        const pathVoz = `v_auto_${Date.now()}.mp3`;

        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        console.log(`✅ Reporte Exitoso: ${hora} | ${temp}°C`);
    } catch (e) {
        console.error("❌ Fallo en Ciclo de Reporte:", e.message);
    }
}

// ======= 5. INICIO DEL SERVIDOR Y SUPERVIVENCIA =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro activa en puerto ${PORT}`);
    
    // Iniciar reporte inicial y luego cada 15 min
    setTimeout(() => {
        autoReporte();
        setInterval(autoReporte, 15 * 60 * 1000);
    }, 15000);

    // Self-Ping para mantener viva la instancia en Koyeb
    setInterval(async () => {
        try {
            await axios.get(`${KEYS.KOYEB_URL}/health`, { timeout: 5000 });
            console.log("⚓ Pulso de vida enviado.");
        } catch (e) {
            console.warn("⚠️ Advertencia: Self-ping no pudo contactar al servidor.");
        }
    }, 4 * 60 * 1000); // Cada 4 minutos
});
