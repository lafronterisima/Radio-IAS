require('dotenv').config();
const express = require("express");
const { google } = require('googleapis');
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const ytExec = require('youtube-dl-exec');
const path = require("path");
const { Groq } = require('groq-sdk');
const { Telegraf } = require('telegraf');
const YTMusic = require("ytmusic-api");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN =======
const safeTrim = (val) => (typeof val === 'string' ? val.trim() : "");
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = {
    GEMINI: safeTrim(process.env.GOOGLE_API_KEY),
    GROQ: safeTrim(process.env.GROQ_API_KEY),
    AZURE: safeTrim(process.env.AZURE_SPEECH_KEY),
    AZURE_REGION: safeTrim(process.env.AZURE_REGION),
    AZURA_KEY: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    YOUTUBE: safeTrim(process.env.YOUTUBE_KEY),
    AZURA_URL: safeTrim(process.env.AZURACAST_URL) // Ej: https://az.dominio.com
};

const AZURA_BASE = `${KEYS.AZURA_URL}/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

// ======= 2. INICIALIZACIÓN =======
const bot = new Telegraf(KEYS.TELEGRAM_TOKEN);
const ytmusic = new YTMusic();
const groq = new Groq({ apiKey: KEYS.GROQ });
const youtube = google.youtube({ version: 'v3', auth: KEYS.YOUTUBE });

let ultimoSaludo = { nombre: "", texto: "", fecha: null };

(async () => {
    try {
        await ytmusic.initialize();
        console.log("✅ YT Music inicializado");
    } catch (err) {
        console.error("❌ Error YT Music:", err);
    }
})();

// ======= 3. FUNCIONES DE APOYO (AUDIO Y SUBIDA) =======

async function descargarCancion(videoId) {
    const outputPath = path.join(__dirname, `temp_${videoId}.mp3`);
    const cookiePath = path.join(__dirname, 'cookies.txt'); // <--- Asegúrate que el archivo esté aquí

    const options = {
        extractAudio: true,
        audioFormat: 'mp3',
        output: outputPath,
        format: 'bestaudio/best',
    };

    // Si el archivo de cookies existe, lo usamos para evitar el bloqueo
    if (fs.existsSync(cookiePath)) {
        options.addHeader = `Cookie:${fs.readFileSync(cookiePath, 'utf8')}`;
        // O dependiendo de tu versión de youtube-dl-exec:
        options.cookies = cookiePath;
    }

    await ytExec(`https://www.youtube.com/watch?v=${videoId}`, options);
    return outputPath;
}

async function uploadToAzuraCast(filePath, fileName) {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), fileName);
    // Para archivos de música normales
    await axios.post(`${AZURA_BASE}/files`, form, {
        headers: { ...form.getHeaders(), 'X-API-Key': KEYS.AZURA_KEY }
    });
}

// ======= 4. LÓGICA DEL BOT DE TELEGRAM =======

bot.command('pedir', async (ctx) => {
    const query = ctx.payload;
    const nombreOyente = ctx.from.first_name || "un oyente";
    if (!query) return ctx.reply("🎙️ ¿Qué canción quieres? Ej: /pedir La Bachata");

    let statusMsg = await ctx.reply('🔍 Buscando en YouTube Music...');
    try {
        const resultados = await ytmusic.searchSongs(query);
        if (resultados.length === 0) return ctx.reply('No encontré esa canción.');

        const cancion = resultados[0];
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `⏳ Descargando: ${cancion.name}...`);
        
        const ruta = await descargarCancion(cancion.videoId);
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '🚀 Subiendo a la radio...');
        
        await uploadToAzuraCast(ruta, `${cancion.name}.mp3`);
        ultimoSaludo = { nombre: nombreOyente, texto: `pidió ${cancion.name}`, fecha: new Date() };
        
        if (fs.existsSync(ruta)) fs.unlinkSync(ruta);
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `✅ ¡${cancion.name} subida! Salomé la presentará.`);
    } catch (e) {
        ctx.reply("❌ Error procesando el pedido.");
    }
});

bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    const nombreOyente = ctx.from.first_name || "un oyente";
    ultimoSaludo = { nombre: nombreOyente, texto: ctx.message.text, fecha: new Date() };
    await ctx.reply(`¡Hola ${nombreOyente}! Salomé recibió tu mensaje. 🎙️`);
});

// ======= 5. INTELIGENCIA ARTIFICIAL Y VOZ =======

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios", titulo: "buena música" };
    } catch (e) { return { artista: "varios", titulo: "tu música favorita" }; }
}

async function redactarIA(prompt) {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 10000 });
        return res.data?.candidates?.[0]?.content?.parts?.[0]?.text.replace(/[*#_~]/g, '').trim();
    } catch (e) {
        return "Sintonizas La Fronterísima, la radio que rompe fronteras.";
    }
}

async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
        const synth = new sdk.SpeechSynthesizer(config);
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural"><mstts:express-as style="cheerful" styledegree="1.4" xmlns:mstts="https://www.w3.org/2001/mstts">
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
    let cmd = (conFondo && fs.existsSync(fondo))
        ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.08,atrim=duration=35,aresample=44100[bg];[1:a]volume=1.8,aresample=44100[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;

    return new Promise((resolve) => {
        exec(cmd, async () => {
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                await axios.post(AZURA_API_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA_KEY } });
                [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                resolve();
            } catch (e) { resolve(); }
        });
    });
}

// ======= 6. AUTOMATIZACIÓN =======

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            extras += ` SALUDO: ${ultimoSaludo.nombre} dice ${ultimoSaludo.texto}.`;
        }

        const prompt = `Salomé de La Fronterísima Cali. Hora: ${hora}. Música actual: ${np.titulo}. Temperatura: ${Math.round(clim.data.current_weather.temperature)}°C. ${extras} Haz una intervención alegre de 40 palabras.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        ultimoSaludo.fecha = null; 
        console.log("✅ dj_auto.mp3 actualizado.");
    } catch (e) { console.error("Error AutoReporte:", e.message); }
}

// ======= 7. ARRANQUE DEL SERVIDOR =======

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro en puerto ${PORT}`);
    bot.launch();
    
    // Intervalos
    setInterval(autoReporte, 14 * 60 * 1000); // Cada 15 min
    setTimeout(autoReporte, 5000); // Primer reporte al iniciar
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));


