require('dotenv').config();

const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== CONFIG =====
const safe = (v) => v ? v.trim() : "";

const KEYS = {
    GEMINI: safe(process.env.GOOGLE_API_KEY),
    GROQ: safe(process.env.GROQ_API_KEY),
    AZURE: safe(process.env.AZURE_SPEECH_KEY),
    AZURE_REGION: safe(process.env.AZURE_REGION),
    AZURA: safe(process.env.AZURA_KEY),
    STATION_ID: (process.env.STATION_ID || "24").replace(/\D/g, ""),
    PASSWORD: safe(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safe(process.env.TELEGRAM_TOKEN),
    JAMENDO_ID: safe(process.env.JAMENDO_CLIENT_ID) || "c230e1f4"
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_UPLOAD = `${AZURA_BASE}/files/upload`;

// ===== TELEGRAM SEGURO =====
let bot = null;
let ultimoSaludo = { nombre: "", texto: "", fecha: null };
let cancionReciente = null;

if (KEYS.TELEGRAM_TOKEN) {
    const TelegramBot = require("node-telegram-bot-api");
    bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });

    bot.on("message", async (msg) => {
        if (!msg.text) return;

        if (msg.text.startsWith("/pedir ")) {
            const busqueda = msg.text.replace("/pedir ", "").trim();

            if (busqueda.length < 3) {
                return bot.sendMessage(msg.chat.id, "Dime el nombre de la canción 🎵");
            }

            bot.sendMessage(msg.chat.id, `Buscando "${busqueda}"...`);

            const track = await buscarMusicaJamendo(busqueda, true);

            if (!track) {
                return bot.sendMessage(msg.chat.id, "No encontré esa canción ❌");
            }

            const ok = await descargarYSubirAzura(track);

            if (ok) {
                ultimoSaludo = {
                    nombre: msg.from.first_name || "oyente",
                    texto: `pidió ${track.info}`,
                    fecha: new Date()
                };
                bot.sendMessage(msg.chat.id, `Listo: ${track.info} 🎙️`);
            } else {
                bot.sendMessage(msg.chat.id, "Error procesando canción ❌");
            }

            return;
        }

        if (msg.text === "/descubrir") {
            const track = await buscarMusicaJamendo("latin", false);
            if (track) {
                await descargarYSubirAzura(track);
                cancionReciente = track.info;
                bot.sendMessage(msg.chat.id, `Nuevo: ${track.info}`);
            }
            return;
        }

        if (!msg.text.startsWith("/")) {
            ultimoSaludo = {
                nombre: msg.from.first_name || "oyente",
                texto: msg.text,
                fecha: new Date()
            };
            bot.sendMessage(msg.chat.id, "Tu saludo saldrá al aire 🎙️");
        }
    });

    console.log("🤖 Telegram activo");
} else {
    console.log("⚠️ Telegram desactivado");
}

