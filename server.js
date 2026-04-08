require('dotenv').config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN DE LLAVES =======
const KEYS = {
    GEMINI: process.env.GOOGLE_API_KEY,
    GROQ: process.env.GROQ_API_KEY,
    AZURE: process.env.AZURE_SPEECH_KEY,
    AZURE_REGION: process.env.AZURE_REGION,
    AZURA: process.env.AZURA_KEY,
    STATION_ID: process.env.STATION_ID || "24",
    PASSWORD: process.env.APP_PASSWORD,
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN
};

const AZURA_BASE_URL = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE_URL}/files/upload`;

// ======= 2. BOT DE TELEGRAM (INTERACCIÓN) =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
let ultimoSaludo = { nombre: "", texto: "", fecha: null };

bot.on('message', (msg) => {
    if (msg.text && !msg.text.startsWith('/')) {
        ultimoSaludo = {
            nombre: msg.from.first_name || "un oyente",
            texto: msg.text,
            fecha: new Date()
        };
        bot.sendMessage(msg.chat.id, "¡Recibido! Tu saludo saldrá al aire pronto en La Fronterísima. 🎙️");
    }
});

// ======= 3. CURADURÍA MUSICAL E INFORMACIÓN =======

async function ajustarProgramacionPorClima(temp) {
    let playlistName = "";
    let mensajeMood = "";

    // Lógica de decisión musical IA
    if (temp >= 29) {
        playlistName = "rumba_caliente"; 
        mensajeMood = "el ambiente en nuestra tierra está encendido, así que soltamos la rumba más sabrosa";
    } else if (temp <= 22) {
        playlistName = "vallenato_lluvia";
        mensajeMood = "con este clima fresco que recorre el país, nos ponemos sentimentales con buen vallenato";
    } else {
        playlistName = "chill_ibero";
        mensajeMood = "tenemos un clima espectacular en Colombia para disfrutar de notas que surcan fronteras";
    }

    try {
        // Intento de activar la playlist en AzuraCast
        await axios.get(`${AZURA_BASE_URL}/playlist/${playlistName}/toggle`, {
            headers: { "X-API-Key": KEYS.AZURA }
        });
        return mensajeMood;
    } catch (e) {
        return mensajeMood; // Retornamos el mensaje para el guion aunque falle el toggle
    }
}

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`https://az.azurafree.eu/api/nowplaying/${KEYS.STATION_ID}`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "grandes artistas", titulo: "éxitos inolvidables" };
    } catch (e) { return { artista: "varios artistas", titulo: "tu música favorita" }; }
}

async function obtenerNoticiasBBC() {
    try {
        const res = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml", { timeout: 5000 });
        const matches = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>([^<]+)<\/title>/g);
        if (matches && matches.length > 2) {
            const n1 = matches[1].replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').trim();
            return `Lo último: ${n1}`;
        }
        return "El mundo sigue en movimiento y nosotros te acompañamos.";
    } catch (e) { return "Sigue conectado para más información."; }
}

function limpiarTexto(t) {
    return t.replace(/[*#_]/g, '').replace(/Locutor:|Guion:|Respuesta:|Locutora:/gi, '').trim();
}

// ======= 4. CEREBRO IA (GEMINI + GROQ) =======

async function redactarIA(prompt) {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 10000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
    } catch (e) {
        console.warn("⚠️ Usando respaldo Groq...");
        try {
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.1-8b-instant",
                messages: [{ role: "system", content: "Locutora rumbera colombiana." }, { role: "user", content: prompt }]
            }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 8000 });
            return limpiarTexto(res.data?.choices?.[0]?.message?.content);
        } catch (err) { return "Sintonizas La Fronterísima, desde Colombia para el mundo entero."; }
    }
}

// ======= 5. PRODUCCIÓN DE AUDIO (AZURE + FFmpeg) =======

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
    const fondo = "fondo.mp3";
    const intro = "intro.mp3";
    let cmd;
    
    if (conFondo && fs.existsSync(fondo) && fs.existsSync(intro)) {
        cmd = `ffmpeg -y -i ${intro} -i ${archivoVoz} -i ${fondo} -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[full_voz]; [2:a]volume=0.12[bg]; [full_voz]volume=1.8[v]; [bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`;
    } else {
        cmd = `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;
    }

    return new Promise((resolve, reject) => {
        exec(cmd, async (err) => {
            if (err) return reject(err);
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                form.append('path', nombreFinal);
                await axios.post(AZURA_API_UPLOAD, form, { 
                    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
                    timeout: 60000 
                });
                [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                resolve();
            } catch (e) { reject(e); }
        });
    });
}

// ======= 6. AUTOMATIZACIÓN NACIONAL COLOMBIA =======

async function autoReporte() {
    try {
        const climRes = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=4.57&longitude=-74.30&current_weather=true");
        const tempActual = Math.round(climRes.data.current_weather.temperature);
        
        const comentarioMusical = await ajustarProgramacionPorClima(tempActual);
        const bbc = await obtenerNoticiasBBC();
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let mencionSaludo = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 45 * 60 * 1000)) {
            mencionSaludo = `OYENTE: ${ultimoSaludo.nombre} envía este mensaje desde el territorio nacional: "${ultimoSaludo.texto}". Mándale mucha energía.`;
        }

        const prompt = `Actúa como Salomé, locutora de La Fronterísima. 
        Contexto: Son las ${hora} en toda Colombia con ${tempActual}°C. 
        Canción: ${np.titulo} de ${np.artista}. 
        Mundo: ${bbc}.
        Mood Musical: ${comentarioMusical}.
        ${mencionSaludo}
        Escribe un guion de 55 palabras. Habla para Colombia y el mundo. Usa frases como "en cada rincón de nuestra tierra".
        No menciones una ciudad específica, sé nacional. Termina con "Notas surcando fronteras".`;
        
        const guion = await redactarIA(prompt);
        await generarVoz(guion, "v_auto.mp3");
        await producirYSubir("v_auto.mp3", "dj_auto.mp3", true);
        
        ultimoSaludo.fecha = null; 
        console.log(`✅ [${hora}] Reporte Nacional Generado: ${tempActual}°C`);
    } catch (e) { console.error("Error Auto:", e.message); }
}

// ======= 7. RUTAS Y SERVIDOR =======

app.get("/health", (req, res) => res.sendStatus(200));
app.post("/azura-event", (req, res) => { autoReporte(); res.sendStatus(200); });

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) res.json({ success: true });
    else res.status(401).json({ success: false });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima IA operando en puerto ${PORT}`);
    setTimeout(autoReporte, 3000); // Primer reporte al iniciar
    setInterval(autoReporte, 15 * 60 * 1000); // Cada 15 min
});
