 
require('dotenv').config();
const cors = require('cors');
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require("openai");
const MSTTS = require("ms-tts");

const app = express();
const msTts = new MSTTS();

// ======= 1. MIDDLEWARES & CONFIGURACIÓN =======
app.use(express.json());
app.set('trust proxy', true);
app.use(cors({ origin: 'https://lafronterisima.stream' }));
app.use(express.static(path.join(__dirname, "public")));

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

const AZURA_BASE = `https://virtual5.emisorasvirtuales.com/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

const openai = new OpenAI({ apiKey: KEYS.OPENAI });    

// ======= 2. TELEGRAM (SALUDOS Y PEDIDOS) =======
const bot = KEYS.TELEGRAM_TOKEN ? new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true }) : null;
let ultimoSaludo = { nombre: "", texto: "", fecha: null, esPedido: false, ubicacion: "" };

if (bot) {
    console.log("🎙️ Bot de Telegram: Conectado y en modo Autogenerativo.");

    bot.on('polling_error', (err) => {
        if (err.code === 'EFATAL') console.error("❌ Error Crítico de Telegram.");
    });

    // Procesamiento de Notas de Voz
    bot.on('voice', async (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, "📻 Lupe está escuchando tu audio para ponerlo al aire...");
        const tempVoice = path.join(__dirname, `v_${crypto.randomUUID()}.ogg`);

        try {
            const fileUrl = await bot.getFileLink(msg.voice.file_id);
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
                    const esMusical = textoEscuchado.includes("ponme") || textoEscuchado.includes("pon") || textoEscuchado.includes("quiero escuchar");
                    
                    ultimoSaludo = {
                        nombre: msg.from.first_name || "un oyente",
                        texto: transcription.text,
                        fecha: new Date(),
                        esPedido: esMusical,
                        ubicacion: ""
                    };

                    if (esMusical) {
                        const busqueda = textoEscuchado.replace(/ponme|pon|quiero escuchar|la canción|por favor/g, "").trim();
                        bot.sendMessage(chatId, `🎵 ¡Oído! Buscando: "${busqueda}"...`);
                        const track = await buscarMusicaJamendo(busqueda, true);
                        if (track) await descargarYSubirAzura(track);
                    }
                    bot.sendMessage(chatId, `✅ ¡Entendido! Tu mensaje se procesó para la transmisión.`);
                } catch (err) { console.error("Error Whisper:", err); }
                finally { if (fs.existsSync(tempVoice)) fs.unlinkSync(tempVoice); }
            });
        } catch (e) { console.error("Error Voz:", e); }
    });

    // Procesamiento de Fotos (Salomé Visión)
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
                        content: "Eres Salomé, locutora de La Fronterísima. Describe con ambiente rumbero y cálido la foto de un oyente. Máximo 300 caracteres."
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: `Esta foto la envió ${nombreOyente}. Coméntala brevemente:` },
                            { type: "image_url", image_url: { url: fileUrl } }
                        ],
                    },
                ],
            });

            const guionVisual = response.choices[0].message.content;
            const pathVoz = `v_foto_${crypto.randomUUID()}.mp3`;

            await generarVoz(guionVisual, pathVoz);
            await producirYSubir(pathVoz, "Saludo_Foto.mp3", true);

            bot.sendMessage(chatId, `📸 ¡Salomé ya procesó tu foto! Pronto saldrá al aire.`);
        } catch (e) {
            console.error("Error en visión:", e);
            bot.sendMessage(chatId, "¡Uy! Ocurrió un inconveniente. Intenta enviar la foto nuevamente.");
        }
    });
    
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) {
            if(msg.text?.startsWith('/pedir')){
                const busqueda = msg.text.replace('/pedir ', '').trim();
                const track = await buscarMusicaJamendo(busqueda, true);
                if (track) {
                    await descargarYSubirAzura(track);
                    ultimoSaludo = { 
                        nombre: msg.from.first_name || "un oyente", 
                        texto: `pidió la canción: ${busqueda}`, 
                        fecha: new Date(),
                        esPedido: true,
                        ubicacion: ""
                    };
                    bot.sendMessage(msg.chat.id, "✅ ¡Canción cargada al sistema automático!");
                }
            }
            return;
        }
        ultimoSaludo = { nombre: msg.from.first_name || "un oyente", texto: msg.text, fecha: new Date(), esPedido: false, ubicacion: "" };
        bot.sendMessage(msg.chat.id, "💬 ¡Recibido! Quedó en cola para la próxima locución.");
    });
}

// ======= 3. FUNCIONES AUXILIARES Y AZURACAST =======

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
    const tempFile = path.join(__dirname, `tmp_${crypto.randomUUID()}.mp3`);
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
                    await axios.post(AZURA_API_UPLOAD, form, { 
                        headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
                        timeout: 60000 
                    });
                    await axios.post(`${AZURA_BASE}/request/${encodeURIComponent(filePath)}`, {}, {
                        headers: { "X-API-Key": KEYS.AZURA }
                    });
                    resolve(true);
                } catch (err) { resolve(false); } 
                finally { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); }
            });
            writer.on('error', () => {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                resolve(false);
            });
        });
    } catch (e) { return false; }
}

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "Artistas Varios", titulo: "Éxitos de La Fronterísima" };
    } catch (e) { return { artista: "Artistas Varios", titulo: "Sabor Rumbero" }; }
}

function limpiarTexto(t) {
    if (!t) return "";
    return t.replace(/[*#_~]/g, '').replace(/Soy Lupe|Lupe de La Fronterísima|Locutora:|Lupe:/gi, '').trim();
}

// ======= 4. MOTOR IA Y GENERACIÓN DE AUDIO =======

async function redactarIA(prompt) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Eres Lupe, la voz oficial autogenerativa de La Fronterísima. Hablas con soltura, alegría y sabor colombiano. Máximo 320 caracteres. Texto plano únicamente." },
                { role: "user", content: prompt }
            ],
            max_tokens: 350 
        });
        return limpiarTexto(response.choices[0].message.content);
    } catch (e) { return "Sintonizas La Fronterísima, la emisora que suena sin interrupciones."; }
}

async function generarVoz(texto, archivoDestino) {
    try {
        await msTts.setVoice("es-CO-SalmeNeural");
        const buffer = await msTts.getAudio(texto);
        fs.writeFileSync(archivoDestino, buffer);
    } catch (e) { 
        console.error("❌ Error MS-TTS:", e.message); 
        throw e; 
    }
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    if (!fs.existsSync(archivoVoz) || fs.statSync(archivoVoz).size === 0) return;
    const tempSalida = `prod_${crypto.randomUUID()}.mp3`;
    const fondo = "fondo.mp3";
    let cmd = (conFondo && fs.existsSync(fondo))
    ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.10[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
    : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;
    
    return new Promise((resolve) => {
        exec(cmd, async (error) => {
            if (error) { 
                console.error("FFmpeg Error:", error); 
                if (fs.existsSync(archivoVoz)) fs.unlinkSync(archivoVoz);
                return resolve(); 
            }
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                form.append('path', nombreFinal);
                await axios.post(AZURA_API_UPLOAD, form, { 
                    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, 
                    timeout: 60000 
                });
                console.log(`📡 Archivo autogenerado subido con éxito: ${nombreFinal}`);
            } catch (e) { 
                console.error("Error subiendo a AzuraCast:", e.message);
            } finally {
                [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                resolve();
            }
        });
    });
}

// ======= 5. MÓDULOS DE AUTOGENERACIÓN =======

// A. Hora, Clima e Interacción con Oyentes
async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.4372&longitude=-76.5225&current_weather=true");
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            const loc = ultimoSaludo.ubicacion ? ` en ${ultimoSaludo.ubicacion}` : "";
            const prefijo = ultimoSaludo.esPedido ? "PEDIDO MUSICAL de" : "SALUDO de";
            extras += ` ${prefijo} ${ultimoSaludo.nombre}${loc}: "${ultimoSaludo.texto}".`;
        }

        const prompt = `Intervención de radio. Hora actual: ${hora}. Canción sonar/sonando: "${np.titulo}" de ${np.artista}. Clima actual: ${Math.round(clim.data.current_weather.temperature)}°C. ${extras} Redacta una locución enérgica dando la hora y el reporte.`;
        
        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${crypto.randomUUID()}.mp3`;
        
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true); 
        ultimoSaludo.fecha = null; 
    } catch (e) { console.error("Error AutoReporte:", e.message); }
}

