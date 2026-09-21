/**
 * Sistema de Radio - La Fronterísima
 * Copyright (c) 2026
 * Licensed under the MIT License
 */

require('dotenv').config();
const cors = require('cors');
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require("openai");
const googleTTS = require("google-tts-api"); 

const app = express();
app.use(express.json());

// Permite solicitudes desde el dominio de la emisora
app.use(cors({
    origin: ['https://lafronterisima.stream', 'http://localhost:3000']
}));

app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN Y PARÁMETROS DE SERVIDOR =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "51").replace(/\D/g, "");

const KEYS = {
    OPENAI: safeTrim(process.env.OPENAI_API_KEY),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    JAMENDO_ID: safeTrim(process.env.JAMENDO_CLIENT_ID) || "c230e1f4"
};

// Configuración directa de streaming (Icecast)
const STREAM_CONFIG = {
    ip: "38.242.232.96",          // Servidor directo
    port: "8205",                 // Puerto del punto de montaje
    mount: "",                    // Montaje "/" (se deja vacío en la URL)
    user: "source",               // Usuario por defecto para streaming en Icecast
    password: KEYS.AZURA          // Contraseña de fuente / Streamer
};

const AZURA_BASE = `https://virtual5.emisorasvirtuales.com/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

const openai = new OpenAI({ apiKey: KEYS.OPENAI });    

// ======= HELPER: DESCARGA DE STREAMS =======
const downloadStream = (url, outputPath) => {
    return new Promise((resolve, reject) => {
        axios({ url, method: 'GET', responseType: 'stream' })
            .then(response => {
                const writer = fs.createWriteStream(outputPath);
                response.data.pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', reject);
            })
            .catch(reject);
    });
};

// ======= 2. TRANSMISIÓN DIRECTA A ICECAST (OPCIÓN 1) =======

/**
 * Procesa la voz con FFmpeg y la transmite EN VIVO directamente al servidor Icecast.
 * No sube archivos a AzuraCast; sale directo al aire.
 */
function transmitirDirectoAlStreaming(archivoVoz, conFondo = true) {
    return new Promise((resolve) => {
        if (!fs.existsSync(archivoVoz) || fs.statSync(archivoVoz).size === 0) {
            console.error("❌ Archivo de voz inexistente o vacío.");
            return resolve();
        }

        const fondo = path.join(__dirname, "fondo.mp3");
        const icecastUrl = `icecast://${STREAM_CONFIG.user}:${encodeURIComponent(STREAM_CONFIG.password)}@${STREAM_CONFIG.ip}:${STREAM_CONFIG.port}/${STREAM_CONFIG.mount}`;

        let cmd = "";

        if (conFondo && fs.existsSync(fondo)) {
            cmd = `ffmpeg -y -i "${fondo}" -i "${archivoVoz}" ` +
                  `-filter_complex "[0:a]volume=0.10[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" ` +
                  `-c:a libmp3lame -b:a 128k -content_type audio/mpeg -f mp3 "${icecastUrl}"`;
        } else {
            cmd = `ffmpeg -y -i "${archivoVoz}" -af "volume=1.6" ` +
                  `-c:a libmp3lame -b:a 128k -content_type audio/mpeg -f mp3 "${icecastUrl}"`;
        }

        console.log("📡 Conectando Salomé directamente a la señal en vivo (38.242.232.96:8205)...");

        exec(cmd, (error) => {
            if (error) {
                console.error("❌ Error en la transmisión directa a la emisora:", error.message);
            } else {
                console.log("🎙️ Salomé salió al aire exitosamente por el puerto 8205.");
            }

            // Limpieza del archivo local tras terminar la transmisión
            if (fs.existsSync(archivoVoz)) fs.unlinkSync(archivoVoz);
            resolve();
        });
    });
}

// ======= 3. TELEGRAM (SALUDOS Y PEDIDOS) =======
const bot = KEYS.TELEGRAM_TOKEN ? new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true }) : null;

let ultimoSaludo = { nombre: "", texto: "", fecha: null, esPedido: false, ubicacion: "" };

