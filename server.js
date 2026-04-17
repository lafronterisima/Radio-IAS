require('dotenv').config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require("openai");
const { MsEdgeTTS } = require("ms-edge-tts"); 

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
const tts = new MsEdgeTTS(); // Inicializamos Edge TTS

// ======= 2. TELEGRAM (AUDIO, TEXTO Y PEDIDOS) =======

const bot = KEYS.TELEGRAM_TOKEN 
    ? new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true }) 
    : null;

let ultimoSaludo = { nombre: "", texto: "", fecha: null };

if (bot) {
    console.log("✅ Bot de Telegram: Conectado (Voz Salomé lista)");

    bot.on('polling_error', (err) => {
        if (err.code === 'EFATAL') console.error("❌ Error Crítico Telegram Token");
    });

    bot.on('voice', async (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, "🎤 Lupe está escuchando tu audio... dame un momento.");
        const tempVoice = path.join(__dirname, `v_${Date.now()}.ogg`);

        try {
            const fileId = msg.voice.file_id;
            const fileUrl = await bot.getFileLink(fileId);
            const response = await axios({ url: fileUrl, method: 'GET', responseType: 'stream' });
            const writer = fs.createWriteStream(tempVoice);
            response.data.pipe(writer);

            writer.on('finish', async () => {
                try {
                    const transcription = await openai.audio.transcriptions.create({
                        file: fs.createReadStream(tempVoice),
                        model: "whisper-1",
                        language: "es"
                    });

                    const textoEscuchado = transcription.text.toLowerCase();
                    ultimoSaludo = {
                        nombre: msg.from.first_name || "un oyente",
                        texto: `envió un audio: "${transcription.text}"`,
                        fecha: new Date()
                    };

                    if (textoEscuchado.includes("ponme") || textoEscuchado.includes("pon") || textoEscuchado.includes("quiero escuchar")) {
                        const busqueda = textoEscuchado.replace(/ponme|pon|quiero escuchar|la canción|por favor/g, "").trim();
                        bot.sendMessage(chatId, `🎧 Te escuché clarito, quieres: "${busqueda}". ¡Buscándola!`);
                        const track = await buscarMusicaJamendo(busqueda, true);
                        if (track && await descargarYSubirAzura(track)) {
                            bot.sendMessage(chatId, `✅ ¡Logrado! Ya programé "${track.info}".`);
                        } else {
                            bot.sendMessage(chatId, "No encontré esa canción, pero Lupe comentará tu audio.");
                        }
                    } else {
                        bot.sendMessage(chatId, `¡Entendido! Lupe ya procesó tu mensaje.`);
                    }
                } catch (err) {
                    bot.sendMessage(chatId, "No pude procesar el audio.");
                } finally {
                    setTimeout(() => { if (fs.existsSync(tempVoice)) fs.unlinkSync(tempVoice); }, 1000);
                }
            });
        } catch (e) {
            if (fs.existsSync(tempVoice)) fs.unlinkSync(tempVoice);
            bot.sendMessage(chatId, "Error de conexión con Telegram.");
        }
    });

    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) {
            if (msg.text?.startsWith('/pedir ')) {
                const busqueda = msg.text.replace('/pedir ', '').trim();
                if (busqueda.length < 3) return bot.sendMessage(msg.chat.id, "¡Dime qué buscas!");
                bot.sendMessage(msg.chat.id, `🔎 Buscando "${busqueda}"...`);
                const track = await buscarMusicaJamendo(busqueda, true);
                if (track && await descargarYSubirAzura(track)) {
                    ultimoSaludo = { nombre: msg.from.first_name || "un oyente", texto: `pidió "${track.info}"`, fecha: new Date() };
                    bot.sendMessage(msg.chat.id, `✅ ¡Listo! "${track.info}" programada.`);
                } else {
                    bot.sendMessage(msg.chat.id, "No encontré esa canción.");
                }
            }
            return;
        }
        ultimoSaludo = { nombre: msg.from.first_name || "un oyente", texto: msg.text, fecha: new Date() };
        bot.sendMessage(msg.chat.id, "¡Recibido! Tu saludo va para el aire.");
    });
}

// ======= 3. FUNCIONES DE APOYO =======

