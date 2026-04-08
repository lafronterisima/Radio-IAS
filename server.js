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

// Archivos estáticos del frontend
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

// ======= 3. OBTENCIÓN DE NOTICIAS (RSS) =======
async function obtenerNoticia() {
    try {
        const res = await axios.get("https://es.euronews.com/rss?level=vertical&name=mundo", {
            headers: { 'User-Agent': 'Mozilla/5.0 (LaFronterisima-Radio-Bot)' },
            timeout: 5000
        });
        const match = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>([^<]+)<\/title>/g);
        if (match && match.length > 1) {
            const index = Math.floor(Math.random() * (match.length - 1)) + 1;
            return match[index].replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').split(' | ')[0].trim();
        }
        return "Sigue vibrando con la mejor energía rumbera.";
    } catch (e) { 
        return "Notas surcando fronteras con la mejor música."; 
    }
}

// ======= 4. INTELIGENCIA ARTIFICIAL (FAILOVER) =======
async function redactarIA(idea, datos = null) {
    let prompt;
    if (datos) {
        prompt = `Eres locutor estrella de "La Fronterísima". Hora en Colombia: ${datos.hora}, Temp: ${datos.temp}°C, Noticia: ${datos.noticia}. 
        Instrucción: Crea un guion alegre de 45 palabras. Incluye hora, clima y noticia. 
        Termina con: "La Fronterisima, notas surcando fronteras". SOLO texto.`;
    } else {
        prompt = idea;
    }

    // Intento 1: Gemini
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 6000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
    } catch (e) { console.warn("⚠️ Falló Gemini, intentando Groq..."); }

    // Intento 2: Groq
    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [{ role: "system", content: "Locutora colombiana alegre." }, { role: "user", content: prompt }]
        }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 6000 });
        return limpiarTexto(res.data?.choices?.[0]?.message?.content);
    } catch (e) { return "Sintonizas La Fronterísima, notas surcando fronteras."; }
}

function limpiarTexto(t) {
    return t.replace(/[*#_]/g, '').replace(/Locutor:|Guion:|Respuesta:|Locutora:/gi, '').trim();
}

// ======= 5. VOZ Y PRODUCCIÓN (FFMPEG) =======
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

// ======= 6. RUTAS PARA EL PANEL =======
app.get("/health", (req, res) => res.status(200).send("OK"));

app.post("/redactar-guion", async (req, res) => {
    const guion = await redactarIA(req.body.idea);
    res.json({ guion });
});

app.post("/procesar-locucion", async (req, res) => {
    const { texto, conFondo } = req.body;
    const nombreFijo = "Redactor_ia.mp3";
    const pathVoz = `v_${Date.now()}.mp3`;
    try {
        await generarVoz(texto, pathVoz);
        await producirYSubir(pathVoz, nombreFijo, conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send(e.toString()); }
});

// ======= 7. AUTOMATIZACIONES =======

// A. Reporte de noticias (cada 15 min -> dj_auto.mp3)
async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const noticia = await obtenerNoticia();
        const datos = { 
            hora: new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' }),
            temp: Math.round(clim.data.current_weather.temperature),
            noticia
        };
        const guion = await redactarIA(null, datos);
        const pathAuto = `v_auto.mp3`;
        await generarVoz(guion, pathAuto);
        await producirYSubir(pathAuto, "dj_auto.mp3", true);
        console.log(`✅ Auto-Reporte Noticias Exitoso`);
    } catch (e) { console.error("❌ Error Auto-Reporte:", e.message); }
}

// B. Contenido creativo (cada 50 min -> Redactor_ia.mp3)
async function autoContenidoCreativo() {
    console.log("✨ Generando contenido creativo automático...");
    const temas = [
        "un pensamiento positivo corto y motivador",
        "un dato curioso de la música",
        "una efeméride histórica del día de hoy",
        "un saludo alegre a los oyentes de La Fronterísima"
    ];
    const tema = temas[Math.floor(Math.random() * temas.length)];
    const prompt = `Eres locutora de radio rumbera. Genera un guion de 35 palabras sobre: ${tema}. Termina con el eslogan: "La Fronterísima, notas surcando fronteras". SOLO texto.`;

    try {
        const guion = await redactarIA(prompt);
        const pathTemp = `v_creativo.mp3`;
        await generarVoz(guion, pathTemp);
        await producirYSubir(pathTemp, "Redactor_ia.mp3", true);
        console.log(`✅ Contenido creativo subido: ${tema}`);
    } catch (e) { console.error("❌ Error Creativo:", e.message); }
}

// ======= 8. MANTENER INSTANCIA ACTIVA (SELF-PING) =======
setInterval(async () => {
    try {
        await axios.get(`${KEYS.URL_APP}/health`);
        console.log("⚓ Ping enviado para mantener instancia despierta.");
    } catch (e) {
        console.warn("⚠️ Error en Auto-Ping (Probable inicio de app)");
    }
}, 5 * 60 * 1000); // Cada 5 minutos

// ======= 9. INICIO DEL SERVIDOR =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro conectada en puerto ${PORT}`);
    
    // Ciclo 15 min (Noticias)
    setTimeout(() => {
        autoReporte();
        setInterval(autoReporte, 15 * 60 * 1000); 
    }, 10000); 

    // Ciclo 50 min (Creativo)
    setTimeout(() => {
        autoContenidoCreativo();
        setInterval(autoContenidoCreativo, 50 * 60 * 1000); 
    }, 30000); 
});
