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
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
let ultimoSaludo = { nombre: "", texto: "", fecha: null };

bot.on('polling_error', () => {}); 

bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "🎤 Lupe está escuchando tu mensaje de voz... dame un momento.");
    try {
        const fileId = msg.voice.file_id;
        const fileUrl = await bot.getFileLink(fileId);
        const tempVoice = path.join(__dirname, `voice_${Date.now()}.ogg`);
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
                ultimoSaludo = {
                    nombre: msg.from.first_name || "un oyente",
                    texto: `envió un audio que dice: "${transcription.text}"`,
                    fecha: new Date()
                };
                if(fs.existsSync(tempVoice)) fs.unlinkSync(tempVoice);
                bot.sendMessage(chatId, `¡Entendido! ya se procesó tu audio y lo comentará pronto.`);
            } catch (err) { bot.sendMessage(chatId, "No pude procesar el audio."); }
        });
    } catch (e) { bot.sendMessage(chatId, "Error de conexión con Telegram."); }
});

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    ultimoSaludo = { nombre: msg.from.first_name || "un oyente", texto: msg.text, fecha: new Date() };
    bot.sendMessage(msg.chat.id, "¡Recibido! Tu saludo va para el aire.");
});

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
    try {
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);
        return new Promise((resolve) => {
            response.data.pipe(writer);
            writer.on('finish', async () => {
                try {
                    const form = new FormData();
                    form.append('file', fs.createReadStream(tempFile), { filename: "estreno.mp3" });
                    form.append('path', `Musica_Nueva/estreno.mp3`);
                    await axios.post(AZURA_API_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA } });
                    if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                    resolve(true);
                } catch (err) { resolve(false); }
            });
        });
    } catch (e) { return false; }
}

// ======= 3. FUNCIONES DE APOYO =======

async function obtenerNoticiasEuronews() {
    try {
        // Fuente: Euronews en Español
        const res = await axios.get("https://es.euronews.com/rss?level=vertical&name=noticias", { timeout: 5000 });
        const matches = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>([^<]+)<\/title>/g);
        if (matches && matches.length > 1) {
            // El primer match suele ser el título del RSS, tomamos el segundo
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
                    content: "Eres locutora de La Fronterísima. Tu estilo es rumbero y colombiano (nacional). Alegre y carismática. EVITA decir tu nombre o el nombre de la radio en cada frase, ve directo al grano. Si hay un audio del oyente, reacciona con emoción." 
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
    let cmd = (conFondo && fs.existsSync(fondo))
        ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.10,atrim=duration=40[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
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
        
        // --- SECCIÓN DE NOTICIAS (SILENCIADA CON SLASH) ---
        // const news = await obtenerNoticiasEuronews(); 
        const news = null; // Dejamos esto en null para que el código no falle
        
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            extras += ` SALUDO: ${ultimoSaludo.nombre} ${ultimoSaludo.texto}.`;
        }

        // Ajustamos el prompt dinámicamente: Si hay noticias las dice, si no, se enfoca en el sabor rumbero
        const infoNoticias = news ? `Noticias de Euronews: ${news}.` : "Hoy no hay noticias, solo buena vibra y música.";
        
        const prompt = `Reporte rumbero. Hora: ${hora}. Suena: ${np.titulo}. Clima: ${Math.round(clim.data.current_weather.temperature)}°C. ${infoNoticias} ${extras} Redacta un guion de 50 palabras muy alegre, sin presentarte.`;

        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        
        ultimoSaludo.fecha = null; 
        console.log("✅ dj_auto.mp3 actualizado (Noticias silenciadas).");
    } catch (e) { 
        console.error("Error en AutoReporte:", e.message); 
    }
}

async function autoRedactorIA() {
    try {
        const temas = ["un mensaje positivo", "historia rumbera", "dato musical"];
        const tema = temas[Math.floor(Math.random() * temas.length)];
        const prompt = `Redacta 40 palabras sobre ${tema}. Estilo rumbero colombiano. Termina: Notas surcando fronteras.`;
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

app.get("/health", (req, res) => res.sendStatus(200));

// ======= 7. INICIO =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Nivel 5 (Colombia/Euronews) puerto ${PORT}`);
    setTimeout(autoReporte, 5000);
    setInterval(autoReporte, 15 * 60 * 1000);
    setTimeout(autoRedactorIA, 20000); 
    setInterval(autoRedactorIA, 50 * 60 * 1000);
});