async function buscarMusicaJamendo(query, esBusquedaEspecifica = false) {
    const generos = ['salsa', 'reggaeton', 'bachata', 'vallenato'];
    let parametro = esBusquedaEspecifica ? `search=${encodeURIComponent(query)}` : `fuzzytags=${generos[Math.floor(Math.random() * generos.length)]}&order=ratingdesc`;
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&durationbetween=120_600&${parametro}`;
    try {
        const res = await axios.get(url, { timeout: 8000 });
        if (res.data.results?.length > 0) {
            const t = res.data.results[0];
            return { url: t.audio, info: `${t.name} de ${t.artist_name}` };
        }
    } catch (e) { return null; }
}

async function descargarYSubirAzura(track) {
    const tempFile = path.join(__dirname, 'tmp_track.mp3');
    const fileName = "estreno.mp3";
    const filePath = `Musica_Nueva/${fileName}`;

    try {
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);
        return new Promise((resolve) => {
            response.data.pipe(writer);
            writer.on('finish', async () => {
                try {
                    const form = new FormData();
                    form.append('file', fs.createReadStream(tempFile), { filename: fileName });
                    form.append('path', filePath);
                    await axios.post(AZURA_API_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, timeout: 60000 });
                    await axios.post(`${AZURA_BASE}/request/${encodeURIComponent(filePath)}`, {}, { headers: { "X-API-Key": KEYS.AZURA } });
                    if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                    resolve(true);
                } catch (err) { resolve(false); }
            });
        });
    } catch (e) { return false; }
}

async function obtenerNoticiasEuronews() {
    try {
        const res = await axios.get("https://es.euronews.com/rss?level=vertical&name=noticias", { timeout: 5000 });
        const matches = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>([^<]+)<\/title>/g);
        return (matches && matches.length > 1) ? matches[1].replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').trim() : "El mundo rumbero sigue en movimiento.";
    } catch (e) { return "Sintonía total con la actualidad."; }
}

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios", titulo: "éxitos" };
    } catch (e) { return { artista: "varios", titulo: "buena música" }; }
}

function limpiarTexto(t) {
    if (!t) return "";
    return t.replace(/[*#_~]/g, '').replace(/Soy Lupe|Lupe de La Fronterísima|Locutora:|Lupe:/gi, '').trim();
}

// ======= 4. IA Y VOZ (SALOMÉ) =======

async function redactarIA(prompt) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Eres locutora de radio rumbera colombiana carismática. EVITA tu nombre. Reacciona con emoción." },
                { role: "user", content: prompt }
            ],
            max_tokens: 250
        });
        return limpiarTexto(response.choices[0].message.content);
    } catch (e) { return "Notas surcando fronteras, quédate con nosotros."; }
}

// NUEVA FUNCIÓN GENERAR VOZ CON SALOMÉ (GRATIS)
async function generarVoz(texto, archivoDestino) {
    try {
        await tts.setMetadata("es-CO-SalomeNeural", "audio-24khz-48kbitrate-mono-mp3");
        await tts.toFile(archivoDestino, texto);
        console.log("🎙️ Voz de Salomé generada con éxito.");
    } catch (e) {
        console.error("Error Edge TTS:", e);
        // Fallback simple si falla (puedes añadir otro aquí)
    }
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondo = "fondo.mp3";
    // Mejoramos el audio con compand para que la voz resalte sobre el fondo
    let cmd = (conFondo && fs.existsSync(fondo))
    ? `ffmpeg -y -i ${archivoVoz} -i ${fondo} -filter_complex "[0:a]volume=1.8,compand=attacks=0:points=-30/-90|-20/-20|0/0[v];[1:a]volume=0.15[bg];[v][bg]amix=inputs=2:duration=first:dropout_transition=2" -c:a libmp3lame -b:a 128k ${tempSalida}`
    : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6,highpass=f=200,lowpass=f=3000" -c:a libmp3lame -b:a 128k ${tempSalida}`;
    
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

// ======= 5. AUTOMATIZACIÓN =======

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=4.57&longitude=-74.07&current_weather=true");
        const news = null; 
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            extras += ` SALUDO: ${ultimoSaludo.nombre} ${ultimoSaludo.texto}.`;
        }

        const prompt = `Reporte rumbero. Hora: ${hora}. Suena: ${np.titulo}. Clima: ${Math.round(clim.data.current_weather.temperature)}°C. Redacta un guion de 50 palabras alegre.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        ultimoSaludo.fecha = null; 
        console.log("✅ dj_auto.mp3 (Salomé) actualizado.");
    } catch (e) { console.error("Error AutoReporte:", e.message); }
}

async function autoRedactorIA() {
    try {
        const temas = ["un mensaje positivo", "historia rumbera", "dato musical"];
        const prompt = `Redacta 40 palabras sobre ${temas[Math.floor(Math.random() * temas.length)]}. Estilo rumbero.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_red_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
    } catch (e) { console.error("Error Redactor:", e.message); }
}

// ======= 6. RUTAS API =======

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.post("/procesar-locucion", async (req, res) => {
    const pathVoz = `v_man_${Date.now()}.mp3`;
    try {
        await generarVoz(req.body.texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", req.body.conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

app.post("/redactar-guion", async (req, res) => {
    try {
        const guion = await redactarIA(`Genera un guion de locución rumbero sobre: ${req.body.idea}. Máximo 40 palabras.`);
        res.json({ guion: guion });
    } catch (e) { res.status(500).json({ error: "Error de IA" }); }
});

app.get("/health", (req, res) => res.sendStatus(200));

// ======= 7. INICIO =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Nivel 5 PRO activada en puerto ${PORT}`);
    setTimeout(autoReporte, 5000);
    setInterval(autoReporte, 15 * 60 * 1000);
    setTimeout(autoRedactorIA, 20000); 
    setInterval(autoRedactorIA, 50 * 60 * 1000);
});
