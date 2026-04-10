require('dotenv').config();
const { google } = require('googleapis');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require("child_process");
const { pipeline } = require('stream/promises');
const ytdl = require('@distube/ytdl-core');
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const { Groq } = require('groq-sdk');
const FormData = require('form-data');
const express = require("express");

// ======= 1. CONFIGURACIÓN Y VARIABLES GLOBALES =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

// Evita errores de "is not defined" en los reportes automáticos
let ultimoSaludo = { nombre: "", texto: "", fecha: null };

const KEYS = {
    GEMINI: safeTrim(process.env.GOOGLE_API_KEY),
    GROQ: safeTrim(process.env.GROQ_API_KEY),
    AZURE: safeTrim(process.env.AZURE_SPEECH_KEY),
    AZURE_REGION: safeTrim(process.env.AZURE_REGION),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    YOUTUBE: safeTrim(process.env.YOUTUBE_KEY)        
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const groq = new Groq({ apiKey: KEYS.GROQ });
const youtube = google.youtube({ version: 'v3', auth: KEYS.YOUTUBE });

// Polling en false para controlarlo manualmente en iniciarSistema()
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: false });

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files`;

// ======= 2. FUNCIONES DE APOYO (YOUTUBE Y AZURACAST) =======

async function buscarMusicaOficial(query) {
    try {
        if (!KEYS.YOUTUBE) return null;
        const res = await youtube.search.list({
            part: 'snippet',
            q: `${query} official audio`,
            maxResults: 1,
            type: 'video',
            videoCategoryId: '10'
        });
        if (!res.data.items || res.data.items.length === 0) return null;
        const item = res.data.items[0];
        return { 
            id: item.id.videoId, 
            title: item.snippet.title, 
            url: `https://www.youtube.com/watch?v=${item.id.videoId}` 
        };
    } catch (e) { 
        console.error("❌ Error YouTube:", e.message);
        return null; 
    }
}

async function subirAzura(rutaLocal, carpetaDestino, nombreFinal) {
    try {
        const form = new FormData();
        form.append('file', fs.createReadStream(rutaLocal));
        form.append('path', `${carpetaDestino}/${nombreFinal}`);
        await axios.post(AZURA_API_UPLOAD, form, {
            headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
            timeout: 60000
        });
        return true;
    } catch (e) {
        console.error(`❌ Error subiendo a ${carpetaDestino}:`, e.message);
        return false;
    }
}

async function refrescarAzura() {
    try { await axios.get(`${AZURA_BASE}/restart`, { headers: { "X-API-Key": KEYS.AZURA } }); } catch (e) {}
}

// ======= 3. IA Y VOZ (SALOMÉ) =======

async function obtenerGuionSalome(oyente, mensaje, esMusica) {
    try {
        const prompt = `Eres Salomé, locutora de La Fronterísima. Elegante y profesional. El oyente ${oyente} ${esMusica ? 'pidió: ' + mensaje : 'saludó: ' + mensaje}. Escribe un guion de 20 palabras. Sin emojis.`;
        const completion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama-3.1-8b-instant', // Modelo actualizado
            temperature: 0.7,
        });
        return completion.choices[0].message.content.replace(/[*#_]/g, '').trim();
    } catch (error) { return `Para ${oyente}, en sintonía de La Fronterísima.`; }
}

async function generarVozSalome(texto) {
    const filePath = path.join(__dirname, `v_${Date.now()}.mp3`);
    const speechConfig = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";
    // Corrección de formato (propiedad directa)
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitrateMonoMp3;

    const audioConfig = sdk.AudioConfig.fromAudioFileOutput(filePath);
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

    return new Promise((resolve, reject) => {
        synthesizer.speakTextAsync(texto, result => {
            synthesizer.close();
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                setTimeout(() => resolve(filePath), 500);
            } else { reject(new Error("Error Azure")); }
        }, err => { synthesizer.close(); reject(err); });
    });
}

// ======= 4. LÓGICA DEL BOT =======

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const nombre = msg.from.first_name || "oyente";
    bot.sendMessage(msg.chat.id, "🎙️ **Salomé:** _\"Preparando su pedido para la cabina...\"_");

    try {
        const video = await buscarMusicaOficial(msg.text);
        const esCancion = video && video.title.toLowerCase().includes(msg.text.toLowerCase().split(' ')[0]);
        const guion = await obtenerGuionSalome(nombre, esCancion ? video.title : msg.text, esCancion);
        const rutaVoz = await generarVozSalome(guion);

        // Guardamos para el reporte de los 15 min
        ultimoSaludo = { nombre, texto: msg.text, fecha: new Date() };

        if (esCancion) {
            const rutaMusica = path.join(__dirname, `m_${video.id}.mp3`);
            const stream = ytdl(video.url, { filter: 'audioonly', quality: 'highestaudio' });
            await pipeline(stream, fs.createWriteStream(rutaMusica));
            
            await subirAzura(rutaVoz, "Locuciones", `intro_${Date.now()}.mp3`);
            await subirAzura(rutaMusica, "Musica_Nueva", `pedido_${video.id}.mp3`);
            bot.sendMessage(msg.chat.id, `✅ **¡Listos!** Salomé presentará: ${video.title}`);
        } else {
            await subirAzura(rutaVoz, "Saludos", `saludo_${Date.now()}.mp3`);
            bot.sendMessage(msg.chat.id, "✅ **Saludo grabado.** Sonará en el próximo bloque.");
        }
    } catch (e) {
        bot.sendMessage(msg.chat.id, "⚠️ Hubo un bache. Intente de nuevo.");
    }
});

