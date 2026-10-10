require('dotenv').config();
const cors = require('cors');
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec, spawn } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require("openai");
const googleTTS = require("google-tts-api");

const app = express();
app.use(express.json());

// ======= CORS (una sola vez, con restricción) =======
app.use(cors({
    origin: ['https://lafronterisima.stream', 'https://www.lafronterisima.stream']
}));

// Configuración para Northflank: confiar en el proxy para obtener la IP real
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "51").replace(/\D/g, "");

const KEYS = {
    OPENAI: safeTrim(process.env.OPENAI_API_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    JAMENDO_ID: safeTrim(process.env.JAMENDO_CLIENT_ID) || "c230e1f4"
};

if (!KEYS.OPENAI) {
    console.error("⚠️ OPENAI_API_KEY no configurada. El bot no podrá funcionar.");
}

// ======= CONFIGURACIÓN DE ICECAST =======
const ICECAST = {
    host: process.env.ICECAST_HOST || "38.242.232.96",
    port: parseInt(process.env.ICECAST_PORT || "8205", 10),
    mount: process.env.ICECAST_MOUNT || "/",
    user: process.env.ICECAST_USER || "source",
    password: safeTrim(process.env.ICECAST_PASSWORD) || "TU_PASSWORD_AQUI"
};

const ICECAST_URL = `icecast://${ICECAST.user}:${ICECAST.password}@${ICECAST.host}:${ICECAST.port}${ICECAST.mount}`;

// ======= ESTADO DEL STREAM PERSISTENTE =======
let ffmpegProcess = null;         // Proceso FFmpeg conectado a IceCast
let silenceBuffer = null;         // Buffer MP3 de silencio (para mantener conexión)
let isPlayingAudio = false;       // Flag: ¿se está reproduciendo audio real?
let writeLoopRunning = false;     // Control del loop de escritura
let shutdown = false;             // Control de apagado

const openai = new OpenAI({ apiKey: KEYS.OPENAI || "sk-placeholder" });

// ======= 2. TELEGRAM (SALUDOS Y PEDIDOS) =======
const bot = KEYS.TELEGRAM_TOKEN ? new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true }) : null;

let ultimoSaludo = { nombre: "", texto: "", fecha: null, esPedido: false, ubicacion: "" };

