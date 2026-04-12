require('dotenv').config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
const { pipeline } = require('stream/promises');

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
    AZURE_REGION: safeTrim(process.env.AZURE_REGION) || "eastus",
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    JAMENDO_ID: safeTrim(process.env.JAMENDO_CLIENT_ID) || "c230e1f4"
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

// ======= 2. TELEGRAM CON MANEJO DE CONFLICTOS =======
let bot;
if (KEYS.TELEGRAM_TOKEN) {
    bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
    bot.on('polling_error', (err) => {
        if (err.code === 'ETELEGRAM' && err.message.includes('409 Conflict')) {
            console.log("⚠️ Conflicto de Telegram: Otra instancia está activa.");
        }
    });
} else {
    console.error("❌ ERROR: TELEGRAM_TOKEN no configurado.");
}

let ultimoSaludo = { nombre: "", texto: "", fecha: null };

if (bot) {
    bot.on('message', async (msg) => {
        if (!msg.text || msg.from.is_bot) return;

        // COMANDO DE PEDIDO
        if (msg.text.startsWith('/pedir ')) {
            const busqueda = msg.text.replace('/pedir ', '').trim();
            if (busqueda.length < 3) return bot.sendMessage(msg.chat.id, "¡Dime el nombre de la canción! 🎵");
            
            bot.sendMessage(msg.chat.id, `🔎 Buscando "${busqueda}" en Jamendo...`);
            const track = await buscarMusicaJamendo(busqueda, true); 
            
            if (track) {
                const exito = await descargarYSubirAzura(track);
                if (exito) {
                    // Retraso de 5 segundos para que Azura indexe el archivo antes de solicitarlo
                    setTimeout(async () => {
                        const solicitado = await solicitarCancionEnAzura(6991);
                        if (solicitado) {
                            ultimoSaludo = { nombre: msg.from.first_name || "oyente", texto: `pidió ${track.info}`, fecha: new Date() };
                            bot.sendMessage(msg.chat.id, `✅ ¡Subida! Salomé la presentará pronto.`);
                        } else {
                            bot.sendMessage(msg.chat.id, `⚠️ Archivo subido, pero la estación no acepta pedidos ahora.`);
                        }
                    }, 5000);
                } else {
                    bot.sendMessage(msg.chat.id, `❌ Error al subir a la radio.`);
                }
            } else {
                bot.sendMessage(msg.chat.id, `❌ No encontré esa canción.`);
            }
            return;
        }

        // SALUDO NORMAL
        if (!msg.text.startsWith('/')) {
            ultimoSaludo = { nombre: msg.from.first_name || "oyente", texto: msg.text, fecha: new Date() };
            bot.sendMessage(msg.chat.id, "¡Saludo recibido! Salomé lo leerá en el próximo reporte. 🎙️");
        }
    });
}

// ======= 3. FUNCIONES DE APOYO =======

