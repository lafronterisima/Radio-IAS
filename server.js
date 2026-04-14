require('dotenv').config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const { pipeline } = require('stream/promises');
const gTTS = require('gtts');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= CONFIG =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = {
    GROQ: safeTrim(process.env.GROQ_API_KEY),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    JAMENDO_ID: safeTrim(process.env.JAMENDO_CLIENT_ID) || "c230e1f4"
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

// ===== TELEGRAM =====
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });

let ultimoSaludo = { nombre: "", texto: "", fecha: null };
let cancionRecienDescubierta = null;

bot.on('message', async (msg) => {
    if (!msg.text) return;

    if (msg.text.startsWith('/pedir ')) {
        const busqueda = msg.text.replace('/pedir ', '').trim();

        const track = await buscarMusicaJamendo(busqueda, true);

        if (track) {
            const exito = await descargarYSubirAzura(track);
            if (exito) {
                ultimoSaludo = {
                    nombre: msg.from.first_name,
                    texto: `pidió ${track.info}`,
                    fecha: new Date()
                };
                bot.sendMessage(msg.chat.id, "🎵 ¡Listo!");
            }
        }
        return;
    }

    if (!msg.text.startsWith('/')) {
        ultimoSaludo = {
            nombre: msg.from.first_name,
            texto: msg.text,
            fecha: new Date()
        };
    }
});

// ===== JAMENDO =====
async function buscarMusicaJamendo(query, esBusquedaEspecifica = false) {
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&search=${encodeURIComponent(query)}`;

    try {
        const res = await axios.get(url);
        if (res.data.results?.length > 0) {
            const t = res.data.results[0];
            return { url: t.audio, info: `${t.name} - ${t.artist_name}` };
        }
    } catch (e) {}
    return null;
}

// ===== SUBIR A AZURA =====
async function descargarYSubirAzura(track) {
    const tempFile = "tmp.mp3";

    try {
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        await pipeline(response.data, fs.createWriteStream(tempFile));

        const form = new FormData();
        form.append('file', fs.createReadStream(tempFile), { filename: "pedido.mp3" });
        form.append('path', "Musica_Nueva");

        await axios.post(AZURA_API_UPLOAD, form, {
            headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }
        });

        fs.unlinkSync(tempFile);
        return true;

    } catch (e) {
        console.log(e.message);
        return false;
    }
}

// ===== IA TEXTO =====
async function redactarIA(prompt) {
    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }]
        }, {
            headers: { Authorization: `Bearer ${KEYS.GROQ}` }
        });

        return res.data.choices[0].message.content;
    } catch {
        return "Estás escuchando La Fronterísima";
    }
}

// ===== TTS (gTTS) =====
async function generarVoz(texto, archivo) {
    return new Promise((resolve, reject) => {
        const tts = new gTTS(texto, 'es');
        tts.save(archivo, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// ===== PRODUCCIÓN AUDIO =====
async function producirYSubir(archivoVoz, nombreFinal) {
    const salida = "final.mp3";

    return new Promise((resolve) => {
        exec(`ffmpeg -y -i ${archivoVoz} -af "volume=1.5" ${salida}`, async () => {
            const form = new FormData();
            form.append('file', fs.createReadStream(salida), { filename: nombreFinal });

            await axios.post(AZURA_API_UPLOAD, form, {
                headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }
            });

            fs.unlinkSync(archivoVoz);
            fs.unlinkSync(salida);
            resolve();
        });
    });
}

// ===== AUTOMÁTICO =====
async function autoReporte() {
    const hora = new Date().toLocaleTimeString("es-CO");

    const texto = await redactarIA(`Di la hora ${hora} como locutora de radio`);

    const voz = "voz.mp3";

    await generarVoz(texto, voz);
    await producirYSubir(voz, "dj_auto.mp3");

    console.log("🎙️ Auto DJ listo");
}

app.post('/login', (req, res) => {
    try {
        const password = req.body.password;

        if (!password) {
            return res.status(400).json({ success: false, error: "Falta password" });
        }

        if (password === KEYS.PASSWORD) {
            return res.json({ success: true });
        } else {
            return res.status(401).json({ success: false });
        }
    } catch (e) {
        return res.status(500).json({ success: false });
    }
});

// ===== API =====
app.get("/health", (req, res) => res.send("OK"));

// ===== SERVER =====
const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
    console.log("🚀 Radio IA corriendo");

    setInterval(autoReporte, 15 * 60 * 1000);
});
