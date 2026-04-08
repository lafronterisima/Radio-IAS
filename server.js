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
    PASSWORD: process.env.APP_PASSWORD,
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    JAMENDO_ID: process.env.JAMENDO_CLIENT_ID || "c230e1f4"
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_UPLOAD = `${AZURA_BASE}/files/upload`;

// ======= 2. TELEGRAM (MANEJO DE CONFLICTOS POLLING) =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });

// Evitar que el error 409 detenga el servidor
bot.on('polling_error', (err) => {
    if (!err.message.includes('409 Conflict')) console.error("Telegram Error:", err.message);
});

let ultimoSaludo = { nombre: "", texto: "", fecha: null };
let cancionRecienDescubierta = null;

bot.on('message', async (msg) => {
    if (!msg.text) return;

    if (msg.text === '/descubrir') {
        bot.sendMessage(msg.chat.id, "🔎 Buscando música nueva para La Fronterísima...");
        const track = await buscarMusicaJamendo('latin');
        if (track) {
            await descargarYSubirAzura(track);
            cancionRecienDescubierta = track.info;
            bot.sendMessage(msg.chat.id, `✅ ¡Subida! "${track.info}". Salomé la presentará pronto.`);
        } else {
            bot.sendMessage(msg.chat.id, "❌ No encontré música nueva ahora.");
        }
        return;
    }

    if (!msg.text.startsWith('/')) {
        ultimoSaludo = { nombre: msg.from.first_name || "un oyente", texto: msg.text, fecha: new Date() };
        bot.sendMessage(msg.chat.id, "¡Recibido! Tu saludo saldrá al aire pronto. 🎙️");
    }
});

// ======= 3. FUNCIONES DE APOYO =======

function limpiarTexto(t) {
    if (!t) return "";
    return t.replace(/```[a-z]*\n?/gi, '').replace(/[*#_~]/g, '')
            .replace(/Locutor:|Guion:|Respuesta:|Locutora:|Salomé:/gi, '').trim();
}

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
    } catch (e) { return null; }
}

async function descargarYSubirAzura(track) {
    const tempFile = path.join(__dirname, 'temp_track.mp3');
    try {
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);
        response.data.pipe(writer);
        return new Promise((resolve) => {
            writer.on('finish', async () => {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempFile), { filename: track.nombre });
                form.append('path', `Musica_Nueva/${track.nombre}`);
                await axios.post(AZURA_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, timeout: 90000 });
                if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                resolve(true);
            });
        });
    } catch (e) { console.error("Error Jamendo Upload:", e.message); }
}

// ======= 4. INTELIGENCIA ARTIFICIAL (NÚCLEO) =======

async function redactarIA(prompt) {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 10000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
    } catch (e) {
        try {
            const res = await axios.post("[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)", {
                model: "llama-3.1-8b-instant",
                messages: [{ role: "system", content: "Locutora rumbera colombiana." }, { role: "user", content: prompt }]
            }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 8000 });
            return limpiarTexto(res.data?.choices?.[0]?.message?.content);
        } catch (err) { return "Sintonizas La Fronterísima, desde Colombia para el mundo."; }
    }
}

// ======= 5. PRODUCCIÓN DE AUDIO =======

async function generarVoz(texto, archivo) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
        const synth = new sdk.SpeechSynthesizer(config);
        const ssml = `<speak version="1.0" xmlns="[http://www.w3.org/2001/10/synthesis](http://www.w3.org/2001/10/synthesis)" xmlns:mstts="[https://www.w3.org/2001/mstts](https://www.w3.org/2001/mstts)" xml:lang="es-CO">
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

// ======= 6. RUTAS API (FRONTEND) =======

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.post("/redactar-guion", async (req, res) => {
    try {
        const { idea } = req.body;
        const prompt = `Locutora Salomé de La Fronterísima. Guion alegre sobre: ${idea}. Máximo 40 palabras. Usa el eslogan: Notas surcando fronteras.`;
        const guion = await redactarIA(prompt);
        res.json({ guion: guion || "¡Sintoniza la mejor energía con La Fronterísima!" });
    } catch (e) {
        res.json({ guion: "Notas surcando fronteras. ¡Súbele al volumen!" });
    }
});

app.post("/procesar-locucion", async (req, res) => {
    const { texto, conFondo } = req.body;
    const pathVoz = `v_man_${Date.now()}.mp3`;
    try {
        await generarVoz(texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

// ======= 7. AUTOMATIZACIÓN =======

async function autoReporte() {
    try {
        const climRes = await axios.get("[https://api.open-meteo.com/v1/forecast?latitude=4.57&longitude=-74.30&current_weather=true](https://api.open-meteo.com/v1/forecast?latitude=4.57&longitude=-74.30&current_weather=true)");
        const temp = Math.round(climRes.data.current_weather.temperature);
        const playlist = (temp >= 29) ? "rumba_caliente" : (temp <= 22) ? "vallenato_lluvia" : "chill_ibero";
        
        try { await axios.get(`${AZURA_BASE}/playlist/${playlist}/toggle`, { headers: { "X-API-Key": KEYS.AZURA } }); } catch(e){}

        const resNp = await axios.get(`https://az.azurafree.eu/api/nowplaying/${KEYS.STATION_ID}`);
        const np = resNp.data.now_playing?.song || { artist: "Artistas", title: "Éxitos" };
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });

        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 45 * 60 * 1000)) extras += ` SALUDO: ${ultimoSaludo.nombre} dice "${ultimoSaludo.texto}".`;
        if (cancionRecienDescubierta) { extras += ` ESTRENO: Acabamos de subir ${cancionRecienDescubierta}.`; cancionRecienDescubierta = null; }

        const prompt = `Actúa como Salomé, locutora de La Fronterísima. Colombia, ${hora}, ${temp}°C. Música: ${np.title}. ${extras} Guion de 55 palabras, nacional, alegre. Termina: Notas surcando fronteras.`;

        const guion = await redactarIA(prompt);
        await generarVoz(guion, "v_auto.mp3");
        await producirYSubir("v_auto.mp3", "dj_auto.mp3", true);
        ultimoSaludo.fecha = null;
        console.log(`✅ Reporte Colombia [${hora}] OK.`);
    } catch (e) { console.error("Error Auto:", e.message); }
}

// ======= 8. ARRANQUE =======

app.get("/health", (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    setTimeout(autoReporte, 5000);
    setInterval(autoReporte, 15 * 60 * 1000);
});