async function buscarMusicaJamendo(query, esBusquedaEspecifica = false) {
    try {
        let url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&vocalinstrumental=vocal`;
        url += esBusquedaEspecifica ? `&search=${encodeURIComponent(query)}` : `&fuzzytags=salsa&order=ratingdesc`;
        const res = await axios.get(url, { timeout: 8000 });
        if (res.data.results?.[0]) {
            return { url: res.data.results[0].audio, info: `${res.data.results[0].name} - ${res.data.results[0].artist_name}` };
        }
    } catch (e) { return null; }
}

async function solicitarCancionEnAzura(mediaId) {
    try {
        await axios.post(`${AZURA_BASE}/request/${mediaId}`, {}, { headers: { "X-API-Key": KEYS.AZURA } });
        return true;
    } catch (error) { 
        console.error("Error solicitud:", error.response?.data || error.message);
        return false; 
    }
}

async function descargarYSubirAzura(track) {
    const tempFile = path.join(__dirname, `tmp_${Date.now()}.mp3`);
    try {
        const res = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        await pipeline(res.data, fs.createWriteStream(tempFile));
        
        const form = new FormData();
        form.append('path', 'Musica_Nueva'); 
        form.append('file', fs.createReadStream(tempFile), { filename: `Musica_Nueva/pedido_actual.mp3` });
        
        await axios.post(AZURA_API_UPLOAD, form, { 
            headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, 
            timeout: 120000 
        });
        
        if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return true;
    } catch (err) {
        console.error("Error descarga/subida:", err.message);
        if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return false;
    }
}

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios", titulo: "éxitos" };
    } catch (e) { return { artista: "varios", titulo: "éxitos" }; }
}

// ======= 4. IA Y VOZ =======

async function redactarIA(prompt) {
    // Definimos la personalidad de Salomé con sus elementos clave
    const systemMsg = "Eres Salomé, locutora rumbera de La Fronterísima en Cali. Tu estilo es alegre, con sabor, usas jerga caleña suave (ve, mirá, oís, que todo bien). Eres breve, máximo 45 palabras. No uses emojis ni menciones asteriscos.";
    
    try {
        console.log("🤖 Solicitando guion a GROQ...");
        
        // 1. Intento principal con GROQ
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: systemMsg },
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 150
        }, { 
            headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, 
            timeout: 8000 
        });

        const texto = res.data?.choices?.[0]?.message?.content;
        if (!texto) throw new Error("GROQ devolvió respuesta vacía");

        return limpiarTextoIA(texto);

    } catch (e) {
        console.error("⚠️ Falló GROQ, intentando Fallback con GEMINI...", e.message);
        
        try {
            // 2. Fallback con GEMINI
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
            const res = await axios.post(url, { 
                contents: [{ 
                    parts: [{ text: `Instrucción: ${systemMsg}\n\nContexto actual: ${prompt}` }] 
                }] 
            }, { timeout: 10000 });

            const textoGemini = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!textoGemini) throw new Error("GEMINI también falló");

            return limpiarTextoIA(textoGemini);

        } catch (err) {
            console.error("❌ Ambas IAs fallaron:", err.message);
            // 3. Texto de emergencia (Nunca devuelve undefined)
            return "¡Veee, qué todo bien! Sintonizas La Fronterísima, la radio que te pone a gozar en la Sucursal del Cielo. ¡Notas surcando fronteras!";
        }
    }
}

// Función auxiliar para dejar el texto impecable para la voz de Salomé
function limpiarTextoIA(t) {
    return t
        .replace(/[*#_~]/g, '') // Quita símbolos de formato Markdown
        .replace(/Locutora:|Salomé:|Respuesta:|Guion:/gi, '') // Quita etiquetas innecesarias
        .replace(/\((.*?)\)/g, '') // Quita acotaciones entre paréntesis como (riendo)
        .trim();
}

async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        if (!KEYS.AZURE) return reject("Falta AZURE_SPEECH_KEY");
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
        const synth = new sdk.SpeechSynthesizer(config);
        
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural"><mstts:express-as style="cheerful" styledegree="1.4" xmlns:mstts="https://www.w3.org/2001/mstts">
            <prosody rate="+8%">${texto}</prosody></mstts:express-as></voice></speak>`;
        
        synth.speakSsmlAsync(ssml, r => {
            synth.close();
            if (r.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync(archivoDestino, Buffer.from(r.audioData));
                resolve();
            } else reject("Error Azure TTS");
        }, e => { synth.close(); reject(e); });
    });
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondo = "fondo.mp3"; // Asegúrate de tener este archivo en la raíz
    
    let cmd = (conFondo && fs.existsSync(fondo))
        ? `ffmpeg -y -i "${fondo}" -i "${archivoVoz}" -filter_complex "[0:a]volume=0.08,atrim=duration=35[bg];[1:a]volume=1.8[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k "${tempSalida}"`
        : `ffmpeg -y -i "${archivoVoz}" -af "volume=1.6" -c:a libmp3lame -b:a 128k "${tempSalida}"`;

    return new Promise((resolve) => {
        exec(cmd, async (error) => {
            if (error) {
                console.error("Error FFmpeg:", error);
                return resolve(false);
            }
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                form.append('path', ''); 
                await axios.post(AZURA_API_UPLOAD, form, { 
                    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, 
                    timeout: 60000 
                });
                [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                resolve(true);
            } catch (e) { 
                console.error("Error subida final:", e.message);
                resolve(false); 
            }
        });
    });
}