if (bot) {
    console.log("🎙️ Bot de Telegram: Conectado.");

    bot.on('polling_error', (err) => {
        if (err.code === 'EFATAL') console.error("❌ Error Crítico de Telegram.");
    });

    // --- COMANDO START ---
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const nombre = msg.from.first_name || "oyente";

        const bienvenida = `¡Hola ${nombre}! 👋 Bienvenido a **La Fronterísima**, la radio del futuro.\n\n` +
            `Soy **Salomé**, tu locutora IA. Puedes enviarme fotos de lo que estás haciendo, notas de voz o pedir canciones.\n\n` +
            `⚠️ **Aviso Importante:** Al enviar tu foto o audio, autorizas a La Fronterísima para comentarlos al aire mediante nuestra locutora virtual Salomé. ¡Gracias por ser parte del show! 🎙️✨`;

        bot.sendMessage(chatId, bienvenida, { parse_mode: 'Markdown' });
    });

    // --- COMANDO PEDIR ---
    bot.onText(/\/pedir (.+)/, async (msg, match) => {
        const busqueda = match[1].trim();
        const track = await buscarMusicaJamendo(busqueda, true);
        if (track) {
            await reproducirTrackDirecto(track);
            ultimoSaludo = {
                nombre: msg.from.first_name || "un oyente",
                texto: `pidió la canción: ${busqueda}`,
                fecha: new Date(),
                esPedido: true,
                ubicacion: ""
            };
            bot.sendMessage(msg.chat.id, "✅ ¡Reproduciendo ahora!");
        } else {
            bot.sendMessage(msg.chat.id, "❌ No encontré esa canción.");
        }
    });

    // --- AUDIOS DE VOZ ---
    bot.on('voice', async (msg) => {
        const chatId = msg.chat.id;
        const nombreOyente = msg.from.first_name || "oyente";

        bot.sendMessage(chatId, "🎧 Salomé está escuchando tu audio...");

        const tempVoice = path.join(__dirname, `v_${Date.now()}.ogg`);
        const respuestaVozPath = path.join(__dirname, `res_${Date.now()}.mp3`);

        try {
            const fileUrl = await bot.getFileLink(msg.voice.file_id);
            const response = await axios({ url: fileUrl, method: 'GET', responseType: 'stream' });
            const writer = fs.createWriteStream(tempVoice);
            response.data.pipe(writer);

            writer.on('error', (err) => {
                console.error("Error escribiendo archivo de voz:", err);
                bot.sendMessage(chatId, "❌ Hubo un problema con tu audio. Intenta de nuevo.");
            });

            writer.on('finish', async () => {
                try {
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
                                content: "Eres Salomé, la locutora estrella de la radio La Fronterísima. Responde de forma muy breve (máximo 20 palabras), con mucha alegría, sabor rumbero y chispa colombiana. Si te piden una canción, di que ya la buscas. Si es un saludo, agradécelo con cariño."
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

                    // Enviar la respuesta de Salomé directamente al stream
                    await reproducirEnStream(respuestaVozPath, true);

                    if (esMusical) {
                        const busqueda = textoMinusculas.replace(/ponme|pon|quiero escuchar|la canción|por favor|suéltate/g, "").trim();
                        bot.sendMessage(chatId, `🎶 ¡Oído! Buscando: "${busqueda}" para ponerla al aire...`);
                        const track = await buscarMusicaJamendo(busqueda, true);
                        if (track) await reproducirTrackDirecto(track);
                    }

                } catch (err) {
                    console.error("Error en el proceso de Salomé:", err);
                    bot.sendMessage(chatId, "¡Uy! Se me entrecortó la voz. ¿Me repites?");
                } finally {
                    setTimeout(() => {
                        if (fs.existsSync(tempVoice)) fs.unlinkSync(tempVoice);
                        if (fs.existsSync(respuestaVozPath)) fs.unlinkSync(respuestaVozPath);
                    }, 5000);
                }
            });
        } catch (e) {
            console.error("Error General Voz:", e);
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
                        content: "Eres Salomé, locutora de La Fronterísima. Tu tarea es describir con alegría y sabor rumbero la foto que te envió un oyente. Sé cercana, menciona detalles de lo que ves (objetos, clima, ropa, comida) y asume que están escuchando la radio."
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: `Esta foto la envió ${nombreOyente}. Coméntala en máximo 300 caracteres.` },
                            { type: "image_url", image_url: { url: fileUrl } }
                        ],
                    },
                ],
            });

            const guionVisual = response.choices[0].message.content;
            const pathVoz = path.join(__dirname, `v_foto_${Date.now()}.mp3`);

            await generarVoz(guionVisual, pathVoz);
            await reproducirEnStream(pathVoz, true);

            bot.sendMessage(chatId, `📸 ¡Salomé ya vio tu foto! Escúchala en un momento al aire por La Fronterísima.`);
            console.log(`👁️ Salomé comentó la foto de ${nombreOyente}`);

        } catch (e) {
            console.error("Error en visión de Salomé:", e);
            bot.sendMessage(chatId, "¡Uy! Me distraje un segundo. Envía la foto de nuevo.");
        }
    });

    // --- MENSAJES DE TEXTO ---
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;
        ultimoSaludo = {
            nombre: msg.from.first_name || "un oyente",
            texto: msg.text,
            fecha: new Date(),
            esPedido: false,
            ubicacion: ""
        };
        bot.sendMessage(msg.chat.id, "📻 ¡Recibido! Tu saludo va para el aire.");
    });
}

// ======= 3. FUNCIONES DE MÚSICA =======

