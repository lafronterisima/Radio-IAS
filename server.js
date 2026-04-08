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

// ======= 1. CONFIGURACIÓN =======
const KEYS = {
    GEMINI: process.env.GOOGLE_API_KEY,
    GROQ: process.env.GROQ_API_KEY,
    AZURE: process.env.AZURE_SPEECH_KEY,
    AZURE_REGION: process.env.AZURE_REGION,
    AZURA: process.env.AZURA_KEY,
    STATION_ID: process.env.STATION_ID || "24",
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    JAMENDO_ID: process.env.JAMENDO_CLIENT_ID || "56d30cce" // Client ID de Jamendo
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_UPLOAD = `${AZURA_BASE}/files/upload`;

// ======= 2. TELEGRAM CON COMANDOS INTELIGENTES =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
let ultimoSaludo = { nombre: "", texto: "", fecha: null };
let cancionRecienDescubierta = null;

bot.on('message', async (msg) => {
    if (!msg.text) return;

    // Comando para descubrir música nueva manualmente
    if (msg.text === '/descubrir') {
        bot.sendMessage(msg.chat.id, "🔎 Buscando una joya musical para La Fronterísima...");
        const track = await buscarMusicaJamendo('latin');
        if (track) {
            await descargarYSubirAzura(track);
            cancionRecienDescubierta = track.info;
            bot.sendMessage(msg.chat.id, `✅ ¡Logrado! Subí "${track.info}" a la radio. Salomé la presentará pronto.`);
        } else {
            bot.sendMessage(msg.chat.id, "❌ No pude encontrar música nueva en este momento.");
        }
        return;
    }

    // Registro de saludos normales
    if (!msg.text.startsWith('/')) {
        ultimoSaludo = {
            nombre: msg.from.first_name || "un oyente",
            texto: msg.text,
            fecha: new Date()
        };
        bot.sendMessage(msg.chat.id, "¡Recibido! Tu saludo saldrá al aire pronto en La Fronterísima. 🎙️");
    }
});

// ======= 3. EXPLORACIÓN MUSICAL (JAMENDO) =======

async function buscarMusicaJamendo(genero = 'latin') {
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&order=random&fuzzytags=${genero}&audioformat=mp32`;
    try {
        const res = await axios.get(url);
        if (res.data.results?.length > 0) {
            const t = res.data.results[0];
            return {
                url: t.audio,
                nombre: `${t.artist_name} - ${t.name}.mp3`.replace(/[/\\?%*:|"<>]/g, '-'),
                info: `${t.name} de ${t.artist_name}`
            };
        }
    } catch (e) { console.error("Error Jamendo:", e.message); }
    return null;
}

async function descargarYSubirAzura(track) {
    const tempFile = path.join(__dirname, 'temp_download.mp3');
    try {
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);
        response.data.pipe(writer);

        return new Promise((resolve) => {
            writer.on('finish', async () => {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempFile), { filename: track.nombre });
                form.append('path', `Musica_Nueva/${track.nombre}`);
                await axios.post(AZURA_UPLOAD, form, { 
                    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
                    timeout: 90000 
                });
                if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                resolve(true);
            });
        });
    } catch (e) { console.error("Error descarga/subida:", e.message); }
}

// ======= 4. LÓGICA DE CLIMA Y MÚSICA =======

async function obtenerMoodMusical(temp) {
    let playlist = (temp >= 29) ? "rumba_caliente" : (temp <= 22) ? "vallenato_lluvia" : "chill_ibero";
    let mensaje = (temp >= 29) ? "el calor está encendido y soltamos la rumba" : (temp <= 22) ? "está fresco para un vallenato del alma" : "tenemos el clima perfecto para notas que surcan fronteras";

    try {
        await axios.get(`${AZURA_BASE}/playlist/${playlist}/toggle`, { headers: { "X-API-Key": KEYS.AZURA } });
    } catch (e) { /* Silencioso si falla el toggle */ }
    return mensaje;
}

// ======= 5. PRODUCCIÓN DE AUDIO =======

async function generarVoz(texto, archivo) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
        const synth = new sdk.SpeechSynthesizer(config);
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural"><mstts:express-as style="cheerful" styledegree="1.4">
            <prosody rate="+8%">${texto}</prosody></mstts:express-as></voice></speak>`;
        
        synth.speakSsmlAsync(ssml, r => {
            if (r.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync(archivo, Buffer.from(r.audioData));
                synth.close(); resolve();
            } else { synth.close(); reject("TTS Fail"); }
        }, e => { synth.close(); reject(e); });
    });
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const f = "fondo.mp3", i = "intro.mp3";
    let cmd = (conFondo && fs.existsSync(f) && fs.existsSync(i)) 
        ? `ffmpeg -y -i ${i} -i ${archivoVoz} -i ${f} -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[v_full]; [2:a]volume=0.12[bg]; [v_full]volume=1.8[v]; [bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;

    return new Promise((resolve) => {
        exec(cmd, async () => {
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                form.append('path', nombreFinal);
                await axios.post(AZURA_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, timeout: 60000 });
                [archivoVoz, tempSalida].forEach(file => { if(fs.existsSync(file)) fs.unlinkSync(file); });
                resolve();
            } catch (e) { resolve(); }
        });
    });
}

// ======= 6. AUTOMATIZACIÓN NACIONAL =======

async function autoReporte() {
    try {
        const climRes = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=4.57&longitude=-74.30&current_weather=true");
        const temp = Math.round(climRes.data.current_weather.temperature);
        const mood = await obtenerMoodMusical(temp);
        
        const resNp = await axios.get(`https://az.azurafree.eu/api/nowplaying/${KEYS.STATION_ID}`);
        const np = resNp.data.now_playing?.song || { artist: "Grandes artistas", title: "Éxitos" };
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });

        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 45 * 60 * 1000)) {
            extras += ` SALUDO: ${ultimoSaludo.nombre} dice "${ultimoSaludo.texto}".`;
        }
        if (cancionRecienDescubierta) {
            extras += ` NOVEDAD: Acabamos de añadir a la librería: ${cancionRecienDescubierta}.`;
            cancionRecienDescubierta = null;
        }

        const prompt = `Actúa como Salomé, locutora de La Fronterísima. 
        Contexto: Colombia, ${hora}, ${temp}°C. Música: ${np.title} de ${np.artist}. 
        Mood: ${mood}.${extras}
        Escribe un guion de 55 palabras alegre y nacional (para toda Colombia). 
        Usa "en cada rincón de nuestra tierra". Termina con "Notas surcando fronteras".`;

        // Lógica de Redacción (Gemini con respaldo Groq)
        let guion;
        try {
            const resG = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`, { contents: [{ parts: [{ text: prompt }] }] });
            guion = resG.data.candidates[0].content.parts[0].text;
        } catch {
            const resGr = await axios.post("https://api.groq.com/openai/v1/chat/completions", { model: "llama-3.1-8b-instant", messages: [{role:"user", content:prompt}] }, { headers: { Authorization: `Bearer ${KEYS.GROQ}` } });
            guion = resGr.data.choices[0].message.content;
        }

        const guionLimpio = guion.replace(/[*#_]/g, '').trim();
        await generarVoz(guionLimpio, "v_auto.mp3");
        await producirYSubir("v_auto.mp3", "dj_auto.mp3", true);
        ultimoSaludo.fecha = null;
        console.log(`✅ Reporte Colombia [${hora}] ejecutado.`);
    } catch (e) { console.error("Error en Auto:", e.message); }
}

// ======= 7. RUTAS Y ARRANQUE =======

app.get("/health", (req, res) => res.sendStatus(200));
app.post("/azura-event", (req, res) => { autoReporte(); res.sendStatus(200); });
app.post('/login', (req, res) => {
    if (req.body.password === process.env.APP_PASSWORD) res.json({ success: true });
    else res.status(401).json({ success: false });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro en puerto ${PORT}`);
    setTimeout(autoReporte, 5000);
    setInterval(autoReporte, 15 * 60 * 1000);
});
