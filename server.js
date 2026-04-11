require('dotenv').config();
const express = require("express");
const { google } = require('googleapis');
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const ytdl = require('@distube/ytdl-core');
const { Groq } = require('groq-sdk');
const TelegramBot = require('node-telegram-bot-api');
const { pipeline } = require('stream/promises');
const sdk = require("microsoft-cognitiveservices-speech-sdk");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN DE CLAVES =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = {
    GROQ: safeTrim(process.env.GROQ_API_KEY),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    YOUTUBE: safeTrim(process.env.YOUTUBE_KEY),
    AZURE_KEY: safeTrim(process.env.AZURE_SPEECH_KEY),
    AZURE_REGION: safeTrim(process.env.AZURE_REGION)
};

// --- VALIDACIÓN CRÍTICA DE AZURE ---
if (!KEYS.AZURE_KEY || !KEYS.AZURE_REGION) {
    console.error("❌ ERROR: Faltan llaves de Azure (AZURE_SPEECH_KEY o AZURE_REGION) en el .env");
}

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

// ======= 2. INICIALIZACIÓN =======
const groq = new Groq({ apiKey: KEYS.GROQ });
const youtube = google.youtube({ version: 'v3', auth: KEYS.YOUTUBE });

// Una sola instancia. Si da error 409, cierra todas las terminales y abre solo una.
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });

let ultimoSaludo = { nombre: "", texto: "", fecha: null };

// ======= 3. FUNCIONES DE APOYO =======

function limpiarNombreArchivo(texto) {
    return texto
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]/g, "_")
        .substring(0, 50);
}

async function buscarMusicaYouTube(query) {
    try {
        if (!KEYS.YOUTUBE) throw new Error("Falta YOUTUBE_KEY");
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

async function descargarYSubirAzura(video) {
    const tempFile = path.join(__dirname, 'tmp_yt_track.mp3');
    const carpetaDestino = "Musica_Nueva";
    const nombreArchivo = "pedido_actual.mp3"; 
    const rutaRelativaCompleta = `${carpetaDestino}/${nombreArchivo}`;

    try {
        console.log(`📥 Iniciando descarga de: ${video.title}`);
        
        // Usamos una configuración de stream más robusta
        const stream = ytdl(video.url, { 
            filter: 'audioonly', 
            quality: 'highestaudio',
            // Aumentamos el buffer a 64MB para evitar que se quede "colgado"
            highWaterMark: 1 << 26 
        });

        // Pipeline con control de errores directo
        await pipeline(stream, fs.createWriteStream(tempFile));
        console.log("📦 Archivo descargado temporalmente. Subiendo a Azura...");

        const form = new FormData();
        form.append('path', carpetaDestino); 
        form.append('file', fs.createReadStream(tempFile), { 
            filename: rutaRelativaCompleta, 
            contentType: 'audio/mpeg'
        });

        // Añadimos un timeout de 3 minutos para la subida
        await axios.post(AZURA_API_UPLOAD, form, { 
            headers: { 
                ...form.getHeaders(), 
                "X-API-Key": KEYS.AZURA 
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 180000 
        });

        console.log(`✅ ¡Éxito total! ${video.title} subida.`);
        
        if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return true;

    } catch (err) {
        console.error("❌ Error en el proceso de audio:", err.message);
        // Limpiamos el archivo temporal si falló para no llenar el disco
        if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return false;
    }
}

// ======= 4. LÓGICA DE TELEGRAM =======


bot.on('message', async (msg) => {
    // 1. Filtro de seguridad
    if (!msg.text || msg.from.is_bot) return;

    const chatId = msg.chat.id;
    const nombre = msg.from.first_name || "oyente";

    // 2. Manejo del comando /pedir
    if (msg.text.startsWith('/pedir ')) {
        const busqueda = msg.text.replace('/pedir ', '').trim();
        
        if (busqueda.length < 3) {
            return bot.sendMessage(chatId, "⚠️ Por favor, escribe un nombre más largo para buscar.");
        }

        try {
            // Paso 1: Buscar
            const video = await buscarMusicaYouTube(busqueda);
            
            if (!video) {
                return bot.sendMessage(chatId, `❌ No encontré "${busqueda}" en el catálogo oficial.`);
            }

            // Paso 2: Notificar inicio de proceso
            const statusMsg = await bot.sendMessage(chatId, `🔍 Encontrada: *${video.title}*\n⏳ Procesando audio...`, { parse_mode: 'Markdown' });

            // Paso 3: Descargar y Subir (con espera)
            const exito = await descargarYSubirAzura(video);

            if (exito) {
                // Actualizar memoria para Salomé
                ultimoSaludo = { 
                    nombre: nombre, 
                    texto: `pidió la canción "${video.title}"`, 
                    fecha: new Date() 
                };

                // Confirmación final al usuario
                await bot.editMessageText(`✅ **¡Éxito!**\n🎶 *${video.title}*\nLa canción ya está en cabina. ¡Salomé la presentará pronto!`, {
                    chat_id: chatId,
                    message_id: statusMsg.message_id,
                    parse_mode: 'Markdown'
                });
            } else {
                throw new Error("Error en la subida a AzuraCast");
            }

        } catch (error) {
            console.error("Error en pedido:", error.message);
            bot.sendMessage(chatId, "❌ Lo siento, hubo un problema al procesar tu canción. Intenta de nuevo en unos minutos.");
        }
        return; // Finaliza aquí si es un comando
    }

    // 3. Manejo de saludos normales (si no es un comando)
    if (!msg.text.startsWith('/')) {
        ultimoSaludo = { 
            nombre: nombre, 
            texto: msg.text, 
            fecha: new Date() 
        };
        bot.sendMessage(chatId, `🎙️ ¡Recibido, ${nombre}! Tu saludo ya está en la lista de Salomé.`);
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
        
        let mencionSaludo = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            mencionSaludo = `OYENTE: ${ultimoSaludo.nombre} dice "${ultimoSaludo.texto}".`;
        }

        const prompt = `Locutora La Fronterísima. Hora: ${hora}. Música: ${np.titulo} de ${np.artista}. Clima: ${Math.round(clim.data.current_weather.temperature)}°C en Colombia. Noticias: ${bbc}. ${mencionSaludo} Guion de 55 palabras, muy alegre.`;
        
        const guion = await redactarIA(prompt);
        await generarVoz(guion, "v_auto.mp3");
        await producirYSubir("v_auto.mp3", "dj_auto.mp3", true);
        ultimoSaludo.fecha = null;
        console.log("✅ dj_auto.mp3 actualizado.");
    } catch (e) { console.error("Error Auto:", e.message); }
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