async function buscarMusicaJamendo(query, esBusquedaEspecifica = false) {
    const generos = ['salsa', 'reggaeton', 'bachata', 'vallenato'];
    let parametro = esBusquedaEspecifica
        ? `search=${encodeURIComponent(query)}`
        : `fuzzytags=${generos[Math.floor(Math.random() * generos.length)]}&order=ratingdesc`;
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&durationbetween=120_600&${parametro}`;
    try {
        const res = await axios.get(url, { timeout: 8000 });
        if (res.data.results?.length > 0) {
            const t = res.data.results[0];
            return { url: t.audio, info: `${t.name} de ${t.artist_name}` };
        }
    } catch (e) {
        return null;
    }
    return null;
}

async function reproducirTrackDirecto(track) {
    const tempFile = path.join(__dirname, `track_${Date.now()}.mp3`);
    try {
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);

        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log(`🎵 Reproduciendo: ${track.info}`);
        await reproducirEnStream(tempFile, false);
    } catch (e) {
        console.error("Error descargando/reproduciendo track:", e.message);
    } finally {
        setTimeout(() => {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        }, 3000);
    }
}

// ======= 4. IA Y VOZ =======

function limpiarTexto(t) {
    if (!t) return "";
    return t.replace(/[*#_~]/g, '').replace(/Soy Lupe|Lupe de La Fronterísima|Locutora:|Lupe:/gi, '').trim();
}

async function redactarIA(prompt) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Eres Salome, locutora de La Fronterisima. Alegre y carismática. Máximo 350 caracteres. Solo texto plano." },
                { role: "user", content: prompt }
            ],
            max_tokens: 400
        });
        return limpiarTexto(response.choices[0].message.content);
    } catch (e) {
        return "Notas surcando fronteras, quédate con nosotros.";
    }
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
        console.error("❌ Error TTS:", e.message);
        throw e;
    }
}

// ======= 5. STREAM PERSISTENTE A ICECAST =======

/**
 * Genera un MP3 de silencio de 2 segundos y lo guarda en memoria.
 * Se usará en bucle para mantener la conexión viva cuando no hay audio.
 */
async function generarBufferDeSilencio() {
    const tempFile = path.join(__dirname, `silence_${Date.now()}.mp3`);
    return new Promise((resolve) => {
        const cmd = `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 2 -c:a libmp3lame -b:a 128k ${tempFile}`;
        exec(cmd, (err) => {
            if (err) {
                console.error("❌ Error generando silencio:", err.message);
                return resolve(null);
            }
            try {
                silenceBuffer = fs.readFileSync(tempFile);
                fs.unlinkSync(tempFile);
                console.log(`🔇 Buffer de silencio generado (${silenceBuffer.length} bytes)`);
                resolve(silenceBuffer);
            } catch (e) {
                resolve(null);
            }
        });
    });
}

/**
 * Inicia FFmpeg persistente conectado a IceCast, leyendo MP3 desde stdin.
 */
function iniciarStreamContinuo() {
    if (shutdown) return;
    if (ffmpegProcess && !ffmpegProcess.killed) return;

    console.log(`📡 Conectando a IceCast: ${ICECAST.host}:${ICECAST.port}${ICECAST.mount}`);

    ffmpegProcess = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'warning',
        '-f', 'mp3',
        '-i', 'pipe:0',
        '-c:a', 'copy',
        '-f', 'mp3',
        '-content_type', 'audio/mpeg',
        ICECAST_URL
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    ffmpegProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes('size=')) {
            console.log(`[FFmpeg] ${msg}`);
        }
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`⚠️ FFmpeg cerró (código ${code}). Reconectando en 3s...`);
        ffmpegProcess = null;
        if (!shutdown) {
            setTimeout(iniciarStreamContinuo, 3000);
        }
    });

    ffmpegProcess.on('error', (err) => {
        console.error("❌ Error en FFmpeg:", err.message);
    });

    // Arrancar el loop que escribe silencio si no hay audio real
    if (!writeLoopRunning) {
        writeLoopRunning = true;
        escribirLoopSilencio();
    }
}

/**
 * Loop que escribe silencio continuamente cuando no hay audio real reproduciéndose.
 */
async function escribirLoopSilencio() {
    while (!shutdown) {
        if (!ffmpegProcess || ffmpegProcess.killed) {
            await new Promise(r => setTimeout(r, 500));
            continue;
        }

        if (!isPlayingAudio && silenceBuffer && ffmpegProcess.stdin.writable) {
            try {
                ffmpegProcess.stdin.write(silenceBuffer);
            } catch (e) {
                // stdin cerrado, esperar reconexión
            }
        }

        // Pausa corta para no saturar el buffer de stdin
        await new Promise(r => setTimeout(r, 1000));
    }
}

/**
 * Reproduce un archivo MP3 directamente en el stream de IceCast.
 * Pausa el envío de silencio, envía el archivo completo, y reanuda el silencio.
 */
async function reproducirEnStream(archivoAudio, conFondo = false) {
    if (!fs.existsSync(archivoAudio)) {
        console.error(`❌ Archivo no existe: ${archivoAudio}`);
        return false;
    }
    if (!ffmpegProcess || ffmpegProcess.killed) {
        console.error("❌ FFmpeg no está conectado a IceCast.");
        return false;
    }

    // Asegurar que el archivo esté listo
    const buffer = fs.readFileSync(archivoAudio);
    if (buffer.length === 0) {
        console.error("❌ Archivo de audio vacío.");
        return false;
    }

    isPlayingAudio = true;

    try {
        // Si se pide con fondo, mezclamos primero con FFmpeg localmente
        let bufferFinal = buffer;
        if (conFondo && fs.existsSync("fondo.mp3")) {
            bufferFinal = await mezclarConFondo(archivoAudio);
        }

        // Enviar el buffer al stream (bloque a bloque para no saturar stdin)
        const CHUNK = 32 * 1024;
        for (let i = 0; i < bufferFinal.length; i += CHUNK) {
            if (!ffmpegProcess || ffmpegProcess.killed) break;
            const chunk = bufferFinal.subarray(i, i + CHUNK);
            if (!ffmpegProcess.stdin.writable) break;
            ffmpegProcess.stdin.write(chunk);
            // Pequeña pausa para dar tiempo al buffer
            await new Promise(r => setTimeout(r, 5));
        }

        console.log(`✅ Audio enviado al stream (${bufferFinal.length} bytes)`);
        return true;
    } catch (e) {
        console.error("❌ Error enviando audio al stream:", e.message);
        return false;
    } finally {
        isPlayingAudio = false;
    }
}

/**
 * Mezcla un archivo de audio con fondo.mp3 usando FFmpeg local.
 * Devuelve el buffer del resultado mezclado.
 */
async function mezclarConFondo(archivoVoz) {
    const tempSalida = path.join(__dirname, `mix_${Date.now()}.mp3`);
    const cmd = `ffmpeg -y -i "fondo.mp3" -i "${archivoVoz}" ` +
        `-filter_complex "[0:a]volume=0.10[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" ` +
        `-c:a libmp3lame -b:a 128k "${tempSalida}"`;

    await new Promise((resolve) => {
        exec(cmd, (err) => {
            if (err) console.error("Error mezclando con fondo:", err.message);
            resolve();
        });
    });

    if (!fs.existsSync(tempSalida)) return fs.readFileSync(archivoVoz);

    const buffer = fs.readFileSync(tempSalida);
    fs.unlinkSync(tempSalida);
    return buffer;
}

/**
 * Detiene el proceso FFmpeg y limpia recursos.
 */
function detenerStream() {
    shutdown = true;
    if (ffmpegProcess && !ffmpegProcess.killed) {
        try { ffmpegProcess.stdin.end(); } catch (e) {}
        try { ffmpegProcess.kill('SIGTERM'); } catch (e) {}
    }
    ffmpegProcess = null;
}

// ======= 6. AUTOMATIZACIÓN =======

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=4.6097&longitude=-74.0817&current_weather=true");
        const hora = new Date().toLocaleTimeString("es-CO", {
            timeZone: "America/Bogota",
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });

        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            const loc = ultimoSaludo.ubicacion ? ` en ${ultimoSaludo.ubicacion}` : "";
            const prefijo = ultimoSaludo.esPedido ? "PEDIDO MUSICAL de" : "SALUDO de";
            extras += ` ${prefijo} ${ultimoSaludo.nombre}${loc}: "${ultimoSaludo.texto}".`;
        }

        const prompt = `Eres Salomé locutora virtual. Hora: ${hora}. Clima: ${Math.round(clim.data.current_weather.temperature)}°C. ${extras} Redacta un guion alegre de unos 100 caracteres.`;

        const guion = await redactarIA(prompt);
        const pathVoz = path.join(__dirname, `v_auto_${Date.now()}.mp3`);

        await generarVoz(guion, pathVoz);
        await reproducirEnStream(pathVoz, true);

        setTimeout(() => {
            if (fs.existsSync(pathVoz)) fs.unlinkSync(pathVoz);
        }, 5000);

        ultimoSaludo.fecha = null;
    } catch (e) {
        console.error("Error AutoReporte:", e.message);
    }
}

async function autoRedactorIA() {
    try {
        const prompt = `Un mensaje rumbero positivo, dato musical o efeméride. Termina: Notas surcando fronteras. Máximo 300 caracteres.`;
        const guion = await redactarIA(prompt);
        const pathVoz = path.join(__dirname, `v_red_${Date.now()}.mp3`);

        await generarVoz(guion, pathVoz);
        await reproducirEnStream(pathVoz, true);

        setTimeout(() => {
            if (fs.existsSync(pathVoz)) fs.unlinkSync(pathVoz);
        }, 5000);
    } catch (e) {
        console.error("Error Redactor:", e.message);
    }
}

// ======= 7. RUTAS API =======

app.get('/oyente-conectado', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cleanIp = ip.split(',')[0];

    try {
        const geo = await axios.get(`http://ip-api.com/json/${cleanIp}?fields=city,country`);
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
    } catch (e) {
        console.error("Error Geo:", e.message);
    }
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
        await reproducirEnStream(pathVoz, !!conFondo);
        res.send("OK");
    } catch (e) {
        console.error("Error /procesar-locucion:", e);
        res.status(500).send("Error");
    } finally {
        setTimeout(() => {
            if (fs.existsSync(pathVoz)) fs.unlinkSync(pathVoz);
        }, 5000);
    }
});

