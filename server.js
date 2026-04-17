require('dotenv').config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
const { OpenAI } = require("openai");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = {
    OPENAI: safeTrim(process.env.OPENAI_API_KEY),
    AWS_ID: safeTrim(process.env.AWS_ACCESS_KEY_ID),
    AWS_SECRET: safeTrim(process.env.AWS_SECRET_ACCESS_KEY),
    AWS_REGION: safeTrim(process.env.AWS_REGION || "us-east-1"),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    JAMENDO_ID: safeTrim(process.env.JAMENDO_CLIENT_ID) || "c230e1f4"
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

const openai = new OpenAI({ apiKey: KEYS.OPENAI });
const polly = new PollyClient({
    region: KEYS.AWS_REGION,
    credentials: { accessKeyId: KEYS.AWS_ID, secretAccessKey: KEYS.AWS_SECRET }
});


// ======= 2. TELEGRAM (AUDIO, TEXTO Y PEDIDOS) =======

// Inicialización segura: Si no hay token, el bot no intenta arrancar (evita el error EFATAL)
const bot = KEYS.TELEGRAM_TOKEN 
    ? new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true }) 
    : null;

let ultimoSaludo = { nombre: "", texto: "", fecha: null };

if (bot) {
    console.log("✅ Bot de Telegram: Conectado y escuchando a los oyentes.");

    // Manejo de errores de conexión para que el servidor no se caiga
    bot.on('polling_error', (err) => {
        if (err.code === 'EFATAL') {
            console.error("❌ Error Crítico de Telegram: Revisa que el TOKEN sea correcto.");
        }
    });

    // --- Manejo de Notas de Voz (Transcripción Whisper) ---
    bot.on('voice', async (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, "🎤 Lupe está escuchando tu audio... dame un momento.");
        
        // Usamos prefijo v_ para coincidir con tu .gitignore
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

        // --- LÓGICA DE DETECCIÓN DE PEDIDO ---
        if (textoEscuchado.includes("ponme") || textoEscuchado.includes("pon") || textoEscuchado.includes("quiero escuchar")) {
            const busqueda = textoEscuchado.replace(/ponme|pon|quiero escuchar|la canción|por favor/g, "").trim();
            bot.sendMessage(chatId, `🎧 Te escuché clarito, quieres: "${busqueda}". ¡Buscándola!`);
            
            const track = await buscarMusicaJamendo(busqueda, true);
            if (track) {
                const exito = await descargarYSubirAzura(track);
                if (exito) {
                    bot.sendMessage(chatId, `✅ ¡Logrado! Ya programé "${track.info}" por ti.`);
                }
            } else {
                bot.sendMessage(chatId, "No encontré esa canción, pero procesé tu audio.");
            }
        } else {
            bot.sendMessage(chatId, `¡Entendido! Lupe ya procesó tu mensaje.`);
        }

    } catch (err) {
        console.error("Error Whisper:", err);
        bot.sendMessage(chatId, "No pude procesar el audio.");
    } finally {
        // Borrado con validación extra
        setTimeout(() => {
            if (fs.existsSync(tempVoice)) {
                try {
                    fs.unlinkSync(tempVoice);
                    console.log(`✅ Archivo temporal eliminado: ${tempVoice}`);
                } catch (e) {
                    console.error("No se pudo borrar el temporal aún:", e.message);
                }
            }
        }, 1000); // Un pequeño retraso de 1s asegura que el stream de lectura de OpenAI ya se cerró
    }
});

    // --- Manejo de Pedidos y Saludos de Texto ---
    bot.on('message', async (msg) => {
        if (!msg.text) return;

        // Comandos: /pedir
        if (msg.text.startsWith('/pedir ')) {
            const busqueda = msg.text.replace('/pedir ', '').trim();
            if (busqueda.length < 3) return bot.sendMessage(msg.chat.id, "¡Dime qué canción buscas, ve!");

            bot.sendMessage(msg.chat.id, `🔎 Buscando "${busqueda}"...`);
            
            try {
                const track = await buscarMusicaJamendo(busqueda, true);
                if (track) {
                    const exito = await descargarYSubirAzura(track);
                    if (exito) {
                        ultimoSaludo = { 
                            nombre: msg.from.first_name || "un oyente", 
                            texto: `pidió la canción "${track.info}"`, 
                            fecha: new Date() 
                        };
                        bot.sendMessage(msg.chat.id, `✅ ¡Listo! "${track.info}" ya está en programación.`);
                    } else {
                        bot.sendMessage(msg.chat.id, "❌ Fallo al subir a la emisora.");
                    }
                } else {
                    bot.sendMessage(msg.chat.id, "No encontré esa canción.");
                }
            } catch (error) {
                bot.sendMessage(msg.chat.id, "Error procesando tu pedido.");
            }
            return;
        }

        // Ignorar otros comandos
        if (msg.text.startsWith('/')) return;

        // Saludo de texto normal
        ultimoSaludo = { 
            nombre: msg.from.first_name || "un oyente", 
            texto: msg.text, 
            fecha: new Date() 
        };
        bot.sendMessage(msg.chat.id, "¡Recibido! Tu saludo va para el aire.");
    });

} else {
    console.error("⚠️ Bot de Telegram: DESACTIVADO. Falta la variable TELEGRAM_TOKEN en el .env");
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
    const fileName = "estreno.mp3"; // Nombre fijo para reemplazo constante
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

                    // 1. SUBIDA (Reemplaza el archivo físico en el servidor)
                    await axios.post(AZURA_API_UPLOAD, form, { 
                        headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
                        timeout: 60000 
                    });

                    // 2. PETICIÓN (Fuerza a AzuraCast a ponerlo en cola de prioridad)
                    // Usamos el endpoint de 'request' para que el AutoDJ lo mueva al principio
                    await axios.post(`${AZURA_BASE}/request/${encodeURIComponent(filePath)}`, {}, {
                        headers: { "X-API-Key": KEYS.AZURA }
                    });

                    if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                    resolve(true);
                } catch (err) { 
                    console.error("Error en AzuraCast:", err.response?.data || err.message);
                    resolve(false); 
                }
            });
        });
    } catch (e) { return false; }
}

