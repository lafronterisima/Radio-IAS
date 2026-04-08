require('dotenv').config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN =======
const KEYS = {
    GEMINI: process.env.GOOGLE_API_KEY,
    GROQ: process.env.GROQ_API_KEY,
    AZURE: process.env.AZURE_SPEECH_KEY,
    AZURE_REGION: process.env.AZURE_REGION,
    AZURA: process.env.AZURA_KEY,
    STATION_ID: process.env.STATION_ID || "24",
    PASSWORD: process.env.APP_PASSWORD,
    URL_APP: process.env.URL_APP || `https://indirect-kelsi-lafronterisima-c6a755f2.koyeb.app`
};

const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;

// ======= 2. WHATSAPP BOT =======
let ultimoSaludo = { nombre: "", texto: "", fecha: null };

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', (qr) => {
    console.log('📱 QR WHATSAPP GENERADO (Revisa los logs):');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => console.log('✅ WhatsApp Conectado.'));

client.on('message', async msg => {
    if (msg.body && !msg.from.includes('@g.us')) {
        const contacto = await msg.getContact();
        ultimoSaludo = { nombre: contacto.pushname || "un oyente", texto: msg.body, fecha: new Date() };
        msg.reply("¡Hola! Tu mensaje llegará pronto al aire de La Fronterísima. 🎙️");
    }
});

client.initialize();

// ======= 3. NÚCLEO DE IA Y PRODUCCIÓN =======

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`https://az.azurafree.eu/api/nowplaying/${KEYS.STATION_ID}`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios artistas", titulo: "la mejor música" };
    } catch (e) { return { artista: "varios artistas", titulo: "tu música favorita" }; }
}

async function obtenerNoticiasBBC() {
    try {
        const res = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml", { timeout: 5000 });
        const matches = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>([^<]+)<\/title>/g);
        return (matches && matches.length > 2) ? 
            `${matches[1].replace(/<[^>]+>/g, '').trim()}. Además: ${matches[2].replace(/<[^>]+>/g, '').trim()}` : 
            "El mundo sigue vibrando con la mejor energía.";
    } catch (e) { return "Sigue en sintonía para más información."; }
}

async function redactarIA(prompt) {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 6000 });
        return res.data?.candidates?.[0]?.content?.parts?.[0]?.text.replace(/[*#_]/g, '').trim();
    } catch (e) {
        try {
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.1-8b-instant",
                messages: [{ role: "system", content: "Locutora colombiana alegre." }, { role: "user", content: prompt }]
            }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 6000 });
            return res.data?.choices?.[0]?.message?.content.replace(/[*#_]/g, '').trim();
        } catch (err) { return "Sintonizas La Fronterísima, notas surcando fronteras."; }
    }
}

async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
        const synth = new sdk.SpeechSynthesizer(config);
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural"><prosody rate="+8%">${texto}</prosody></voice></speak>`;
        synth.speakSsmlAsync(ssml, r => {
            fs.writeFileSync(archivoDestino, Buffer.from(r.audioData));
            synth.close(); resolve();
        }, e => { synth.close(); reject(e); });
    });
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondo = "fondo.mp3";
    const cmd = (conFondo && fs.existsSync(fondo))
        ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;
    
    return new Promise((resolve, reject) => {
        exec(cmd, async (err) => {
            if (err) return reject(err);
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                form.append('path', nombreFinal);
                await axios.post(AZURA_API_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA } });
                [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                resolve();
            } catch (e) { reject(e); }
        });
    });
}

// ======= 4. RUTAS Y WEBHOOKS =======

app.post('/login', (req, res) => {
    res.status(req.body.password === KEYS.PASSWORD ? 200 : 401).json({ success: req.body.password === KEYS.PASSWORD });
});

app.post("/azura-event", async (req, res) => {
    console.log("📡 Webhook: Cambio de canción detectado.");
    autoReporte(); 
    res.sendStatus(200);
});

// A. REPORTE DE NOTICIAS (Se activa por Webhook o cada 15 min)
async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.44&longitude=-76.52&current_weather=true");
        const bbc = await obtenerNoticiasBBC();
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let mencionSaludo = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            mencionSaludo = `SALUDO WHATSAPP: ${ultimoSaludo.nombre} envió: "${ultimoSaludo.texto}".`;
        }

        const prompt = `Eres locutora de La Fronterísima. 
        HORA: ${hora}. Clima: ${Math.round(clim.data.current_weather.temperature)}°C. 
        Música: ${np.titulo} de ${np.artista}. Noticias: ${bbc}. ${mencionSaludo}
        Instrucción: Guion dinámico de 60 palabras. DI LA HORA AL PRINCIPIO. Saluda al oyente de WhatsApp si hay mensaje. 
        Eslogan final: "La Fronterísima, notas surcando fronteras". SOLO TEXTO.`;

        const guion = await redactarIA(prompt);
        const pathV = `v_auto.mp3`;
        await generarVoz(guion, pathV);
        await producirYSubir(pathV, "dj_auto.mp3", true);
        ultimoSaludo.fecha = null; 
        console.log(`✅ dj_auto.mp3 actualizado a las ${hora}`);
    } catch (e) { console.error("❌ Error AutoReporte:", e.message); }
}

// B. CONTENIDO CREATIVO (Cada 50 minutos)
async function autoContenidoCreativo() {
    try {
        const temas = ["un dato curioso de la música latina", "un mensaje motivador", "historia de un género musical", "sabías que..."];
        const tema = temas[Math.floor(Math.random() * temas.length)];
        const prompt = `Eres locutora de La Fronterísima. Genera un guion de 40 palabras sobre ${tema}. Tono alegre y profesional. Incluye el eslogan al final.`;

        const guion = await redactarIA(prompt);
        const pathV = `v_crea.mp3`;
        await generarVoz(guion, pathV);
        await producirYSubir(pathV, "Redactor_ia.mp3", true);
        console.log(`✅ Redactor_ia.mp3 (Creativo) actualizado: ${tema}`);
    } catch (e) { console.error("❌ Error Creativo:", e.message); }
}

// ======= 5. TEMPORIZADORES AUTOMÁTICOS =======

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);

    // Ejecución inicial y luego cada 15 minutos (Reporte de Noticias)
    setTimeout(autoReporte, 5000); 
    setInterval(autoReporte, 15 * 60 * 1000);

    // Ejecución cada 50 minutos (Contenido Creativo)
    setInterval(autoContenidoCreativo, 50 * 60 * 1000);
});
