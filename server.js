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

// ======= SISTEMA DE SEGURIDAD =======
app.post('/login', (req, res) => {
    const { password } = req.body;
    const secretKey = process.env.APP_PASSWORD; 
    if (password === secretKey) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Clave incorrecta" });
    }
});

// ======= CONEXIÓN CON FRONTEND =======
app.use(express.static(path.join(__dirname, "public")));

const KEYS = {
    GEMINI: process.env.GOOGLE_API_KEY,
    GROQ: process.env.GROQ_API_KEY,
    AZURE: process.env.AZURE_SPEECH_KEY,
    AZURE_REGION: process.env.AZURE_REGION,
    AZURA: process.env.AZURA_KEY,
    STATION_ID: process.env.STATION_ID || "24"
};

const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;

// ======= 2. OBTENER NOTICIAS =======
async function obtenerNoticia() {
    try {
        const res = await axios.get("https://news.google.com/rss/search?q=source:Euronews+espanol&hl=es-419&gl=CO&ceid=CO:es-419", {
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0 (LaFronterisima-Bot)' }
        });
        const match = res.data.match(/<title>([^<]+)<\/title>/g);
        if (match && match.length > 2) {
            const index = Math.floor(Math.random() * (match.length - 2)) + 1;
            let noticia = match[index]
                .replace(/<title>|<\/title>/g, '') 
                .replace(/<!\[CDATA\[|\]\]>/g, '')
                .split(' - ')[0] 
                .trim();
            return noticia;
        }
        return "El panorama mundial sigue en movimiento con La Fronterísima.";
    } catch (e) {
        return "Noticias internacionales surcando las fronteras en este instante.";
    }
}

// ======= 3. INTELIGENCIA ARTIFICIAL (LÓGICA HÍBRIDA) =======
async function redactarIA(idea, datos = null) {
    let prompt;

    if (datos) {
        // MODO AUTOMÁTICO (REPORTES 15 MIN)
        prompt = `Eres la locutora estrella de "La Fronterísima". Hora: ${datos.hora}, Temp: ${datos.temp}°C, Noticia: ${datos.noticia}. 
        Crea un guion alegre de 45 palabras mencionando estos datos para Cali. 
        Termina con: "La Fronterisima, notas surcando fronteras". SOLO texto plano.`;
    } 
    else if (idea && idea.trim() !== "") {
        // MODO MANUAL (CON TEXTO)
        prompt = `Eres la locutora de "La Fronterísima". 
        INSTRUCCIÓN DEL DIRECTOR: ${idea}. 
        Redacta un guion profesional y carismático basado estrictamente en esta idea. 
        Termina con: "La Fronterisima, notas surcando fronteras". SOLO texto plano.`;
    } 
    else {
        // MODO POSITIVO (BOTÓN REDACTAR VACÍO)
        prompt = `Eres la locutora de "La Fronterísima" en Cali. 
        Genera un mensaje corto (25 palabras) de mucha energía, buena vibra, un saludo a los oyentes 
        o un dato curioso breve de la salsa. Termina con: "La Fronterisima, notas surcando fronteras". SOLO texto.`;
    }

    // FAILOVER: GEMINI -> GROQ
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 6000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
    } catch (e) { console.warn("⚠️ Gemini falló, saltando a Groq..."); }

    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [{ role: "system", content: "Locutora colombiana alegre." }, { role: "user", content: prompt }]
        }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 6000 });
        return limpiarTexto(res.data?.choices?.[0]?.message?.content);
    } catch (e) { return "Sintonizas La Fronterísima, notas surcando fronteras. ¡La mejor energía para Cali hoy!"; }
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
        // Mezcla con volumen optimizado para que la voz resalte
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

// ======= 5. RUTAS API =======
app.get("/health", (req, res) => res.status(200).send("LIVE"));

app.post("/redactar-guion", async (req, res) => {
    // Si la idea está vacía, redactarIA generará el mensaje positivo
    const guion = await redactarIA(req.body.idea || "");
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

// ======= 6. AUTOMATIZACIÓN (REPORTE DE NOTICIAS) =======
async function autoReporte() {
    console.log("🎙️ Generando reporte automático (Hora/Clima/Noticias)...");
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
        console.log(`✅ Auto-Reporte exitoso (${datos.hora})`);
    } catch (e) { console.error("❌ Error Auto-Reporte:", e.message); }
}

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro en puerto ${PORT}`);
    
    // Iniciar auto-reporte tras 1 minuto y repetir cada 15 min
    setTimeout(() => {
        autoReporte();
        setInterval(autoReporte, 15 * 60 * 1000); 
    }, 60000);

    // Autoping cada 10 minutos para mantener vivo el servidor
    setInterval(() => {
        const appName = process.env.KOYEB_APP_NAME || 'localhost';
        axios.get(`https://${appName}.koyeb.app/health`).catch(() => {});
    }, 10 * 60 * 1000);
});
