require('dotenv').config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const { pipeline } = require('stream/promises');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = {
    GROQ: safeTrim(process.env.GROQ_API_KEY),
    COHERE: safeTrim(process.env.COHERE_API_KEY),
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
let ultimoSaludo = { texto: "", fecha: null };

bot.on('polling_error', (error) => console.log("Telegram Error:", error.code)); 

bot.on('message', async (msg) => {
    if (!msg.text) return;

    if (msg.text.startsWith('/pedir ')) {
        const busqueda = msg.text.replace('/pedir ', '').trim();
        if (busqueda.length < 3) return bot.sendMessage(msg.chat.id, "Indique el nombre de la canción.");

        bot.sendMessage(msg.chat.id, `🔎 Buscando "${busqueda}"...`);
        const track = await buscarMusicaJamendo(busqueda, true); 

        if (track) {
            const exito = await descargarYSubirAzura(track, "Musica_Nueva", "pedido_actual.mp3");
            if (exito) {
                ultimoSaludo = { 
                    texto: `un oyente solicita la canción "${track.info}"`, 
                    fecha: new Date() 
                };
                bot.sendMessage(msg.chat.id, `✅ Solicitud procesada: "${track.info}".`);
            } else {
                bot.sendMessage(msg.chat.id, `❌ Error en el procesamiento.`);
            }
        }
        return;
    }

    if (!msg.text.startsWith('/')) {
        ultimoSaludo = {
            texto: msg.text,
            fecha: new Date()
        };
        bot.sendMessage(msg.chat.id, "Mensaje recibido. Gracias por participar.");
    }
});

// ======= 3. FUNCIONES DE APOYO =======

async function buscarMusicaJamendo(query, esBusquedaEspecifica = false) {
    const baseParametros = `client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&durationbetween=120_600&vocalinstrumental=vocal`;
    let queryParam = esBusquedaEspecifica 
        ? `search=${encodeURIComponent(query)}` 
        : `fuzzytags=latin&order=ratingdesc`;
    
    try {
        const res = await axios.get(`https://api.jamendo.com/v3.0/tracks/?${baseParametros}&${queryParam}`, { timeout: 8000 });
        if (res.data.results?.length > 0) {
            const t = res.data.results[0];
            return { url: t.audio, info: `${t.name} de ${t.artist_name}` };
        }
    } catch (e) { return null; }
}

async function descargarYSubirAzura(track, carpeta, nombreArchivo) {
    const tempFile = path.join(__dirname, `tmp_${Date.now()}.mp3`);
    try {
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        await pipeline(response.data, fs.createWriteStream(tempFile));
        const form = new FormData();
        form.append('path', carpeta); 
        form.append('file', fs.createReadStream(tempFile), { filename: `${carpeta}/${nombreArchivo}`, contentType: 'audio/mpeg' });
        await axios.post(AZURA_API_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, timeout: 120000 });
        if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return true;
    } catch (err) {
        if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return false;
    }
}

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios", titulo: "excelente música" };
    } catch (e) { return { artista: "varios", titulo: "su música favorita" }; }
}

async function obtenerNoticiasEuronews() {
    try {
        const res = await axios.get("https://es.euronews.com/rss?level=vertical&name=mundo", { timeout: 5000 });
        const matches = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g);
        if (matches && matches.length > 1) {
            return matches[1].replace(/<title><!\[CDATA\[|\]\]><\/title>/g, '').trim();
        }
        return "Actualidad mundial en desarrollo.";
    } catch (e) { return "Siga en sintonía."; }
}

function limpiarTexto(t) {
    if (!t) return "";
    return t.replace(/[*#_~]/g, '').replace(/Locutor:|Guion:|Respuesta:|Locutora:|Salomé:/gi, '').trim();
}

// ======= 4. IA (LENGUAJE NEUTRAL COLOMBIA) =======

async function redactarIA(prompt) {
    const systemPrompt = "Eres una voz institucional de radio profesional. Habla con un lenguaje neutral de Colombia (Bogotá/Centro). Usa un tono dinámico, amable y profesional. NO uses nombres de personas ni jerga regional.";
    
    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            max_tokens: 150
        }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 7000 });

        if (res.data?.choices?.[0]?.message?.content) return limpiarTexto(res.data.choices[0].message.content);
    } catch (e) {
        try {
            const res = await axios.post("https://api.cohere.ai/v1/chat", {
                model: "command-r-plus",
                message: prompt,
                preamble: systemPrompt
            }, { headers: { "Authorization": `Bearer ${KEYS.COHERE}`, "Content-Type": "application/json" }, timeout: 10000 });
            if (res.data?.text) return limpiarTexto(res.data.text);
        } catch (err) { return "Sintoniza La Fronterísima, conectando sus sentidos con el mundo."; }
    }
}

// ======= 5. VOZ Y PRODUCCIÓN =======

async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        // Voz clara y profesional colombiana
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural"; 
        const synth = new sdk.SpeechSynthesizer(config);
        
        // Ajuste neutral: Sin exceso de alegría local, más formal pero animado
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural"><mstts:express-as style="cheerful" styledegree="1.0" xmlns:mstts="https://www.w3.org/2001/mstts">
            <prosody rate="0%">${texto}</prosody></mstts:express-as></voice></speak>`;
        
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
        ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.07,atrim=duration=40[bg];[1:a]volume=1.5[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.4" -c:a libmp3lame -b:a 128k ${tempSalida}`;

    return new Promise((resolve) => {
        exec(cmd, async () => {
            try {
                const form = new FormData();
                form.append('path', ''); 
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
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
        const noticias = await obtenerNoticiasEuronews();
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            extras += ` Recibimos un mensaje de nuestra audiencia que dice: "${ultimoSaludo.texto}".`;
        }

        const prompt = `Brinda la hora (${hora}), el clima (${Math.round(clim.data.current_weather.temperature)}°C) y esta noticia: ${noticias}. Menciona que suena ${np.titulo}. ${extras} Hazlo profesional y neutral.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        ultimoSaludo.fecha = null; 
        console.log("✅ Actualización: dj_auto.mp3");
    } catch (e) { console.error("Error Reporte:", e.message); }
}

async function autoRedactorIA() {
    try {
        const temas = ["una recomendación de bienestar", "un dato sobre la industria musical", "una reflexión positiva"];
        const tema = temas[Math.floor(Math.random() * temas.length)];
        const prompt = `Redacta un comentario breve sobre ${tema}. Usa un lenguaje neutral y profesional. Máximo 40 palabras.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_red_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
        console.log("✅ Actualización: Redactor_ia.mp3");
    } catch (e) { console.error("Error Redactor:", e.message); }
}

// ======= 7. RUTAS Y SERVIDOR =======

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

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor profesional activo en puerto ${PORT}`);
    setTimeout(autoReporte, 5000);
    setTimeout(autoRedactorIA, 25000);
    setInterval(autoReporte, 15 * 60 * 1000);
    setInterval(autoRedactorIA, 50 * 60 * 1000);
});
