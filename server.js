require('dotenv').config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const TelegramBot = require('node-telegram-bot-api');
const { pipeline } = require('stream/promises');
const ffmpeg = require('fluent-ffmpeg');


const app = express();

// ======= 1. CONFIGURACIÓN =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = {
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
};

const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;

// ======= 2. INICIALIZACIÓN =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });

// ======= 3. FUNCIONES DE APOYO =======

async function buscarEnDailymotion(query) {
    try {
        console.log(`🔎 Buscando en Dailymotion: ${query}`);
        
        // Usamos el endpoint público de Dailymotion
        const url = `https://api.dailymotion.com/videos?search=${encodeURIComponent(query)}&fields=id,title&limit=1`;
        const res = await axios.get(url);
        
        if (!res.data.list || res.data.list.length === 0) return null;

        const video = res.data.list[0];
        return {
            id: video.id,
            title: video.title,
            url: `https://www.dailymotion.com/video/${video.id}`
        };
    } catch (e) {
        console.error("❌ Error API Dailymotion:", e.message);
        return null;
    }
}

async function descargarYSubirAzura(video) {
    const tempFile = path.join(__dirname, `tmp_${video.id}.mp3`);
    const carpetaDestino = "Musica_Nueva";
    const nombreFinal = `pedido_${Date.now()}.mp3`;
    const rutaRelativaCompleta = `${carpetaDestino}/${nombreFinal}`;

    try {
        console.log(`🎙️ Extrayendo audio con FFmpeg de: ${video.title}`);

        // CONVERSIÓN: FFmpeg toma la URL de Dailymotion y la convierte a MP3
        await new Promise((resolve, reject) => {
            ffmpeg(video.url)
                .toFormat('mp3')
                .audioBitrate(192)
                .on('start', (cmd) => console.log("⚙️ FFmpeg procesando..."))
                .on('end', () => {
                    console.log("✅ MP3 generado correctamente.");
                    resolve();
                })
                .on('error', (err) => {
                    console.error("❌ Error FFmpeg:", err.message);
                    reject(err);
                })
                .save(tempFile);
        });

        console.log(`📤 Subiendo a AzuraCast...`);

        const form = new FormData();
        form.append('path', carpetaDestino);
        form.append('file', fs.createReadStream(tempFile), {
            filename: rutaRelativaCompleta,
            contentType: 'audio/mpeg'
        });

        const resAzura = await axios.post(AZURA_API_UPLOAD, form, {
            headers: {
                ...form.getHeaders(),
                "X-API-Key": KEYS.AZURA
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 240000 // 4 minutos
        });

        console.log(`🚀 ¡Subida exitosa a la radio!`);
        return true;

    } catch (err) {
        console.error("❌ Fallo en el proceso:", err.response?.data || err.message);
        return false;
    } finally {
        if (fs.existsSync(tempFile)) {
            try { fs.unlinkSync(tempFile); } catch (e) {}
        }
    }
}

// ======= 4. LÓGICA DE TELEGRAM =======

bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/pedir ')) {
        const busqueda = msg.text.replace('/pedir ', '').trim();
        
        if (busqueda.length < 3) return bot.sendMessage(msg.chat.id, "⚠️ El nombre es muy corto.");

        bot.sendMessage(msg.chat.id, `🎶 Buscando "${busqueda}" en Dailymotion...`);

        const video = await buscarEnDailymotion(busqueda);
        
        if (video) {
            bot.sendMessage(msg.chat.id, `⏳ Procesando audio: "${video.title}"...`);
            const exito = await descargarYSubirAzura(video);
            
            if (exito) {
                bot.sendMessage(msg.chat.id, `✅ ¡Hecho! "${video.title}" ya está en el sistema de la radio.`);
            } else {
                bot.sendMessage(msg.chat.id, `❌ Hubo un problema al subir el audio a AzuraCast.`);
            }
        } else {
            bot.sendMessage(msg.chat.id, `❌ No encontré resultados para esa búsqueda.`);
        }
    }
});

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios", titulo: "buena música" };
    } catch (e) { return { artista: "varios", titulo: "tu música favorita" }; }
}

async function obtenerNoticiasBBC() {
    try {
        const res = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml", { timeout: 5000 });
        const matches = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>([^<]+)<\/title>/g);
        if (matches && matches.length > 2) {
            return matches[1].replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').trim();
        }
        return "El mundo sigue vibrando.";
    } catch (e) { return "Sigue en sintonía."; }
}

function limpiarTexto(t) {
    if (!t) return "";
    return t.replace(/[*#_~]/g, '').replace(/Locutor:|Guion:|Respuesta:|Locutora:|Salomé:/gi, '').trim();
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
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.1-8b-instant",
                messages: [{ role: "system", content: "Locutora colombiana rumbera de Cali." }, { role: "user", content: prompt }]
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
                form.append('path', nombreFinal);
                await axios.post(AZURA_API_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, timeout: 60000 });
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

// ======= 7. RUTAS API =======

app.post("/redactar-guion", async (req, res) => {
    try {
        const promptManual = `Salomé de La Fronterísima. Guion alegre sobre: ${req.body.idea}. Máximo 40 palabras.`;
        const textoIa = await redactarIA(promptManual);
        res.json({ guion: textoIa }); 
    } catch (e) { res.json({ guion: "¡Sintonizas La Fronterísima!" }); }
});

app.post("/procesar-locucion", async (req, res) => {
    const pathVoz = `v_man_${Date.now()}.mp3`;
    try {
        await generarVoz(req.body.texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", req.body.conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.get("/health", (req, res) => res.sendStatus(200));

// ======= 8. INICIO DEL SERVIDOR =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro en puerto ${PORT}`);
    
    // Reporte de clima/noticias cada 15 minutos
    setTimeout(autoReporte, 5000);
    setInterval(autoReporte, 15 * 60 * 1000);

    // Contenido variado (Redactor_ia) cada 50 minutos
    setTimeout(autoRedactorIA, 20000); 
    setInterval(autoRedactorIA, 50 * 60 * 1000);
});