// ===== JAMENDO =====
async function buscarMusicaJamendo(query, especifica = false) {
    try {
        const generos = ["salsa", "reggaeton", "bachata"];
        const param = especifica
            ? `search=${encodeURIComponent(query)}`
            : `fuzzytags=${generos[Math.floor(Math.random()*generos.length)]}`;

        const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&limit=1&audioformat=mp32&${param}`;

        const res = await axios.get(url, { timeout: 8000 });

        if (res.data.results?.length) {
            const t = res.data.results[0];
            return { url: t.audio, info: `${t.name} - ${t.artist_name}` };
        }
    } catch {}

    return null;
}

// ===== SUBIR A AZURA =====
async function descargarYSubirAzura(track) {
    const temp = "track.mp3";

    try {
        const res = await axios({ url: track.url, responseType: "stream" });
        const writer = fs.createWriteStream(temp);

        return new Promise((resolve) => {
            res.data.pipe(writer);

            writer.on("finish", async () => {
                try {
                    const form = new FormData();
                    form.append("file", fs.createReadStream(temp), "track.mp3");
                    form.append("path", "Musica_Nueva/track.mp3");

                    await axios.post(AZURA_UPLOAD, form, {
                        headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }
                    });

                    fs.unlinkSync(temp);
                    resolve(true);

                } catch {
                    resolve(false);
                }
            });

            writer.on("error", () => resolve(false));
        });

    } catch {
        return false;
    }
}

// ===== IA =====
async function redactarIA(prompt) {

    // GEMINI
    try {
        if (KEYS.GEMINI) {
            const res = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`,
                { contents: [{ parts: [{ text: prompt }] }] }
            );

            const t = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (t) return limpiar(t);
        }
    } catch {}

    // GROQ
    try {
        if (KEYS.GROQ) {
            const res = await axios.post(
                "https://api.groq.com/openai/v1/chat/completions",
                {
                    model: "llama-3.1-8b-instant",
                    messages: [{ role: "user", content: prompt }]
                },
                { headers: { Authorization: `Bearer ${KEYS.GROQ}` } }
            );

            return limpiar(res.data?.choices?.[0]?.message?.content);
        }
    } catch {}

    return "Estás en La Fronterísima 🔥";
}

function limpiar(t) {
    return (t || "").replace(/[*#_]/g, "").trim();
}

// ===== VOZ =====
async function generarVoz(texto, file) {
    return new Promise((resolve, reject) => {

        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";

        const synth = new sdk.SpeechSynthesizer(config);

        const ssml = `<speak xmlns="http://www.w3.org/2001/10/synthesis">
        <voice name="es-CO-SalomeNeural">
        <prosody rate="+10%">${texto}</prosody>
        </voice></speak>`;

        synth.speakSsmlAsync(
            ssml,
            r => {
                fs.writeFileSync(file, Buffer.from(r.audioData));
                synth.close();
                resolve();
            },
            e => reject(e)
        );
    });
}

// ===== PRODUCCIÓN =====
async function producirYSubir(file, nombre) {
    const out = `out_${Date.now()}.mp3`;

    return new Promise((resolve) => {

        const cmd = fs.existsSync("fondo.mp3")
            ? `ffmpeg -y -i fondo.mp3 -i ${file} -filter_complex "[0:a]volume=0.08[bg];[1:a]volume=2[v];[bg][v]amix=inputs=2" ${out}`
            : `ffmpeg -y -i ${file} ${out}`;

        exec(cmd, async () => {

            try {
                const form = new FormData();
                form.append("file", fs.createReadStream(out), nombre);

                await axios.post(AZURA_UPLOAD, form, {
                    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }
                });

            } catch {}

            [file, out].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
            resolve();
        });
    });
}

// ===== AUTO RADIO =====
async function autoReporte() {
    try {

        const hora = new Date().toLocaleTimeString("es-CO", {
            timeZone: "America/Bogota",
            hour: "2-digit",
            minute: "2-digit"
        });

        let saludo = "";
        if (ultimoSaludo.fecha && Date.now() - ultimoSaludo.fecha < 1800000) {
            saludo = `Saludo de ${ultimoSaludo.nombre}: ${ultimoSaludo.texto}`;
        }

        const prompt = `Radio La Fronterísima. Hora ${hora}. ${saludo}. Mensaje alegre corto.`;

        const texto = await redactarIA(prompt);

        const voz = `voz_${Date.now()}.mp3`;

        await generarVoz(texto, voz);
        await producirYSubir(voz, "dj_auto.mp3");

        console.log("✅ Auto OK");

    } catch (e) {
        console.error("❌ Error:", e.message);
    }
}

// ===== API =====
app.post("/login", (req, res) => {
    if (req.body.password === KEYS.PASSWORD) return res.json({ success: true });
    res.status(401).json({ success: false });
});

app.get("/health", (req, res) => res.send("OK"));

// ===== START =====
const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
    console.log("🔥 Servidor activo");

    setTimeout(autoReporte, 5000);
    setInterval(autoReporte, 15 * 60 * 1000);
});
