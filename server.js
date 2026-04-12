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

// ======= 2. TELEGRAM =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });

let ultimoSaludo = { nombre: "", texto: "", fecha: null };
let cancionRecienDescubierta = null;

bot.on('polling_error', (e) => {
    console.error("❌ Telegram error:", e.message);
});

bot.on('message', async (msg) => {
    if (!msg.text) return;

    if (msg.text.startsWith('/pedir ')) {
        const busqueda = msg.text.replace('/pedir ', '').trim();
        if (busqueda.length < 3) {
            return bot.sendMessage(msg.chat.id, "¡Dime el nombre de la canción! 🎵");
        }

        bot.sendMessage(msg.chat.id, `🔎 Buscando "${busqueda}"...`);
        const track = await buscarMusicaJamendo(busqueda, true);

        if (track) {
            const exito = await descargarYSubirAzura(track);
            if (exito) {
                ultimoSaludo = {
                    nombre: msg.from.first_name || "oyente",
                    texto: `pidió ${track.info}`,
                    fecha: new Date()
                };
                bot.sendMessage(msg.chat.id, `✅ Subida: ${track.info}`);
            } else {
                bot.sendMessage(msg.chat.id, "❌ Error procesando canción");
            }
        } else {
            bot.sendMessage(msg.chat.id, "❌ No encontrada");
        }
        return;
    }

    if (msg.text === '/descubrir') {
        bot.sendMessage(msg.chat.id, "🔎 Buscando música nueva...");
        const track = await buscarMusicaJamendo('latin', false);
        if (track) {
            await descargarYSubirAzura(track);
            cancionRecienDescubierta = track.info;
            bot.sendMessage(msg.chat.id, `✅ Estreno: ${track.info}`);
        }
        return;
    }

    if (!msg.text.startsWith('/')) {
        ultimoSaludo = {
            nombre: msg.from.first_name || "oyente",
            texto: msg.text,
            fecha: new Date()
        };
        bot.sendMessage(msg.chat.id, "🎙️ Saludo recibido");
    }
});

// ======= 3. AZURA =======
async function solicitarCancionEnAzura(nombreArchivo) {
    try {
        const res = await axios.get(`${AZURA_BASE}/files`, {
            headers: { "X-API-Key": KEYS.AZURA }
        });

        const archivo = res.data.find(f => f.path === `Musica_Nueva/${nombreArchivo}`);

        if (archivo?.unique_id) {
            await axios.post(`${AZURA_BASE}/request/${archivo.unique_id}`, {}, {
                headers: { "X-API-Key": KEYS.AZURA }
            });
            console.log("🎵 Solicitada en Azura:", nombreArchivo);
        }
    } catch (e) {
        console.error("❌ Error request:", e.message);
    }
}

// ======= 4. JAMENDO =======
async function buscarMusicaJamendo(query, esBusquedaEspecifica = false) {
    try {
        const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&search=${query}`;
        const res = await axios.get(url);

        if (res.data.results?.length > 0) {
            const t = res.data.results[0];
            return { url: t.audio, info: `${t.name} - ${t.artist_name}` };
        }
    } catch {
        return null;
    }
}

// ======= 5. DESCARGAR =======
async function descargarYSubirAzura(track) {
    const tempFile = "tmp.mp3";
    const nombre = "pedido.mp3";

    try {
        const response = await axios({ url: track.url, responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);

        return new Promise((resolve) => {
            response.data.pipe(writer);

            writer.on('finish', async () => {
                try {
                    const form = new FormData();
                    form.append('file', fs.createReadStream(tempFile), { filename: nombre });
                    form.append('path', `Musica_Nueva/${nombre}`);

                    await axios.post(AZURA_API_UPLOAD, form, {
                        headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }
                    });

                    fs.unlinkSync(tempFile);

                    setTimeout(() => solicitarCancionEnAzura(nombre), 2000);

                    resolve(true);
                } catch {
                    resolve(false);
                }
            });
        });
    } catch {
        return false;
    }
}

// ======= 6. IA =======
async function redactarIA(prompt) {
    try {
        const res = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: prompt }]
            },
            { headers: { Authorization: `Bearer ${KEYS.GROQ}` } }
        );
        return res.data.choices[0].message.content;
    } catch {
        return "La Fronterísima en vivo";
    }
}

// ======= 7. TTS CORREGIDO =======
async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        try {
            const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
            config.speechSynthesisVoiceName = "es-ES-ElviraNeural";

            const audioConfig = sdk.AudioConfig.fromAudioFileOutput(archivoDestino);
            const synth = new sdk.SpeechSynthesizer(config, audioConfig);

            synth.speakTextAsync(
                texto,
                (result) => {
                    if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                        console.log("✅ TTS OK");
                        synth.close();
                        resolve();
                    } else {
                        console.error("❌ TTS error:", result.errorDetails);
                        synth.close();
                        reject(result.errorDetails);
                    }
                },
                (err) => {
                    console.error("❌ TTS crítico:", err);
                    synth.close();
                    reject(err);
                }
            );
        } catch (e) {
            reject(e.message);
        }
    });
}

// ======= 8. PRODUCCIÓN =======
async function producirYSubir(vozFile, nombreFinal) {
    const salida = `out_${Date.now()}.mp3`;

    return new Promise((resolve) => {
        exec(`ffmpeg -y -i ${vozFile} -af "volume=1.5" ${salida}`, async () => {
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(salida), { filename: nombreFinal });
                form.append('path', nombreFinal);

                await axios.post(AZURA_API_UPLOAD, form, {
                    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }
                });

                fs.unlinkSync(vozFile);
                fs.unlinkSync(salida);

                resolve();
            } catch {
                resolve();
            }
        });
    });
}

// ======= 9. AUTO DJ =======
async function autoReporte() {
    try {
        const hora = new Date().toLocaleTimeString("es-CO");
        const texto = await redactarIA(`Di la hora ${hora} en La Fronterísima`);

        await generarVoz(texto, "voz.mp3");
        await producirYSubir("voz.mp3", "dj_auto.mp3");

        console.log("🔥 DJ actualizado");
    } catch (e) {
        console.error("❌ AutoDJ:", e.message);
    }
}

// ======= 10. API =======
app.get("/health", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
    console.log(`🚀 Puerto ${PORT}`);
    setTimeout(autoReporte, 5000);
    setInterval(autoReporte, 15 * 60 * 1000);
});
