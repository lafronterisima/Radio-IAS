

require('dotenv').config();
const cors = require('cors');
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require("openai");
const googleTTS = require("google-tts-api"); 

const app = express();
app.use(express.json());

app.use(cors({
    origin: 'https://lafronterisima.stream'
}));

// Configuración para Northflank: Confía en el proxy para obtener la IP real del oyente
app.use(cors());
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN =======
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

// Objeto de saludo extendido con ubicación
let ultimoSaludo = { nombre: "", texto: "", fecha: null, esPedido: false, ubicacion: "" };

if (bot) {
    console.log("🎙️ Bot de Telegram: Conectado.");

    bot.on('polling_error', (err) => {
        if (err.code === 'EFATAL') console.error("❌ Error Crítico de Telegram.");
    });

    // --- NUEVO: COMANDO START CON AVISO LEGAL ---
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const nombre = msg.from.first_name || "oyente";
        
        const bienvenida = `¡Hola ${nombre}! 👋 Bienvenido a **La Fronterísima**, la radio del futuro.\n\n` +
            `Soy **Salomé**, tu locutora IA. Puedes enviarme fotos de lo que estás haciendo, notas de voz o pedir canciones.\n\n` +
            `⚠️ **Aviso Importante:** Al enviar tu foto o audio, autorizas a La Fronterísima para comentarlos al aire mediante nuestra locutora virtual Salomé. ¡Gracias por ser parte del show! 🎙️✨`;

        bot.sendMessage(chatId, bienvenida, { parse_mode: 'Markdown' });
    });

    bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    const nombreOyente = msg.from.first_name || "oyente";
    
    // 1. Avisamos que estamos procesando
    bot.sendMessage(chatId, "🎧 Salomé está escuchando tu audio...");
    
    const tempVoice = path.join(__dirname, `v_${Date.now()}.ogg`);
    const respuestaVozPath = path.join(__dirname, `res_${Date.now()}.mp3`);

    try {
        // 2. Descargar el audio de Telegram
        const fileUrl = await bot.getFileLink(msg.voice.file_id);
        const response = await axios({ url: fileUrl, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempVoice);
        response.data.pipe(writer);

        writer.on('finish', async () => {
            try {
                // 3. Transcribir con Whisper
                const transcription = await openai.audio.transcriptions.create({
                    file: fs.createReadStream(tempVoice),
                    model: "whisper-1",
                    language: "es"
                });

                const textoEscuchado = transcription.text;
                const textoMinusculas = textoEscuchado.toLowerCase();
                
                // 4. Lógica de pedido musical
                const disparadores = ["ponme", "pon", "quiero escuchar", "suena", "suéltate"];
                const esMusical = disparadores.some(d => textoMinusculas.includes(d));
                
                ultimoSaludo = {
                    nombre: nombreOyente,
                    texto: textoEscuchado,
                    fecha: new Date(),
                    esPedido: esMusical,
                    ubicacion: ""
                };

                // 5. Salomé genera una respuesta textual basada en lo que escuchó
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

                // 6. Convertir la respuesta de Salomé a audio
                await generarVoz(respuestaTexto, respuestaVozPath);

                // 7. Enviar la respuesta de voz al oyente por Telegram
                await bot.sendVoice(chatId, respuestaVozPath, { 
                    caption: `🎙️ **Salomé te respondió:**\n"${respuestaTexto}"`,
                    parse_mode: 'Markdown'
                });

                // 8. Si es música, procesar el pedido para la radio
                if (esMusical) {
                    const busqueda = textoMinusculas.replace(/ponme|pon|quiero escuchar|la canción|por favor|suéltate/g, "").trim();
                    bot.sendMessage(chatId, `🎶 ¡Oído! Buscando: "${busqueda}" para ponerla al aire...`);
                    const track = await buscarMusicaJamendo(busqueda, true);
                    if (track) await descargarYSubirAzura(track);
                }

            } catch (err) { 
                console.error("Error en el proceso de Salomé:", err);
                bot.sendMessage(chatId, "¡Uy! Se me entrecortó la voz. ¿Me repites?");
            } finally { 
                // Limpieza de archivos temporales
                setTimeout(() => {
                    if (fs.existsSync(tempVoice)) fs.unlinkSync(tempVoice);
                    if (fs.existsSync(respuestaVozPath)) fs.unlinkSync(respuestaVozPath);
                }, 5000); // Esperamos 5 segundos para asegurar que el archivo se envió
            }
        });
    } catch (e) { 
        console.error("Error General Voz:", e); 
    }
});

    // ======= FUNCIÓN PARA QUE SALOMÉ "VEA" FOTOS =======
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const nombreOyente = msg.from.first_name || "oyente";
    
    // Tomamos la versión de mayor resolución de la foto
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    
    try {
        const fileUrl = await bot.getFileLink(fileId);
        
        // 1. Salomé analiza la imagen usando GPT-4o
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
        const pathVoz = `v_foto_${Date.now()}.mp3`;

        // 2. Generamos el audio y lo subimos como una "intervención especial"
        await generarVoz(guionVisual, pathVoz);
        
        // Lo subimos con un nombre específico para que AzuraCast lo identifique
        await producirYSubir(pathVoz, "Saludo_Foto.mp3", true);

        bot.sendMessage(chatId, `📸 ¡Salomé ya vio tu foto! Escúchala en un momento al aire por La Fronterísima.`);
        console.log(`👁️ Salomé comentó la foto de ${nombreOyente}`);

    } catch (e) {
        console.error("Error en visión de Salomé:", e);
        bot.sendMessage(chatId, "¡Uy! Me distraje un segundo. Envía la foto de nuevo.");
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
                    bot.sendMessage(msg.chat.id, "✅ ¡Programada! En breve suena.");
                }
            }
            return;
        }
        ultimoSaludo = { nombre: msg.from.first_name || "un oyente", texto: msg.text, fecha: new Date(), esPedido: false, ubicacion: "" };
        bot.sendMessage(msg.chat.id, "📻 ¡Recibido! Tu saludo va para el aire.");
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
    // 1. CAMBIO CRÍTICO: Usamos un timestamp para que el archivo sea único. 
    // Esto obliga a AzuraCast a procesarlo como algo nuevo de inmediato.
    const uniqueID = Date.now();
    const fileName = `estreno_${uniqueID}.mp3`;
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

                    // Subida del archivo
                    await axios.post(AZURA_API_UPLOAD, form, { 
                        headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
                        timeout: 60000 
                    });

                    // 2. SOLICITUD DE REPRODUCCIÓN:
                    // Enviamos el request. Al ser un archivo nuevo, Azura lo pone al inicio de la cola.
                    await axios.post(`${AZURA_BASE}/request/${encodeURIComponent(filePath)}`, {}, {
                        headers: { "X-API-Key": KEYS.AZURA }
                    });

                    console.log(`✅ Solicitud enviada: ${fileName}`);

                    if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                    resolve(true);
                } catch (err) { 
                    console.error("Error en la subida/request:", err.message);
                    resolve(false); 
                }
            });
        });
    } catch (e) { 
        console.error("Error descargando track:", e.message);
        return false; 
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
    return t.replace(/[*#_~]/g, '').replace(/Soy Lupe|Lupe de La Fronterísima|Locutora:|Lupe:/gi, '').trim();
}

// ======= 4. IA Y VOZ =======

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
    } catch (e) { return "Notas surcando fronteras, quédate con nosotros."; }
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
    } catch (e) { console.error("❌ Error TTS:", e.message); throw e; }
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    if (!fs.existsSync(archivoVoz) || fs.statSync(archivoVoz).size === 0) return;
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondo = "fondo.mp3";
    let cmd = (conFondo && fs.existsSync(fondo))
    ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.10[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
    : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;
    return new Promise((resolve) => {
        exec(cmd, async (error) => {
            if (error) { console.error("FFmpeg Error:", error); return resolve(); }
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

// ======= 5. AUTOMATIZACIÓN =======

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=4.6097&longitude=-74.0817&current_weather=true");
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            const loc = ultimoSaludo.ubicacion ? ` en ${ultimoSaludo.ubicacion}` : "";
            const prefijo = ultimoSaludo.esPedido ? "PEDIDO MUSICAL de" : "SALUDO de";
            extras += ` ${prefijo} ${ultimoSaludo.nombre}${loc}: "${ultimoSaludo.texto}".`;
        }

        const prompt = `Eres Salomé locutora virtual. Hora: ${hora}. suena: ${np.titulo}. Clima: ${Math.round(clim.data.current_weather.temperature)}°C. ${extras} Redacta un guion alegre de unos 100 caracteres.`;
          
        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true); 
        ultimoSaludo.fecha = null; 
    } catch (e) { console.error("Error AutoReporte:", e.message); }
}

async function autoRedactorIA() {
    try {
        const prompt = `Un mensaje rumbero positivo, dato musical o efeméride. Termina: Notas surcando fronteras. Máximo 300 caracteres.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_red_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
    } catch (e) { console.error("Error Redactor:", e.message); }
}

// ======= 6. RUTAS API (NORTHFLANK) =======

app.get('/oyente-conectado', async (req, res) => {
    // Northflank envía la IP real en x-forwarded-for
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
    } catch (e) { console.error("Error Geo:", e.message); }
    res.send("Sintonizado");
});

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.post("/procesar-locucion", async (req, res) => {
    const pathVoz = `v_man_${Date.now()}.mp3`;
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

// ======= 7. INICIO =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima ONLINE en puerto ${PORT}`);
    setTimeout(autoReporte, 5000);
    setTimeout(autoRedactorIA, 20000); 
    setInterval(autoReporte, 15 * 60 * 1000);
    setInterval(autoRedactorIA, 50 * 60 * 1000);
});