// B. Comentario sobre el tema actual (Intro de canción)
async function autoComentarioCancion() {
    try {
        const np = await obtenerAhoraSuena();
        const prompt = `Crea una presentación corta de radio (máximo 250 caracteres) para anunciar la canción "${np.titulo}" del artista "${np.artista}". Añade un dato curioso o frase carismática sobre este género musical.`;
        
        const guion = await redactarIA(prompt);
        const pathVoz = `v_track_${crypto.randomUUID()}.mp3`;
        
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "intro_cancion.mp3", true);
    } catch (e) { console.error("Error AutoComentario:", e.message); }
}

// C. Promos, Efemérides y Cultura
async function autoRedactorIA() {
    try {
        const prompt = `Escribe un mensaje de radio alegre y rumbero sobre cultura, sabor latino o una frase motivacional. Finaliza obligatoriamente diciendo: "Notas surcando fronteras". Máximo 300 caracteres.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_red_${crypto.randomUUID()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
    } catch (e) { console.error("Error Redactor:", e.message); }
}

// ======= 6. RUTAS API (NORTHFLANK) =======

app.get('/oyente-conectado', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cleanIp = ip.split(',')[0]; 

    try {
        const geo = await axios.get(`https://ip-api.com/json/${cleanIp}?fields=city,country`);
        if (geo.data && geo.data.city) {
            ultimoSaludo = {
                nombre: "un oyente",
                texto: "se acaba de conectar a la transmisión",
                ubicacion: geo.data.city,
                fecha: new Date(),
                esPedido: false
            };
            console.log(`📌 Nuevo oyente conectado desde: ${geo.data.city}`);
        }
    } catch (e) { console.error("Error Geo:", e.message); }
    res.send("Sintonizado");
});

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.post("/procesar-locucion", async (req, res) => {
    const pathVoz = `v_man_${crypto.randomUUID()}.mp3`;
    const { texto, conFondo, nombre } = req.body;
    let nombreFinal = nombre ? nombre.trim().replace(/\s+/g, '_') : "Redactor_ia";
    if (!nombreFinal.endsWith(".mp3")) nombreFinal += ".mp3";
    try {
        await generarVoz(texto, pathVoz);
        await producirYSubir(pathVoz, nombreFinal, conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

app.post("/redactar-guion", async (req, res) => {
    try {
        const { idea } = req.body;
        const guion = await redactarIA(`Genera un guion rumbero sobre: ${idea}. Máximo 350 caracteres.`);
        res.json({ guion });
    } catch (e) { res.status(500).json({ error: "Error de IA" }); }
});

app.get("/health", (req, res) => res.sendStatus(200));

// ======= 7. INICIO Y PROGRAMADOR AUTOMÁTICO (SCHEDULER) =======

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Autogenerativa ONLINE en el puerto ${PORT}`);
    
    // Ejecuciones iniciales al arrancar la app
    setTimeout(autoReporte, 5000);
    setTimeout(autoComentarioCancion, 15000);
    setTimeout(autoRedactorIA, 30000); 

    // Bucle continuo de autogeneración (Timers intercalados)
    setInterval(autoReporte, 12 * 60 * 1000);           // Cada 12 min (Hora, clima, oyente)
    setInterval(autoComentarioCancion, 22 * 60 * 1000);  // Cada 22 min (Intro a la canción en emisión)
    setInterval(autoRedactorIA, 45 * 60 * 1000);         // Cada 45 min (Mensaje cultural / Identificador)
});
