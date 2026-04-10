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

// ======= 1. CONFIGURACIÓN Y LLAVES (UNIFICADO) =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

// Al principio del archivo
let ultimoSaludo = "Bienvenidos a La Fronterísima";

const KEYS = {
    GEMINI: safeTrim(process.env.GOOGLE_API_KEY),
    GROQ: safeTrim(process.env.GROQ_API_KEY),
    AZURE: safeTrim(process.env.AZURE_SPEECH_KEY),
    AZURE_REGION: safeTrim(process.env.AZURE_REGION),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    YOUTUBE: safeTrim(process.env.YOUTUBE_KEY),
};

// ======= 2. INICIALIZACIÓN DE CLIENTES =======
const app = express();
const groq = new Groq({ apiKey: KEYS.GROQ });
const youtube = google.youtube({ version: 'v3', auth: KEYS.YOUTUBE });
// Configuración de Bot con autoStart desactivado para limpieza previa
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: false });

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_FILES = `${AZURA_BASE}/files`;

// Limpieza de conflicto de Telegram (Error 409)
bot.deleteWebHook().then(() => {
    console.log("🎙️ Sesiones previas de Telegram limpiadas.");
});

async function buscarMusicaOficial(query) {
    try {
        if (!KEYS.YOUTUBE) {
            console.error("❌ Error: No se encontró la API KEY de YouTube en las variables.");
            return null;
        }

        const res = await youtube.search.list({
            part: 'snippet',
            q: `${query} official audio`, // Agregamos "official audio" para mejor calidad
            maxResults: 1,
            type: 'video',
            videoCategoryId: '10' // Filtrar estrictamente por categoría "Música"
        });

        if (!res.data.items || res.data.items.length === 0) {
            console.log(`⚠️ No se encontraron resultados para: ${query}`);
            return null;
        }

        const item = res.data.items[0];
        return { 
            id: item.id.videoId, 
            title: item.snippet.title, 
            url: `https://www.youtube.com/watch?v=${item.id.videoId}` 
        };
    } catch (e) { 
        console.error("❌ Error en la API de YouTube:", e.message);
        return null; 
    }
}

// ======= 1. IA: EL PENSAMIENTO DE SALOMÉ (GROQ) =======
async function obtenerGuionSalome(oyente, mensaje, esMusica) {
    try {
        const prompt = `Eres Salomé, locutora de radio de "La Fronterísima". Elegante y sofisticada. 
        El oyente ${oyente} ${esMusica ? 'pidió: ' + mensaje : 'mandó este saludo: ' + mensaje}.
        Escribe un guion para radio muy breve (máximo 25 palabras) para presentarlo al aire. 
        Sin emojis ni asteriscos. Usa un tono profesional y cálido.`;

       const completion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: 'llama-3.1-8b-instant', 
    temperature: 0.7,
});
        
        return completion.choices[0].message.content.replace(/[*#_]/g, '').trim();
    } catch (error) {
        console.error("❌ Error en Groq:", error.message);
        return `Un saludo especial para ${oyente} que está en sintonía de La Fronterísima.`;
    }
}

// ======= 2. VOZ: LA LOCUCIÓN (AZURE) =======
async function generarVozSalome(texto) {
    const fileName = `locucion_${Date.now()}.mp3`;
    const filePath = path.join(__dirname, fileName);
    
    const speechConfig = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";
    
    // CORRECCIÓN CLAVE: Se asigna como propiedad, NO como función
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitrateMonoMp3;

    const audioConfig = sdk.AudioConfig.fromAudioFileOutput(filePath);
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

    return new Promise((resolve, reject) => {
        synthesizer.speakTextAsync(texto, result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                synthesizer.close(); // Cerramos después de completar
                setTimeout(() => resolve(filePath), 500); // Pequeño margen para liberar el archivo
            } else {
                synthesizer.close();
                reject(new Error(`Azure falló: ${result.errorDetails}`));
            }
        }, err => {
            synthesizer.close();
            reject(err);
        });
    });
}

