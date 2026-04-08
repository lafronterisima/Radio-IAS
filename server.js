require('dotenv').config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');

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
let cancionRecienDescubierta = null;

bot.on('polling_error', () => {}); 

bot.on('message', async (msg) => {
    if (!msg.text) return;

    // COMANDO /PEDIR [CANCIÓN O ARTISTA]
    if (msg.text.startsWith('/pedir ')) {
        const busqueda = msg.text.replace('/pedir ', '').trim();
        if (busqueda.length < 3) return bot.sendMessage(msg.chat.id, "¡Dime el nombre de la canción o artista! 🎵");

        bot.sendMessage(msg.chat.id, `🔎 Buscando "${busqueda}" en Jamendo...`);
        const track = await buscarMusicaJamendo(busqueda, true); 

        if (track) {
            await descargarYSubirAzura(track);
            // Guardamos el pedido para que Salomé lo diga al aire
            ultimoSaludo = { 
                nombre: msg.from.first_name || "un oyente", 
                texto: `pidió la canción "${track.info}" y ya la subí a la programación`, 
                fecha: new Date() 
            };
            bot.sendMessage(msg.chat.id, `✅ ¡Listo! He subido "${track.info}". Salomé te la dedicará en el próximo reporte. 🎙️`);
        } else {
            bot.sendMessage(msg.chat.id, `❌ No encontré "${busqueda}" en el catálogo. ¡Intenta con otro nombre!`);
        }
        return;
    }

    // COMANDO /DESCUBRIR (Música aleatoria)
    if (msg.text === '/descubrir') {
        bot.sendMessage(msg.chat.id, "🔎 Buscando algo nuevo para la radio...");
        const track = await buscarMusicaJamendo('latin', false);
        if (track) {
            await descargarYSubirAzura(track);
            cancionRecienDescubierta = track.info;
            bot.sendMessage(msg.chat.id, `✅ ¡Subida! "${track.info}". Sonará pronto.`);
        }
        return;
    }

    // REGISTRO DE SALUDOS NORMALES
    if (!msg.text.startsWith('/')) {
        ultimoSaludo = {
            nombre: msg.from.first_name || "un oyente",
            texto: msg.text,
            fecha: new Date()
        };
        bot.sendMessage(msg.chat.id, "¡Recibido! Tu saludo saldrá al aire pronto. 🎙️");
    }
});

// ======= 3. FUNCIONES DE APOYO & JAMENDO =======