app.post("/redactar-guion", async (req, res) => {
    try {
        const { idea } = req.body;
        const guion = await redactarIA(`Genera un guion rumbero sobre: ${idea}. Máximo 350 caracteres.`);
        res.json({ guion });
    } catch (e) {
        res.status(500).json({ error: "Error de IA" });
    }
});

app.get("/health", (req, res) => res.sendStatus(200));

// ======= 8. INICIO =======

const PORT = process.env.PORT || 8000;

async function iniciar() {
    console.log("🚀 Iniciando La Fronterísima...");

    // 1. Generar buffer de silencio
    const buffer = await generarBufferDeSilencio();
    if (!buffer) {
        console.error("❌ No se pudo generar el buffer de silencio. FFmpeg está instalado?");
    }

    // 2. Iniciar conexión persistente a IceCast
    iniciarStreamContinuo();

    // 3. Levantar servidor HTTP
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`✅ Servidor HTTP en puerto ${PORT}`);
        console.log(`📻 IceCast: ${ICECAST.host}:${ICECAST.port}${ICECAST.mount}`);

        // 4. Tareas automáticas
        setTimeout(autoReporte, 5000);
        setTimeout(autoRedactorIA, 20000);
        setInterval(autoReporte, 15 * 60 * 1000);
        setInterval(autoRedactorIA, 50 * 60 * 1000);
    });
}

// Manejo de cierre limpio
process.on('SIGTERM', () => {
    console.log("🛑 Cerrando...");
    detenerStream();
    process.exit(0);
});
process.on('SIGINT', () => {
    console.log("🛑 Cerrando...");
    detenerStream();
    process.exit(0);
});

iniciar();