// ======= 6. AUTOMATIZACIÓN =======

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const bbc = await obtenerNoticiasBBC();
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            extras += ` SALUDO: ${ultimoSaludo.nombre} dice ${ultimoSaludo.texto}.`;
        }

        const prompt = `Salomé de La Fronterísima Cali. Hora: ${hora}. Música: ${np.titulo}. Clima: ${Math.round(clim.data.current_weather.temperature)}°C. Noticias: ${bbc}. ${extras} Guion rumbero de 50 palabras.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        ultimoSaludo.fecha = null; 
        console.log("✅ dj_auto.mp3 (15 min) actualizado.");
    } catch (e) { console.error("Error AutoReporte:", e.message); }
}

async function autoRedactorIA() {
    try {
        const temas = ["un mensaje positivo", "una efeméride musical", "un dato curioso de Cali", "historia de un artista de salsa"];
        const tema = temas[Math.floor(Math.random() * temas.length)];
        const prompt = `Salomé de La Fronterísima. Redacta 40 palabras sobre ${tema}. Muy alegre. Termina: Notas surcando fronteras.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_red_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
        console.log("✅ Redactor_ia.mp3 (50 min) actualizado.");
    } catch (e) { console.error("Error AutoRedactor:", e.message); }
}

// ======= 7. RUTAS API (INTERFAZ DE CONTROL) =======

// Permite generar solo el texto del guion desde el panel web
app.post("/redactar-guion", async (req, res) => {
    try {
        const promptManual = `Salomé de La Fronterísima. Guion alegre sobre: ${req.body.idea}. Máximo 40 palabras.`;
        const textoIa = await redactarIA(promptManual);
        res.json({ guion: textoIa }); 
    } catch (e) { 
        res.json({ guion: "¡Sintonizas La Fronterísima, notas surcando fronteras!" }); 
    }
});

// Procesa un texto, lo convierte a voz y lo sube como "Redactor_ia.mp3"
app.post("/procesar-locucion", async (req, res) => {
    const pathVoz = path.join(__dirname, `v_man_${Date.now()}.mp3`);
    try {
        // Usamos generarVoz (con SSML para estilo rumbero) y producirYSubir (con FFmpeg)
        await generarVoz(req.body.texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", req.body.conFondo);
        res.send("OK");
    } catch (e) { 
        console.error("❌ Error en locución manual:", e.message);
        res.status(500).send("Error al procesar locución"); 
    }
});

// Validación de entrada para el panel de administración
app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
});

// Endpoint de salud para monitoreo y Koyeb
app.get("/health", (req, res) => res.sendStatus(200));


// ======= 8. SERVER E INICIO (ORDEN FINAL) =======
const PORT = process.env.PORT || 8000;

app.get('/', (req, res) => res.status(200).send('📻 La Fronterísima Pro Online - Salomé está al aire'));

async function iniciarSistema() {
    try {
        if (!KEYS.TELEGRAM_TOKEN) return;

        console.log("🎙️ Limpiando rastro de versiones anteriores...");
        await bot.deleteWebHook({ drop_pending_updates: true });
        
        // Pequeño stop preventivo
        try { await bot.stopPolling(); } catch(e) {}

        console.log("⏳ Esperando estabilización de red (7s)...");
        
        setTimeout(async () => {
            try {
                await bot.startPolling();
                console.log("✅ Salomé escuchando en Telegram sin interferencias.");
            } catch (pollError) {
                console.error("⚠️ Error al iniciar polling:", pollError.message);
            }
        }, 7000);

    } catch (e) {
        console.error("❌ Error iniciando Bot:", e.message);
    }
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    
    iniciarSistema();

    // Ciclos de Reportes Automáticos
    setTimeout(() => {
        if (typeof autoReporte === "function") {
            autoReporte();
            setInterval(autoReporte, 15 * 60 * 1000);
        }
    }, 10000);

    setTimeout(() => {
        if (typeof autoRedactorIA === "function") {
            autoRedactorIA();
            setInterval(autoRedactorIA, 50 * 60 * 1000);
        }
    }, 30000);
});