// ======= 3. LÓGICA DEL BOT (UNIFICADA) =======
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const textoUsuario = msg.text.trim();
    const nombreOyente = msg.from.first_name || "un fiel oyente";

    bot.sendMessage(msg.chat.id, "🎙️ **Salomé:** _\"Permítame un instante, estoy preparando su mensaje para la cabina...\"_");

    try {
        // 1. Buscar en YouTube con la función profesional
        const video = await buscarMusicaOficial(textoUsuario);
        
        // Verificamos si la búsqueda coincide razonablemente con el texto del usuario
        const esCancion = video && video.title.toLowerCase().includes(textoUsuario.toLowerCase().split(' ')[0]);

        // 2. Generar el guion de la IA
        const guion = await obtenerGuionSalome(nombreOyente, esCancion ? video.title : textoUsuario, esCancion);
        
        // 3. Generar la voz (SALUDO/INTRO)
        const rutaLocucion = await generarVozSalome(guion);

        if (esCancion) {
            const nombreArchivoMusica = `pedido_${video.id}.mp3`;
            const rutaMusica = path.join(__dirname, nombreArchivoMusica);

            // Descargar de YouTube
            console.log("📥 Descargando canción:", video.title);
            const stream = ytdl(video.url, { filter: 'audioonly', quality: 'highestaudio' });
            await pipeline(stream, fs.createWriteStream(rutaMusica));

            // Subir Intro (Locución) a carpeta Locuciones
            await subirAzura(rutaLocucion, "Locuciones", `intro_${Date.now()}.mp3`);
            
            // Subir Música a carpeta Musica_Nueva
            const exitoMusica = await subirAzura(rutaMusica, "Musica_Nueva", nombreArchivoMusica);

            if (exitoMusica) {
                await refrescarAzura();
                bot.sendMessage(msg.chat.id, `✅ **¡Encontrada!**\n🎶 "${video.title}"\n\n🎙️ Salomé dice: _"${guion}"_`);
            }
        } else {
            // Caso: Es solo un saludo (se sube a carpeta Saludos)
            const exitoSaludo = await subirAzura(rutaLocucion, "Saludos", `saludo_${Date.now()}.mp3`);
            
            if (exitoSaludo) {
                await refrescarAzura();
                bot.sendMessage(msg.chat.id, `✅ **Mensaje enviado.**\n\n🎙️ Salomé grabó esto para ti: _"${guion}"_`);
            } else {
                throw new Error("Error al subir a carpeta Saludos");
            }
        }

    } catch (error) {
        console.error("❌ Error General en Bot:", error.message);
        bot.sendMessage(msg.chat.id, "⚠️ Hubo un bache en la señal. ¿Podrías intentar nuevamente?");
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


// ======= 5. SERVER E INICIO (ORDEN FINAL) =======
const PORT = process.env.PORT || 8000;

app.get('/', (req, res) => res.status(200).send('📻 La Fronterísima Pro Online'));

async function iniciarSistema() {
    try {
        if (!KEYS.TELEGRAM_TOKEN) return;

        // 1. Limpieza profunda
        console.log("🎙️ Limpiando rastro de versiones anteriores...");
        await bot.deleteWebHook({ drop_pending_updates: true });
        await bot.stopPolling();

        // 2. Tiempo de gracia para que Telegram cierre la sesión vieja
        console.log("⏳ Esperando estabilización de red...");
        
        setTimeout(async () => {
            try {
                await bot.startPolling();
                console.log("✅ Salomé escuchando en Telegram sin interferencias.");
            } catch (pollError) {
                console.error("⚠️ Error al iniciar polling, reintentando...");
            }
        }, 7000); // 7 segundos es el tiempo ideal para evitar el 409 en Koyeb

    } catch (e) {
        console.error("❌ Error iniciando Bot:", e.message);
    }
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    
    iniciarSistema();

    // Iniciar reportes automáticos
    // Asegúrate de que las funciones autoReporte y autoRedactorIA estén escritas arriba
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
