require('dotenv').config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require("openai");
const googleTTS = require("google-tts-api");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = {
    OPENAI: safeTrim(process.env.OPENAI_API_KEY),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    JAMENDO_ID: safeTrim(process.env.JAMENDO_CLIENT_ID) || "c230e1f4"
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

const openai = new OpenAI({ apiKey: KEYS.OPENAI });    

// ======= 2. TELEGRAM =======
const bot = KEYS.TELEGRAM_TOKEN ? new TelegramBot(KEYS.TELEGRAM_TOKEN, { 
    polling: {
        autoStart: true,
        params: {
            timeout: 10
        }
    } 
}) : null;

// Evita que el bot tumbe el servidor por el conflicto 409
if (bot) {
    bot.on('polling_error', (err) => {
        if (!err.message.includes('409')) console.error("Error Bot:", err.code);
    });
}

let ultimoSaludo = { nombre: "", texto: "", fecha: null };

if (bot) {
    console.log("✅ Bot de Telegram: Activo para La Fronterísima.");
    bot.on('voice', async (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, "🎤 Valeria está escuchando tu audio...");
        const tempVoice = `/tmp/v_${Date.now()}.ogg`;
        try {
            const fileLink = await bot.getFileLink(msg.voice.file_id);
            const res = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
            const writer = fs.createWriteStream(tempVoice);
            res.data.pipe(writer);
            writer.on('finish', async () => {
                try {
                    const transcription = await openai.audio.transcriptions.create({
                        file: fs.createReadStream(tempVoice),
                        model: "whisper-1",
                        language: "es"
                    });
                    const texto = transcription.text.toLowerCase();
                    ultimoSaludo = { nombre: msg.from.first_name || "oyente", texto: `audio: "${transcription.text}"`, fecha: new Date() };
                    if (texto.includes("ponme") || texto.includes("pon") || texto.includes("quiero escuchar")) {
                        const busqueda = texto.replace(/ponme|pon|quiero escuchar|la canción/g, "").trim();
                        const track = await buscarMusicaJamendo(busqueda, true);
                        if (track) await descargarYSubirAzura(track);
                    }
                    bot.sendMessage(chatId, "✅ Recibido y procesado.");
                } catch (e) { bot.sendMessage(chatId, "❌ Error en transcripción."); }
                if (fs.existsSync(tempVoice)) fs.unlinkSync(tempVoice);
            });
        } catch (e) { console.error("Error Voz:", e.message); }
    });
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) {
            if (msg.text?.startsWith('/pedir ')) {
                const query = msg.text.replace('/pedir ', '').trim();
                const track = await buscarMusicaJamendo(query, true);
                if (track && await descargarYSubirAzura(track)) {
                    ultimoSaludo = { nombre: msg.from.first_name || "oyente", texto: `pidió "${track.info}"`, fecha: new Date() };
                    bot.sendMessage(msg.chat.id, `✅ "${track.info}" programada.`);
                }
            }
            return;
        }
        ultimoSaludo = { nombre: msg.from.first_name || "oyente", texto: msg.text, fecha: new Date() };
        bot.sendMessage(msg.chat.id, "🚩 ¡Mensaje recibido!");
    });
}

// ======= 3. FUNCIONES APOYO =======
async function buscarMusicaJamendo(query, especifica = false) {
    let param = especifica ? `search=${encodeURIComponent(query)}` : `fuzzytags=salsa,reggaeton`;
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&${param}`;
    try {
        const res = await axios.get(url);
        if (res.data.results?.[0]) return { url: res.data.results[0].audio, info: `${res.data.results[0].name} - ${res.data.results[0].artist_name}` };
    } catch (e) { return null; }
}

async function descargarYSubirAzura(track) {
    const tempFile = `/tmp/t_${Date.now()}.mp3`;
    const fileName = "estreno.mp3";
    try {
        const res = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);
        return new Promise((resolve) => {
            res.data.pipe(writer);
            writer.on('finish', async () => {
                try {
                    const form = new FormData();
                    form.append('file', fs.createReadStream(tempFile), { filename: fileName });
                    form.append('path', `Musica_Nueva/${fileName}`);
                    await axios.post(AZURA_API_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, timeout: 90000 });
                    await axios.post(`${AZURA_BASE}/request/${encodeURIComponent('Musica_Nueva/' + fileName)}`, {}, { headers: { "X-API-Key": KEYS.AZURA } });
                    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                    resolve(true);
                } catch (err) { resolve(false); }
            });
        });
    } catch (e) { return false; }
}

async function obtenerNoticias() {
    try {
        const res = await axios.get("https://es.euronews.com/rss?level=vertical&name=noticias", { timeout: 5000 });
        const matches = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
        return matches ? matches[1] : "El mundo rumbero sigue vibrando.";
    } catch (e) { return "Sintonía total con la actualidad."; }
}

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`);
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios", titulo: "éxitos" };
    } catch (e) { return { artista: "varios", titulo: "buena música" }; }
}