async function buscarMusicaJamendo(query, esBusquedaEspecifica = false) {
    // Tus géneros preferidos para búsquedas aleatorias (/descubrir)
    const generosFronterisima = ['salsa', 'reggaeton', 'bachata', 'vallenato', 'popular', 'balada'];
    
    let parametro;
    if (esBusquedaEspecifica) {
        // Si el oyente pide algo, buscamos por texto
        parametro = `search=${encodeURIComponent(query)}`;
    } else {
        // Si es aleatorio, elegimos uno de tus géneros al azar
        const generoAzar = generosFronterisima[Math.floor(Math.random() * generosFronterisima.length)];
        parametro = `fuzzytags=${generoAzar}&order=ratingdesc`; // 'ratingdesc' trae lo mejor valorado
    }

    // Filtramos por duración (mínimo 2 min) para evitar clips raros o ruidos
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&durationbetween=120_600&${parametro}`;
    
    try {
        const res = await axios.get(url, { timeout: 8000 });
        if (res.data.results?.length > 0) {
            const t = res.data.results[0];
            return {
                url: t.audio,
                nombre: `estreno_jamendo.mp3`, // Nombre fijo para que reemplace al anterior
                info: `${t.name} de ${t.artist_name}`
            };
        }
    } catch (e) { 
        console.error("Error Jamendo Filtro:", e.message);
        return null; 
    }
}

async function descargarYSubirAzura(track) {
    const tempFile = path.join(__dirname, 'tmp_track.mp3');
    const NOMBRE_FIJO = "estreno_jamendo.mp3"; 

    try {
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);
        
        return new Promise((resolve, reject) => {
            response.data.pipe(writer);

            writer.on('finish', async () => {
                try {
                    const form = new FormData();
                    // Importante: No abrimos el stream de lectura hasta que el de escritura cerró
                    form.append('file', fs.createReadStream(tempFile), { filename: NOMBRE_FIJO });
                    form.append('path', `Musica_Nueva/${NOMBRE_FIJO}`); 

                    await axios.post(AZURA_API_UPLOAD, form, { 
                        headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, 
                        timeout: 90000 
                    });

                    if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                    resolve(true);
                } catch (err) {
                    if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                    console.error("Error subiendo a Azura:", err.message);
                    reject(err);
                }
            });

            writer.on('error', (err) => {
                if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                reject(err);
            });
        });
    } catch (e) { 
        console.error("Error al reemplazar en Jamendo:", e.message); 
        return false;
    }
}

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios artistas", titulo: "la mejor música" };
    } catch (e) { return { artista: "varios artistas", titulo: "tu música favorita" }; }
}

async function obtenerNoticiasBBC() {
    try {
        const res = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml", { timeout: 5000 });
        const matches = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>([^<]+)<\/title>/g);
        if (matches && matches.length > 2) {
            const n1 = matches[1].replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').trim();
            const n2 = matches[2].replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').trim();
            return `${n1}. Además: ${n2}`;
        }
        return "El mundo sigue vibrando.";
    } catch (e) { return "Sigue en sintonía."; }
}

function limpiarTexto(t) {
    if (!t) return "";
    return t.replace(/[*#_~]/g, '').replace(/Locutor:|Guion:|Respuesta:|Locutora:|Salomé:/gi, '').trim();
}

// ======= 4. INTELIGENCIA ARTIFICIAL (NÚCLEO) =======

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
                messages: [{ role: "system", content: "Locutora colombiana rumbera." }, { role: "user", content: prompt }]
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
    const fondo = "fondo.mp3", intro = "intro.mp3";
    let cmd;
    
    if (conFondo && fs.existsSync(fondo) && fs.existsSync(intro)) {
        cmd = `ffmpeg -y -i ${intro} -i ${archivoVoz} -i ${fondo} -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[full_voz]; [2:a]volume=0.12[bg]; [full_voz]volume=1.8[v]; [bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`;
    } else {
        cmd = `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;
    }

    return new Promise((resolve) => {
        exec(cmd, async () => {
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

// ======= 6. RUTAS API (FRONTEND) =======

app.post("/redactar-guion", async (req, res) => {
    try {
        const { idea } = req.body;
        const promptManual = `Locutora de La Fronterísima. Guion alegre sobre: ${idea}. Máximo 40 palabras. Usa el eslogan: Notas surcando fronteras.`;
        const textoIa = await redactarIA(promptManual);
        // Enviamos el objeto con la propiedad "guion" para que el frontend la lea bien
        res.json({ guion: textoIa }); 
    } catch (e) {
        res.json({ guion: "¡Sintoniza La Fronterísima, notas surcando fronteras!" });
    }
});

app.post("/procesar-locucion", async (req, res) => {
    const { texto, conFondo } = req.body;
    const pathVoz = `v_man_${Date.now()}.mp3`;
    try {
        await generarVoz(texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

// ======= 7. AUTOMATIZACIÓN =======

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const bbc = await obtenerNoticiasBBC();
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = "";
        // Si hay un saludo o PEDIDO reciente
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            extras += ` INTERACCIÓN: ${ultimoSaludo.nombre} ${ultimoSaludo.texto}.`;
        }
        if (cancionRecienDescubierta) {
            extras += ` NOVEDAD: Acabamos de subir ${cancionRecienDescubierta} a nuestra programación.`;
            cancionRecienDescubierta = null;
        }

        const prompt = `Actúa como Salomé de La Fronterísima. Hora: ${hora}. Música actual: ${np.titulo}. Clima: ${Math.round(clim.data.current_weather.temperature)}°C en Colombia. Noticias: ${bbc}. ${extras} Guion de 55 palabras muy rumbero. Termina con Notas surcando fronteras.`;
        
        const guion = await redactarIA(prompt);
        await generarVoz(guion, "v_auto.mp3");
        await producirYSubir("v_auto.mp3", "dj_auto.mp3", true);
        
        ultimoSaludo.fecha = null; // Limpiamos para no repetir el saludo eternamente
        console.log(`✅ dj_auto.mp3 actualizado con éxito.`);
    } catch (e) { console.error("Error Auto:", e.message); }
}

// ======= 8. INICIO =======

app.get("/health", (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro en puerto ${PORT}`);
    setTimeout(autoReporte, 5000);
    setInterval(autoReporte, 15 * 60 * 1000);
});