if (bot) {
    console.log("🎙️ Bot de Telegram: Conectado.");

    bot.on('polling_error', (err) => {
        if (err.code === 'EFATAL') console.error("❌ Error Crítico de Telegram:", err.message);
    });

    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const nombre = msg.from.first_name || "oyente";
        
        const bienvenida = `¡Hola ${nombre}! 👋 Bienvenido a **La Fronterísima**, la radio del futuro.\n\n` +
            `Soy **Salomé**, tu locutora IA. Puedes enviarme fotos, notas de voz o pedir canciones con el comando /pedir.\n\n` +
            `⚠️ **Aviso Importante:** Al enviar tu foto o audio, autorizas a La Fronterísima para comentarlos al aire mediante Salomé. ¡Gracias por sintonizarnos! 🎙️✨`;

        bot.sendMessage(chatId, bienvenida, { parse_mode: 'Markdown' });
    });

    // --- MENSAJES DE VOZ ---
    bot.on('voice', async (msg) => {
        const chatId = msg.chat.id;
        const nombreOyente = msg.from.first_name || "oyente";
        
        bot.sendMessage(chatId, "🎧 Salomé está escuchando tu audio...");
        
        const tempVoice = path.join(__dirname, `v_${Date.now()}.ogg`);
        const respuestaVozPath = path.join(__dirname, `res_${Date.now()}.mp3`);

        try {
            const fileUrl = await bot.getFileLink(msg.voice.file_id);
            await downloadStream(fileUrl, tempVoice);

            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tempVoice),
                model: "whisper-1",
                language: "es"
            });

            const textoEscuchado = transcription.text;
            const textoMinusculas = textoEscuchado.toLowerCase();
            
            const disparadores = ["ponme", "pon", "quiero escuchar", "suena", "suéltate"];
            const esMusical = disparadores.some(d => textoMinusculas.includes(d));
            
            ultimoSaludo = {
                nombre: nombreOyente,
                texto: textoEscuchado,
                fecha: new Date(),
                esPedido: esMusical,
                ubicacion: ""
            };

            const chatCompletion = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { 
                        role: "system", 
                        content: "Eres Salomé, locutora estrella de la radio La Fronterísima. Responde de forma muy breve (máximo 20 palabras), con mucha alegría, sabor rumbero y chispa colombiana." 
                    },
                    { 
                        role: "user", 
                        content: `El oyente ${nombreOyente} dice: "${textoEscuchado}". Respóndele directamente.` 
                    }
                ]
            });

            const respuestaTexto = chatCompletion.choices[0].message.content;

            await generarVoz(respuestaTexto, respuestaVozPath);

            await bot.sendVoice(chatId, respuestaVozPath, { 
                caption: `🎙️ **Salomé te respondió:**\n"${respuestaTexto}"`,
                parse_mode: 'Markdown'
            });

            if (esMusical) {
                const busqueda = textoMinusculas.replace(/ponme|pon|quiero escuchar|la canción|por favor|suéltate/g, "").trim();
                bot.sendMessage(chatId, `🎶 ¡Oído! Buscando: "${busqueda}" para ponerla al aire...`);
                const track = await buscarMusicaJamendo(busqueda, true);
                if (track) await descargarYSubirAzura(track, chatId);
            }

        } catch (err) { 
            console.error("❌ Error en voz de Salomé:", err);
            bot.sendMessage(chatId, "¡Uy! Se me entrecortó la señal. ¿Me repites por fa?");
        } finally { 
            setTimeout(() => {
                if (fs.existsSync(tempVoice)) fs.unlinkSync(tempVoice);
                if (fs.existsSync(respuestaVozPath)) fs.unlinkSync(respuestaVozPath);
            }, 5000);
        }
    });

    // --- FOTOS ---
    bot.on('photo', async (msg) => {
        const chatId = msg.chat.id;
        const nombreOyente = msg.from.first_name || "oyente";
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        
        try {
            const fileUrl = await bot.getFileLink(fileId);
            
            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    {
                        role: "system",
                        content: "Eres Salomé, locutora de La Fronterísima. Describe con alegría y sabor rumbero la foto que envió el oyente. Sé cercana, menciona detalles visibles y asume que están sintonizando la radio."
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: `Esta foto la envió ${nombreOyente}. Coméntala en máximo 280 caracteres.` },
                            { type: "image_url", image_url: { url: fileUrl } }
                        ],
                    },
                ],
            });

            const guionVisual = response.choices[0].message.content;
            const pathVoz = path.join(__dirname, `v_foto_${Date.now()}.mp3`);

            await generarVoz(guionVisual, pathVoz);
            // Salida directa al streaming en vivo
            await transmitirDirectoAlStreaming(pathVoz, true);

            bot.sendMessage(chatId, `📸 ¡Salomé ya comentó tu foto al aire por La Fronterísima!`);

        } catch (e) {
            console.error("Error en visión de Salomé:", e);
            bot.sendMessage(chatId, "¡Uy! Me distraje un segundo. ¿Me reenvías la foto?");
        }
    });
    
    // --- TEXTO / PEDIDOS MANUALES ---
    bot.on('message', async (msg) => {
        if (!msg.text) return;

        if (msg.text.startsWith('/pedir')) {
            const busqueda = msg.text.replace('/pedir', '').trim();
            if (!busqueda) {
                return bot.sendMessage(msg.chat.id, "Escribe el nombre del tema tras el comando. Ej: `/pedir salsa`", { parse_mode: 'Markdown' });
            }
            const track = await buscarMusicaJamendo(busqueda, true);
            if (track) {
                await descargarYSubirAzura(track, msg.chat.id);
                ultimoSaludo = { 
                    nombre: msg.from.first_name || "un oyente", 
                    texto: `pidió la canción: ${busqueda}`, 
                    fecha: new Date(),
                    esPedido: true,
                    ubicacion: ""
                };
                bot.sendMessage(msg.chat.id, "✅ ¡Programada! En breve suena al aire.");
            } else {
                bot.sendMessage(msg.chat.id, "❌ No encontré esa canción en el catálogo libre de derechos.");
            }
            return;
        }

        if (!msg.text.startsWith('/')) {
            ultimoSaludo = { nombre: msg.from.first_name || "un oyente", texto: msg.text, fecha: new Date(), esPedido: false, ubicacion: "" };
            bot.sendMessage(msg.chat.id, "📻 ¡Recibido! Tu saludo va para el aire.");
        }
    });
}

