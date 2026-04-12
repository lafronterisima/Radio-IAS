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
    GEMINI: safeTrim(process.env.GOOGLE_API_KEY),
    GROQ: safeTrim(process.env.GROQ_API_KEY),
    AZURE: safeTrim(process.env.AZURE_SPEECH_KEY),
    AZURE_REGION: safeTrim(process.env.AZURE_REGION),
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

bot.on('polling_error', () => {}); 

bot.on('message', async (msg) => {
    if (!msg.text) return;

    if (msg.text.startsWith('/pedir ')) {
        const busqueda = msg.text.replace('/pedir ', '').trim();
        if (busqueda.length < 3) return bot.sendMessage(msg.chat.id, "¡Dime el nombre de la canción! 🎵");

        bot.sendMessage(msg.chat.id, `🔎 Buscando "${busqueda}"...`);
        const track = await buscarMusicaJamendo(busqueda, true); 

        if (track) {
            const exito = await descargarYSubirAzura(track);
            if (exito) {
                // Media ID fijo para pedido_actual.mp3 obtenido en AzuraCast
                await solicitarCancionEnAzura(6991); 

                ultimoSaludo = { 
                    nombre: msg.from.first_name || "un oyente", 
                    texto: `pidió la canción "${track.info}"`, 
                    fecha: new Date() 
                };
                bot.sendMessage(msg.chat.id, `✅ ¡Subida y solicitada! "${track.info}". Salomé la presentará pronto.`);
            } else {
                bot.sendMessage(msg.chat.id, `❌ Error al procesar el archivo.`);
            }
        } else {
            bot.sendMessage(msg.chat.id, `❌ No encontré esa canción.`);
        }
        return;
    }

    if (!msg.text.startsWith('/')) {
        ultimoSaludo = {
            nombre: msg.from.first_name || "un oyente",
            texto: msg.text,
            fecha: new Date()
        };
        bot.sendMessage(msg.chat.id, "¡Recibido! Tu saludo saldrá al aire. 🎙️");
    }
});

// ======= 3. FUNCIONES DE APOYO =======

async function buscarMusicaJamendo(query, esBusquedaEspecifica = false) {
    const generos = ['salsa', 'reggaeton', 'bachata', 'vallenato'];
    let baseParametros = `client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&durationbetween=120_600&vocalinstrumental=vocal`;
    let queryParam = esBusquedaEspecifica 
        ? `search=${encodeURIComponent(query)}` 
        : `fuzzytags=${generos[Math.floor(Math.random() * generos.length)]}&order=ratingdesc`;
    
    const url = `https://api.jamendo.com/v3.0/tracks/?${baseParametros}&${queryParam}`;
    try {
        const res = await axios.get(url, { timeout: 8000 });
        if (res.data.results?.length > 0) {
            const t = res.data.results[0];
            return { url: t.audio, info: `${t.name} de ${t.artist_name}` };
        }
    } catch (e) { return null; }
}
  
async function solicitarCancionEnAzura(mediaId) {
    try {
        await axios.post(`${AZURA_BASE}/request/${mediaId}`, {}, {
            headers: { "X-API-Key": KEYS.AZURA }
        });
        console.log("🚀 Pedido enviado a la cola de AzuraCast.");
        return true;
    } catch (error) {
        console.error("❌ Error al solicitar canción:", error.response?.data || error.message);
        return false;
    }
}

async function descargarYSubirAzura(track) {
    const tempFile = path.join(__dirname, 'tmp_track.mp3');
    const nombreArchivo = "pedido_actual.mp3";
    const carpetaDestino = "Musica_Nueva"; 

    try {
        console.log(`📥 Descargando: ${track.info}`);
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        await pipeline(response.data, fs.createWriteStream(tempFile));

        const form = new FormData();
        form.append('path', carpetaDestino); 
        const rutaRelativaCompleta = `${carpetaDestino}/${nombreArchivo}`;
        form.append('file', fs.createReadStream(tempFile), { 
            filename: rutaRelativaCompleta,
            contentType: 'audio/mpeg'
        });

        console.log(`📤 Subiendo a: ${rutaRelativaCompleta}`);
        await axios.post(AZURA_API_UPLOAD, form, { 
            headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
            maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 120000 
        });

        if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return true;
    } catch (err) {
        console.error("❌ Error Azura:", err.response?.data || err.message);
        if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return false;
    }
}

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

// ======= 4. INTELIGENCIA ARTIFICIAL (FALLBACK A GEMINI) =======

async function redactarIA(prompt) {
    // Principal: GROQ
    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: "Eres Salomé, locutora rumbera de Cali de La Fronterísima. Habla con mucho sabor." },
                { role: "user", content: prompt }
            ]
        }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 8000 });
        return limpiarTexto(res.data?.choices?.[0]?.message?.content);
    } catch (e) {
        // Respaldo: GEMINI
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
            const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 10000 });
            const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (texto) return limpiarTexto(texto);
        } catch (err) { 
            console.error("❌ Fallo total IA:", err.message);
            return "Sintonizas La Fronterísima, notas surcando fronteras."; 
        }
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
        let temp = "25";
        try {
            const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true", { timeout: 5000 });
            temp = Math.round(clim.data.current_weather.temperature);
        } catch (e) {}

        let bbc = await obtenerNoticiasBBC();
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });

        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 15 * 60 * 1000)) {
            extras = `Saluda a ${ultimoSaludo.nombre} que dice: ${ultimoSaludo.texto}.`;
        }

        const prompt = `Salomé de La Fronterísima Cali. Hora: ${hora}. Música: ${np.titulo}. Clima: ${temp}°C. Noticias: ${bbc}. ${extras} Guion rumbero de 50 palabras.`;
        
        const guion = await redactarIA(prompt);
        if (!guion) throw new Error("IA sin respuesta");

        const pathVoz = `v_auto_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        
        ultimoSaludo.fecha = null; 
        console.log(`✅ dj_auto.mp3 actualizado [${hora}]`);
    } catch (e) {
        console.error("❌ Error AutoReporte:", e.response?.data || e.message);
    }
}

async function autoRedactorIA() {
    try {
        const temas = ["un mensaje positivo", "una efeméride musical", "un dato curioso de Cali", "historia de la salsa"];
        const tema = temas[Math.floor(Math.random() * temas.length)];
        const prompt = `Salomé locutora. Redacta 40 palabras sobre ${tema}. Muy alegre. Termina: Notas surcando fronteras.`;
        
        const guion = await redactarIA(prompt);
        if (!guion) throw new Error("IA sin respuesta");

        const pathVoz = `v_red_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
        console.log("✅ Redactor_ia.mp3 actualizado.");
    } catch (e) {
        console.error("❌ Error AutoRedactor:", e.response?.data || e.message);
    }
}

// ======= 7. RUTAS API =======

app.post("/redactar-guion", async (req, res) => {
    try {
        const textoIa = await redactarIA(`Salomé. Guion alegre sobre: ${req.body.idea}. 40 palabras.`);
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

// ======= 8. INICIO =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro en puerto ${PORT}`);
    setTimeout(autoReporte, 5000);
    setInterval(autoReporte, 15 * 60 * 1000);
    setTimeout(autoRedactorIA, 20000); 
    setInterval(autoRedactorIA, 50 * 60 * 1000);
});