// ======= 4. IA Y VOZ (EDGE TTS) =======
async function redactarIA(prompt) {
    try {
        const res = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: "Locutora rumbera colombiana, alegre. No digas tu nombre." }, { role: "user", content: prompt }],
            max_tokens: 200
        });
        return res.choices[0].message.content.replace(/[*#_~]/g, '').trim();
    } catch (e) { return "¡Quédate en la mejor sintonía de La Fronterísima!"; }
}

async function generarVoz(texto, destino) {
    try {
        // Google TTS tiene un límite de 200 caracteres por pedazo. 
        // Cortamos el texto para evitar errores.
        const textoCorto = texto.substring(0, 200);
        
        const url = googleTTS.getAudioUrl(textoCorto, {
            lang: 'es-CO', // Voz de Colombia
            slow: false,
            host: 'https://translate.google.com',
        });

        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(destino);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log(`✅ Voz (Google) generada: ${destino}`);
                resolve();
            });
            writer.on('error', reject);
        });
    } catch (e) {
        console.error("❌ Error en Google TTS:", e.message);
    }
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const salida = `/tmp/p_${Date.now()}.mp3`;
    const fondo = "fondo.mp3";
    const cmd = (conFondo && fs.existsSync(fondo)) 
        ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.10[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${salida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${salida}`;
    
    return new Promise((resolve) => {
        exec(cmd, async () => {
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(salida), { filename: nombreFinal });
                form.append('path', nombreFinal);
                await axios.post(AZURA_API_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA } });
            } catch (e) {}
            [archivoVoz, salida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
            resolve();
        });
    });
}

// ======= 5. AUTOMATIZACIÓN =======
async function autoReporte() {
    try {
        const climRes = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=4.57&longitude=-74.07&current_weather=true");
        const news = await obtenerNoticias();
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        let extras = (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 1800000)) ? ` Saludo de ${ultimoSaludo.nombre}: ${ultimoSaludo.texto}.` : "";
        
        const guion = await redactarIA(`Reporte: ${hora}. Suena: ${np.titulo}. Clima: ${Math.round(climRes.data.current_weather.temperature)}°C. Noticia: ${news}. ${extras} 50 palabras alegres.`);
        
        const pathVoz = `/tmp/v_auto.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        ultimoSaludo.fecha = null;
    } catch (e) { console.error("AutoReporte Error:", e.message); }
}

async function autoRedactorIA() {
    try {
        const guion = await redactarIA(`Dato rumbero o mensaje positivo. 40 palabras. Termina: Notas surcando fronteras.`);
        const pathVoz = `/tmp/v_red.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
    } catch (e) { console.error("Redactor Error:", e.message); }
}

// ======= 6. RUTAS =======
app.get('/', (req, res) => res.send("📻 La Fronterísima activa con Edge TTS."));

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
});

app.post("/procesar-locucion", async (req, res) => {
    const pathVoz = `/tmp/v_man.mp3`;
    try {
        await generarVoz(req.body.texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", req.body.conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

app.post("/redactar-guion", async (req, res) => {
    try {
        const guion = await redactarIA(`Guion rumbero sobre: ${req.body.idea}. 40 palabras.`);
        res.json({ guion });
    } catch (e) { res.status(500).json({ error: "Error IA" }); }
});

app.get('/health', (req, res) => res.sendStatus(200));

// ======= 7. INICIO =======
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor en puerto ${PORT} usando Google TTS`);
    // Ejecución inicial
    setTimeout(autoReporte, 15000); 
    setTimeout(autoRedactorIA, 20000);
    // Intervalos
    setInterval(autoReporte, 15 * 60 * 1000);
    setInterval(autoRedactorIA, 50 * 60 * 1000);
});