// ======= 4. FUNCIONES DE APOYO =======

async function obtenerNoticiaBBC() {
    try {
        const rssUrl = "https://feeds.bbci.co.uk/mundo/rss.xml";
        const res = await axios.get(rssUrl, { timeout: 5000 });
        const items = res.data.match(/<item>([\s\S]*?)<\/item>/);
        if (items) {
            const tituloMatch = items[1].match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || 
                               items[1].match(/<title>([\s\S]*?)<\/title>/);
            return tituloMatch ? tituloMatch[1] : "El mundo se mueve al ritmo de la buena música.";
        }
        return "Sintonía total en este momento.";
    } catch (e) { return "Mucha energía positiva para todos nuestros oyentes."; }
}

async function buscarMusicaJamendo(query, especifica = false) {
    const generos = ['salsa', 'reggaeton', 'bachata', 'vallenato', 'tropical'];
    const generoAleatorio = generos[Math.floor(Math.random() * generos.length)];

    let parametro = especifica 
        ? `search=${encodeURIComponent(query)}` 
        : `fuzzytags=${generoAleatorio}&order=ratingdesc`;

    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&durationbetween=120_600&${parametro}`;

    try {
        const res = await axios.get(url, { timeout: 8000 });
        if (res.data.results && res.data.results.length > 0) {
            const t = res.data.results[0];
            return { 
                url: t.audio, 
                name: t.name, 
                artist: t.artist_name,
                license: t.license_ccurl,
                share: t.shareurl,
                info: `${t.name} de ${t.artist_name}`
            };
        }
        return null;
    } catch (e) {
        console.error("❌ Error Jamendo API:", e.message);
        return null;
    }
}

async function descargarYSubirAzura(track, chatId = null) {
    const tempFile = path.join(__dirname, `tmp_${Date.now()}.mp3`);
    const fileName = `pedidovip_${Date.now()}.mp3`;
    
    try {
        await downloadStream(track.url, tempFile);

        const form = new FormData();
        form.append('file', fs.createReadStream(tempFile), { filename: fileName });
        form.append('path', `Musica_Nueva/${fileName}`);
        
        await axios.post(AZURA_API_UPLOAD, form, { 
            headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA } 
        });
        
        await axios.post(`${AZURA_BASE}/request/${encodeURIComponent('Musica_Nueva/' + fileName)}`, {}, { 
            headers: { "X-API-Key": KEYS.AZURA } 
        });

        if (chatId && bot) {
            const mensajeCreditos = `🎶 **Sonando Ahora:** ${track.name}\n` +
                `👤 **Artista:** ${track.artist}\n` +
                `📜 **Licencia:** [Creative Commons](${track.license})\n` +
                `🌐 [Escuchar en Jamendo](${track.share})`;
            
            bot.sendMessage(chatId, mensajeCreditos, { parse_mode: 'Markdown', disable_web_page_preview: true });
        }

    } catch (e) { 
        console.error("❌ Error en flujo de pedido AzuraCast:", e.message); 
    } finally {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
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
    return t.replace(/[*#_~]/g, '').replace(/Soy Lupe|Lupe de La Fronterísima|Locutora:|Lupe:|Salomé:/gi, '').trim();
}

// ======= 5. IA Y VOZ =======

async function redactarIA(prompt) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Eres Salomé, locutora de La Fronterísima. Alegre, carismática y colombiana. Máximo 320 caracteres. Texto plano." },
                { role: "user", content: prompt }
            ],
            max_tokens: 300 
        });
        return limpiarTexto(response.choices[0].message.content);
    } catch (e) { return "Notas surcando fronteras, quédate en sintonía."; }
}

async function generarVoz(texto, archivoDestino) {
    try {
        const urls = googleTTS.getAllAudioUrls(texto, {
            lang: 'es-CO',
            slow: false,
            host: 'https://translate.google.com',
        });
        const buffers = [];
        for (const item of urls) {
            const res = await axios({ url: item.url, method: 'GET', responseType: 'arraybuffer' });
            buffers.push(res.data);
        }
        fs.writeFileSync(archivoDestino, Buffer.concat(buffers));
    } catch (e) { 
        console.error("❌ Error Google TTS:", e.message); 
        throw e; 
    }
}

// ======= 6. AUTOMATIZACIÓN (SALIDA DIRECTA AL AIRE) =======

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=4.6097&longitude=-74.0817&current_weather=true");
        const np = await obtenerAhoraSuena();
        const noticia = await obtenerNoticiaBBC(); 
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            const loc = ultimoSaludo.ubicacion ? ` en ${ultimoSaludo.ubicacion}` : "";
            const prefijo = ultimoSaludo.esPedido ? "PEDIDO MUSICAL de" : "SALUDO de";
            extras += ` ${prefijo} ${ultimoSaludo.nombre}${loc}: "${ultimoSaludo.texto}".`;
        }

        const prompt = `Reporte radio. Hora: ${hora}. Suena: ${np.titulo}. Clima: ${Math.round(clim.data.current_weather.temperature)}°C. 
        INFORMACIÓN ÚLTIMO MINUTO: ${noticia}. 
        ${extras} 
        Redacta un guion alegre de unos 300 caracteres. Integra la noticia de forma natural como algo recién llegado a cabina, SIN decir la fuente.`;
        
        const guion = await redactarIA(prompt);
        const pathVoz = path.join(__dirname, `v_auto_${Date.now()}.mp3`);
        
        await generarVoz(guion, pathVoz);
        // Transmite directo al servidor por el puerto 8205
        await transmitirDirectoAlStreaming(pathVoz, true); 
        ultimoSaludo.fecha = null; 
    } catch (e) { console.error("Error AutoReporte:", e.message); }
}

async function autoRedactorIA() {
    try {
        const prompt = `Mensaje rumbero positivo, dato musical o efeméride. Termina: Notas surcando fronteras. Máximo 280 caracteres.`;
        const guion = await redactarIA(prompt);
        const pathVoz = path.join(__dirname, `v_red_${Date.now()}.mp3`);
        await generarVoz(guion, pathVoz);
        // Transmite directo al servidor por el puerto 8205
        await transmitirDirectoAlStreaming(pathVoz, true);
    } catch (e) { console.error("Error Redactor:", e.message); }
}

// ======= 7. RUTAS API =======

app.get('/oyente-conectado', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "";
    const cleanIp = ip.split(',')[0].trim(); 

    try {
        if (cleanIp && cleanIp !== "127.0.0.1" && cleanIp !== "::1") {
            const geo = await axios.get(`http://ip-api.com/json/${cleanIp}?fields=city,country`, { timeout: 3000 });
            if (geo.data && geo.data.city) {
                ultimoSaludo = {
                    nombre: "un oyente",
                    texto: "se acaba de conectar a la señal",
                    ubicacion: geo.data.city,
                    fecha: new Date(),
                    esPedido: false
                };
                console.log(`📍 Oyente detectado en: ${geo.data.city}`);
            }
        }
    } catch (e) { console.error("Error GeoIP:", e.message); }
    res.send("Sintonizado");
});

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.post("/procesar-locucion", async (req, res) => {
    const pathVoz = path.join(__dirname, `v_man_${Date.now()}.mp3`);
    const { texto, conFondo } = req.body;
    try {
        await generarVoz(texto, pathVoz);
        await transmitirDirectoAlStreaming(pathVoz, conFondo);
        res.send("OK - Transmitido al aire");
    } catch (e) { res.status(500).send("Error procesando audio"); }
});

app.post("/redactar-guion", async (req, res) => {
    try {
        const { idea } = req.body;
        const guion = await redactarIA(`Genera un guion rumbero sobre: ${idea}. Máximo 320 caracteres.`);
        res.json({ guion });
    } catch (e) { res.status(500).json({ error: "Error de IA" }); }
});

app.get("/health", (req, res) => res.sendStatus(200));

// ======= 8. INICIO DE SERVICIO =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima ONLINE en puerto ${PORT}`);
    setTimeout(autoReporte, 5000);
    setTimeout(autoRedactorIA, 20000); 
    setInterval(autoReporte, 15 * 60 * 1000);
    setInterval(autoRedactorIA, 50 * 60 * 1000);
});