async function obtenerNoticiasEuronews() {
    try {
        const res = await axios.get("https://es.euronews.com/rss?level=vertical&name=noticias", { timeout: 5000 });
        const matches = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>([^<]+)<\/title>/g);
        if (matches && matches.length > 1) {
            return matches[1].replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').trim();
        }
        return "El mundo sigue en movimiento.";
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

// ======= 4. IA Y VOZ =======

async function redactarIA(prompt) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: "Eres locutora de radio rumbera colombiana. Alegre, carismática y nacional. EVITA decir tu nombre o el de la radio. Si hay un saludo, reacciona con mucha emoción." 
                },
                { role: "user", content: prompt }
            ],
            max_tokens: 250
        });
        return limpiarTexto(response.choices[0].message.content);
    } catch (e) { return "Notas surcando fronteras, quédate con nosotros."; }
}

async function generarVoz(texto, archivoDestino) {
    const params = {
        Text: `<speak>${texto}</speak>`,
        OutputFormat: "mp3",
        VoiceId: "Lupe",
        Engine: "neural",
        TextType: "ssml"
    };
    try {
        const command = new SynthesizeSpeechCommand(params);
        const { AudioStream } = await polly.send(command);
        const buffer = await new Promise((resolve, reject) => {
            const chunks = [];
            AudioStream.on("data", (chunk) => chunks.push(chunk));
            AudioStream.on("end", () => resolve(Buffer.concat(chunks)));
            AudioStream.on("error", reject);
        });
        fs.writeFileSync(archivoDestino, buffer);
    } catch (e) {
        params.Engine = "standard";
        const cmdRetry = new SynthesizeSpeechCommand(params);
        const { AudioStream: sR } = await polly.send(cmdRetry);
        const bR = await new Promise((res) => {
            const c = []; sR.on("data", (k) => c.push(k));
            sR.on("end", () => res(Buffer.concat(c)));
        });
        fs.writeFileSync(archivoDestino, bR);
    }
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondo = "fondo.mp3";
    // Busca esta línea en la función producirYSubir y reemplázala:
    let cmd = (conFondo && fs.existsSync(fondo))
    ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.10[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
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

// ======= 5. AUTOMATIZACIÓN =======

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=4.57&longitude=-74.07&current_weather=true");
        
        // --- SECCIÓN DE NOTICIAS (PARA ACTIVAR: QUITA EL SLASH Y BORRA news=null) ---
        // const news = await obtenerNoticiasEuronews(); 
        const news = null; 
        
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            extras += ` SALUDO: ${ultimoSaludo.nombre} ${ultimoSaludo.texto}.`;
        }

        const infoNoticias = news ? `Noticias de Euronews: ${news}.` : "Hoy el mundo rumbero está tranquilo, ¡solo música!";
        const prompt = `Reporte rumbero. Hora: ${hora}. Suena: ${np.titulo}. Clima: ${Math.round(clim.data.current_weather.temperature)}°C. ${infoNoticias} ${extras} Redacta un guion de 50 palabras muy alegre, sin presentarte.`;

        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        
        ultimoSaludo.fecha = null; 
        console.log("✅ dj_auto.mp3 actualizado.");
    } catch (e) { console.error("Error AutoReporte:", e.message); }
}

async function autoRedactorIA() {
    try {
        const temas = ["un mensaje positivo", "historia rumbera", "dato musical"];
        const tema = temas[Math.floor(Math.random() * temas.length)];
        const prompt = `Redacta 40 palabras sobre ${tema}. Estilo rumbero colombiano nacional. No digas tu nombre. Termina: Notas surcando fronteras.`;
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

// RUTA NUEVA: Para el botón "✨ Redactar" del Frontend
app.post("/redactar-guion", async (req, res) => {
    try {
        const { idea } = req.body;
        if (!idea) return res.status(400).json({ error: "No enviaste una idea" });
        
        // Usamos tu función redactarIA que ya tienes definida
        const guion = await redactarIA(`Genera un guion de locución rumbero sobre: ${idea}. Máximo 40 palabras.`);
        res.json({ guion: guion });
    } catch (e) {
        console.error("Error al redactar:", e);
        res.status(500).json({ error: "Error de IA" });
    }
});

app.get("/health", (req, res) => res.sendStatus(200));

// ======= 7. INICIO =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Nivel 5 activada en puerto ${PORT}`);
    setTimeout(autoReporte, 5000);
    setInterval(autoReporte, 15 * 60 * 1000);
    setTimeout(autoRedactorIA, 20000); 
    setInterval(autoRedactorIA, 50 * 60 * 1000);
});
