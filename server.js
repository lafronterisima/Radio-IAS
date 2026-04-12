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

// ======= CONEXI脫N CON FRONTEND =======
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

// ======= 2. OBTENER NOTICIAS (EURONEWS ESTABLE) =======
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
        return "El panorama mundial sigue en movimiento con La Fronter铆sima.";
    } catch (e) {
        return "Noticias internacionales surcando las fronteras en este instante.";
    }
}

// ======= 3. INTELIGENCIA ARTIFICIAL (FAILOVER) =======
 
async function redactarIA(prompt) {
    try {
        console.log("📡 Intentando con Gemini...");
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 10000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
        throw new Error("Gemini devolvió vacío");
    } catch (e) {
        console.warn("⚠️ Gemini falló, saltando a Groq...");
        try {
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: "Locutora rumbera de Cali." },
                    { role: "user", content: prompt }
                ]
            }, { 
                headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, 
                timeout: 8000 
            });
            const textoGroq = res.data?.choices?.[0]?.message?.content;
            if (textoGroq) return limpiarTexto(textoGroq);
            throw new Error("Groq devolvió vacío");
        } catch (err) {
            console.error("❌ Ambas IAs fallaron.");
            // Devolver un guion de emergencia para que el sistema no se rompa
            return "¡Sintonizas La Fronterísima! Notas surcando fronteras con la mejor energía para ti.";
        }
    }
}

    

function limpiarTexto(t) {
    return t.replace(/[*#_]/g, '').replace(/Locutor:|Guion:|Respuesta:|Locutora:/gi, '').trim();
}

// ======= 4. VOZ Y PRODUCCI脫N =======
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

// ======= 5. RUTAS API =======
app.get("/health", (req, res) => res.status(200).send("LIVE"));

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

// ======= 6. AUTOMATIZACI脫N (CADA 15 MINUTOS) =======

async function autoReporte() {
    console.log("🎙️ Generando reporte automático...");
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true", { timeout: 5000 });
        const bbc = await obtenerNoticiasBBC();
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        const temp = clim.data?.current_weather?.temperature ? `${Math.round(clim.data.current_weather.temperature)}°C` : "clima tropical";

        const prompt = `Salomé de La Fronterísima Cali. Hora: ${hora}. Música: ${np.titulo}. Clima: ${temp}. Noticias: ${bbc}. Guion de 50 palabras alegre. Termina: Notas surcando fronteras.`;
        
        const guion = await redactarIA(prompt);
        
        // Verificamos que el guion exista antes de seguir
        if (!guion) throw new Error("El guion generado está vacío.");

        await generarVoz(guion, "v_auto.mp3");
        await producirYSubir("v_auto.mp3", "dj_auto.mp3", true);
        
        console.log(`✅ dj_auto.mp3 actualizado exitosamente.`);
    } catch (e) {
        // Aquí es donde evitamos el 'undefined'
        console.error("❌ Error Auto-Reporte:");
        if (e.response) {
            // Error de respuesta de API (401, 404, 500)
            console.error(`Status: ${e.response.status} - Info: ${JSON.stringify(e.response.data)}`);
        } else {
            // Error de código o conexión
            console.error(e.stack || e.message || e);
        }
    }
}



    // Autoping cada 10 minutos
    setInterval(() => {
        const appName = process.env.KOYEB_APP_NAME || 'localhost';
        axios.get(`https://${appName}.koyeb.app/health`)
            .catch(() => console.log("Self-ping sintonizado"));
    }, 10 * 60 * 1000);
});
