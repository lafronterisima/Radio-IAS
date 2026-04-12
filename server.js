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

// ======= 2. VARIABLES DE ESTADO =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
let ultimoSaludo = { nombre: "", texto: "", fecha: null };
let produciendoVoz = false; // Bloqueo para evitar colisiones de IA

bot.on('polling_error', () => {}); 

// ======= 3. TELEGRAM =======
bot.on('message', async (msg) => {
    if (!msg.text) return;

    if (msg.text.startsWith('/pedir ')) {
        const busqueda = msg.text.replace('/pedir ', '').trim();
        if (busqueda.length < 3) return bot.sendMessage(msg.chat.id, "¡Dime el nombre de la canción! 🎵");

        bot.sendMessage(msg.chat.id, `🔎 Buscando "${busqueda}"...`);
        const track = await buscarMusicaJamendo(busqueda, true); 

        if (track) {
            const exito = await descargarYSubirAzura(track);
            if (exito) {
                ultimoSaludo = { 
                    nombre: msg.from.first_name || "un oyente", 
                    texto: `pidió la canción "${track.info}"`, 
                    fecha: new Date() 
                };
                bot.sendMessage(msg.chat.id, `✅ ¡Subida! "${track.info}". Salomé la presentará pronto.`);
            } else {
                bot.sendMessage(msg.chat.id, `❌ Error al procesar el archivo.`);
            }
        } else {
            bot.sendMessage(msg.chat.id, `❌ No encontré esa canción.`);
        }
        return;
    }

    if (!msg.text.startsWith('/')) {
        ultimoSaludo = {
            nombre: msg.from.first_name || "un oyente",
            texto: msg.text,
            fecha: new Date()
        };
        bot.sendMessage(msg.chat.id, "¡Recibido! Tu saludo saldrá al aire. 🎙️");
    }
});

// ======= 4. FUNCIONES DE APOYO =======

async function buscarMusicaJamendo(query, esBusquedaEspecifica = false) {
    const generos = ['salsa', 'reggaeton', 'bachata', 'vallenato'];
    let parametro = esBusquedaEspecifica ? `search=${encodeURIComponent(query)}` : `fuzzytags=${generos[Math.floor(Math.random() * generos.length)]}&order=ratingdesc`;
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&${parametro}`;
    try {
        const res = await axios.get(url, { timeout: 8000 });
        if (res.data.results?.length > 0) {
            const t = res.data.results[0];
            return { url: t.audio, info: `${t.name} de ${t.artist_name}` };
        }
    } catch (e) { return null; }
}

async function descargarYSubirAzura(track) {
    const tempFile = path.join(__dirname, `tmp_${Date.now()}.mp3`);
    try {
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);
        
        return new Promise((resolve) => {
            response.data.pipe(writer);
            writer.on('finish', async () => {
                try {
                    const form = new FormData();
                    const nombreArchivo = `pedido_${Date.now()}.mp3`;

                    form.append('file', fs.createReadStream(tempFile), { filename: nombreArchivo });
                    form.append('path', nombreArchivo); // SUBIDA A LA RAIZ

                    await axios.post(AZURA_API_UPLOAD, form, { 
                        headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
                        maxContentLength: Infinity,
                        maxBodyLength: Infinity,
                        timeout: 90000 
                    });

                    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                    resolve(true);
                } catch (err) {
                    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                    resolve(false);
                }
            });
        });
    } catch (e) { return false; }
}

// ======= 5. PRODUCCIÓN Y AUTOMATIZACIÓN =======

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

async function autoReporte() {
    if (produciendoVoz) return;
    produciendoVoz = true;
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
        console.log("✅ dj_auto.mp3 actualizado.");
    } catch (e) { console.error("Error AutoReporte:", e.message); }
    finally { produciendoVoz = false; }
}

async function autoRedactorIA() {
    if (produciendoVoz) return;
    produciendoVoz = true;
    try {
        const temas = ["un mensaje positivo", "una efeméride musical", "un dato curioso de Cali", "historia de un artista de salsa"];
        const tema = temas[Math.floor(Math.random() * temas.length)];
        const prompt = `Salomé de La Fronterísima. Redacta 40 palabras sobre ${tema}. Muy alegre. Termina: Notas surcando fronteras.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_red_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
        console.log("✅ Redactor_ia.mp3 actualizado.");
    } catch (e) { console.error("Error AutoRedactor:", e.message); }
    finally { produciendoVoz = false; }
}

// (Las demás funciones generarVoz, redactarIA, obtenerNoticiasBBC se mantienen igual)

// ======= 6. INICIO DEL SERVIDOR =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro en puerto ${PORT}`);
    
    // Tiempos escalonados para evitar saturar las APIs al arrancar
    setTimeout(autoReporte, 10000); // 10 seg
    setInterval(autoReporte, 15 * 60 * 1000); // Cada 15 min

    setTimeout(autoRedactorIA, 20000); // 20 seg
    setInterval(autoRedactorIA, 50 * 60 * 1000); // Cada 50 min
});