// ======= 2. OBTENER NOTICIAS (RSS) =======
async function obtenerNoticia() {
    try {
        // Nueva URL de Euronews Mundo
     const res = await axios.get("https://es.euronews.com/rss?level=vertical&name=mundo", {
       headers: { 'User-Agent': 'Mozilla/5.0 (LaFronterisima-Radio-Bot)' },
       timeout: 5000
  });

        // Extraemos todos los t铆tulos. 
        // Nota: El primer <title> suele ser el nombre del canal ("Euronews Mundo"), lo saltamos.
        const match = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>([^<]+)<\/title>/g);

        if (match && match.length > 1) {
            // Saltamos el 铆ndice 0 (T铆tulo del canal) y elegimos uno al azar
            const index = Math.floor(Math.random() * (match.length - 1)) + 1;
            
            // Limpiamos etiquetas, CDATA y posibles sufijos de marca
            let noticia = match[index]
                .replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '')
                .split(' | ')[0]  // Euronews a veces usa " | Euronews"
                .trim();

            return noticia;
        }
        
        return "Sigue vibrando con la mejor energ铆a rumbera.";
    } catch (e) { 
        console.error("Error en RSS Euronews:", e.message);
        return "Notas surcando fronteras con la mejor m煤sica."; 
    }
}

// ======= 5. AUTOMATIZACIÓN =======

async function autoReporte() {
    try {
        console.log("🎙️ Generando reporte completo (Noticias + Clima + Música)...");

        // Obtenemos todo en paralelo para máxima eficiencia
        const [np, clim, bbc] = await Promise.all([
            obtenerAhoraSuena(),
            axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true").catch(() => null),
            obtenerNoticiaBBC()
        ]);

        const hora = new Date().toLocaleTimeString("es-CO", { 
            timeZone: "America/Bogota", 
            hour: '2-digit', 
            minute: '2-digit', 
            hour12: true 
        });

        const temp = clim ? Math.round(clim.data.current_weather.temperature) : "27";

        let saludo = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 15 * 60 * 1000)) {
            saludo = `Especialmente para ${ultimoSaludo.nombre} que nos dice: ${ultimoSaludo.texto}.`;
        }

        // Prompt enriquecido para la IA
        const contextoIA = `
            Estás al aire en La Fronterísima. 
            Datos actuales:
            - Hora: ${hora}.
            - Clima en Cali: ${temp}°C.
            - Noticia del momento (BBC): ${bbc}.
            - Sonando ahora: ${np.titulo}.
            - ${saludo}
            
            Instrucción: Crea un guion corto (45 palabras), alegre y caleño. 
            Menciona la noticia de forma natural y sigue con la rumba.
        `;
        
        const guion = await redactarIA(contextoIA);
        const pathVoz = path.join(__dirname, `v_auto_${Date.now()}.mp3`);

        await generarVoz(guion, pathVoz);
        const exito = await producirYSubir(pathVoz, "dj_auto.mp3", true);

        if (exito) {
            ultimoSaludo.fecha = null;
            console.log("✅ Reporte con noticias BBC actualizado.");
        }

    } catch (e) {
        console.error("❌ Error en AutoReporte:", e.message);
    }
}

async function autoRedactorIA() {
    try {
        const guion = await redactarIA("Cuéntanos un dato curioso de un artista de salsa o un mensaje positivo para la gente de Cali.");
        const pathVoz = `v_red_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
        console.log("✅ Redactor_ia.mp3 actualizado.");
    } catch (e) { console.error("❌ Error AutoRedactor:", e.message); }
}

// ======= 6. RUTAS API =======

app.get("/health", (req, res) => res.status(200).send("OK"));

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.post("/redactar-guion", async (req, res) => {
    try {
        const guion = await redactarIA(`Guion alegre sobre: ${req.body.idea}`);
        res.json({ guion }); 
    } catch (e) { res.json({ guion: "¡Sintonizas La Fronterísima!" }); }
});

app.post("/procesar-locucion", async (req, res) => {
    const pathVoz = `v_man_${Date.now()}.mp3`;
    try {
        await generarVoz(req.body.texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", req.body.conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

// ======= 7. INICIO DEL SERVIDOR =======
const PORT = process.env.PORT || 8000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro activa en puerto ${PORT}`);
    
    // Ejecución inicial tras 10 segundos para no saturar el arranque
    setTimeout(() => {
        autoReporte().catch(() => {});
        autoRedactorIA().catch(() => {});
    }, 10000);

    setInterval(autoReporte, 15 * 60 * 1000);
    setInterval(autoRedactorIA, 50 * 60 * 1000);
});
