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

// ======= 1. CONFIGURACIÓN COMPLETA (PROTEGIDA) =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = {
    GEMINI: safeTrim(process.env.GOOGLE_API_KEY),
    GROQ: safeTrim(process.env.GROQ_API_KEY),
    AZURE: safeTrim(process.env.AZURE_SPEECH_KEY),
    AZURE_REGION: safeTrim(process.env.AZURE_REGION) || "eastus",
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    JAMENDO_ID: safeTrim(process.env.JAMENDO_CLIENT_ID) || "c230e1f4"
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

// ======= 2. TELEGRAM (SALUDOS Y PEDIDOS) =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
let ultimoSaludo = { nombre: "", texto: "", fecha: null };
let cancionRecienDescubierta = null;

bot.on('polling_error', () => {}); // Silenciar errores de conexión ECONNRESET

bot.on('message', async (msg) => {
    if (!msg.text) return;

    // COMANDO /PEDIR: El oyente pide una canción y Jamendo la busca y sube
    if (msg.text.startsWith('/pedir ')) {
        const busqueda = msg.text.replace('/pedir ', '').trim();
        if (busqueda.length < 3) return bot.sendMessage(msg.chat.id, "¡Dime el nombre de la canción o artista! 🎵");

        bot.sendMessage(msg.chat.id, `🔎 Buscando "${busqueda}" en La Fronterísima...`);
        const track = await buscarMusicaJamendo(busqueda, true); 

        if (track) {
            await descargarYSubirAzura(track);
            ultimoSaludo = { 
                nombre: msg.from.first_name || "un oyente", 
                texto: `pidió la canción ${track.info} y ya la tenemos lista`, 
                fecha: new Date() 
            };
            bot.sendMessage(msg.chat.id, `✅ ¡Concedido! Subí "${track.info}". Salomé te la dedicará pronto.`);
        } else {
            bot.sendMessage(msg.chat.id, `❌ No encontré "${busqueda}" en el catálogo libre. ¡Prueba con otro!`);
        }
        return;
    }

    // COMANDO /DESCUBRIR: Busca algo aleatorio
    if (msg.text === '/descubrir') {
        bot.sendMessage(msg.chat.id, "🔎 Buscando una joya musical aleatoria...");
        const track = await buscarMusicaJamendo('latin', false);
        if (track) {
            await descargarYSubirAzura(track);
            cancionRecienDescubierta = track.info;
            bot.sendMessage(msg.chat.id, `✅ ¡Estreno! Subí "${track.info}".`);
        }
        return;
    }

    // SALUDOS NORMALES
    if (!msg.text.startsWith('/')) {
        ultimoSaludo = {
            nombre: msg.from.first_name || "un oyente",
            texto: msg.text,
            fecha: new Date()
        };
        bot.sendMessage(msg.chat.id, "¡Recibido! Tu saludo saldrá al aire pronto. 🎙️");
    }
});

// ======= 3. FUNCIONES DE APOYO & JAMENDO =======

async function buscarMusicaJamendo(query, esEspecifico) {
    const parametro = esEspecifico ? `search=${encodeURIComponent(query)}` : `fuzzytags=${query}&order=random`;
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&${parametro}`;
    
    try {
        const res = await axios.get(url, { timeout: 8000 });
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
    const tempFile = path.join(__dirname, 'tmp_track.mp3');
    try {
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);
        response.data.pipe(writer);
        return new Promise((resolve) => {
            writer.on('finish', async () => {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempFile), { filename: track.nombre });
                form.append('path', `Musica_Nueva/${track.nombre}`);
                await axios.post(AZURA_API_UPLOAD, form, { 
                    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, 
                    timeout: 90000 
                });
                if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                resolve(true);
            });
        });
    } catch (e) { console.error("Error en carga:", e.message); }
}

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios artistas", titulo: "la mejor música" };
    } catch (e) { return { artista: "varios artistas", titulo: "tu música favorita" }; }
}

function limpiarTexto(t) {
    if (!t) return "";
    return t.replace(/```[a-z]*\n?/gi, '').replace(/[*#_~]/g, '')
            .replace(/Locutor:|Guion:|Respuesta:|Locutora:|Salomé:/gi, '').trim();
}

// ======= 4. INTELIGENCIA ARTIFICIAL =======

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
                messages: [{ role: "system", content: "Locutora colombiana de La Fronterísima." }, { role: "user", content: prompt }]
            }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 8000 });
            return limpiarTexto(res.data?.choices?.[0]?.message?.content);
        } catch (err) { return "Sintonizas La Fronterísima, notas surcando fronteras."; }
    }
}

// ======= 5. VOZ Y PRODUCCIÓN =======

async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
        const synth = new sdk.SpeechSynthesizer(config);
        const ssml = `<speak version="1.0" xmlns="[http://www.w3.org/2001/10/synthesis](http://www.w3.org/2001/10/synthesis)" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural"><mstts:express-as style="cheerful" styledegree="1.4" xmlns:mstts="[https://www.w3.org/2001/mstts](https://www.w3.org/2001/mstts)">
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
    const fondo = "fondo.mp3", intro = "intro.mp3";
    let cmd = (conFondo && fs.existsSync(fondo) && fs.existsSync(intro)) 
        ? `ffmpeg -y -i ${intro} -i ${archivoVoz} -i ${fondo} -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[v_full]; [2:a]volume=0.12[bg]; [v_full]volume=1.8[v]; [bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;

    return new Promise((resolve) => {
        exec(cmd, async () => {
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
            } catch (e) { resolve(); }
        });
    });
}

// ======= 6. RUTAS API =======

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.post("/redactar-guion", async (req, res) => {
    const { idea } = req.body;
    const guion = await redactarIA(`Locutora Salomé de La Fronterísima. Guion alegre sobre: ${idea}. Máximo 40 palabras. Usa el eslogan: Notas surcando fronteras.`);
    res.json({ guion });
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
        const clim = await axios.get("[https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true](https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true)");
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            extras += ` PEDIDO/SALUDO: ${ultimoSaludo.nombre} dice "${ultimoSaludo.texto}".`;
        }
        if (cancionRecienDescubierta) {
            extras += ` ESTRENO: Acabamos de subir ${cancionRecienDescubierta} a la radio.`;
            cancionRecienDescubierta = null;
        }

        const prompt = `Actúa como Salomé de La Fronterísima. Hora: ${hora}. Música: ${np.titulo}. Clima: ${Math.round(clim.data.current_weather.temperature)}°C en Cali. ${extras} Guion de 50 palabras, vibrante y colombiano. Termina: Notas surcando fronteras.`;
        
        const guion = await redactarIA(prompt);
        await generarVoz(guion, "v_auto.mp3");
        await producirYSubir("v_auto.mp3", "dj_auto.mp3", true);
        ultimoSaludo.fecha = null;
        console.log(`✅ Reporte automático OK [${hora}]`);
    } catch (e) { console.error("Error Auto:", e.message); }
}

// ======= 8. INICIO =======
app.get("/health", (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro en puerto ${PORT}`);
    setTimeout(autoReporte, 5000);
    setInterval(autoReporte, 15 * 60 * 1000);
});
