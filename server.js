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

// ======= 1. CONFIGURACIÓN Y LLAVES =======
const KEYS = {
    GEMINI: process.env.GOOGLE_API_KEY,
    GROQ: process.env.GROQ_API_KEY,
    AZURE: process.env.AZURE_SPEECH_KEY,
    AZURE_REGION: process.env.AZURE_REGION,
    AZURA: process.env.AZURA_KEY,
    STATION_ID: process.env.STATION_ID || "24",
    PASSWORD: process.env.APP_PASSWORD,
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    URL_APP: process.env.URL_APP || `https://indirect-kelsi-lafronterisima-c6a755f2.koyeb.app`
};

const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;

// ======= 2. INTEGRACIÓN TELEGRAM =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
let ultimoSaludo = { nombre: "", texto: "", fecha: null };

bot.on('message', (msg) => {
    if (msg.text && !msg.text.startsWith('/')) {
        ultimoSaludo = {
            nombre: msg.from.first_name || "un oyente",
            texto: msg.text,
            fecha: new Date()
        };
        console.log(`📩 Saludo de Telegram guardado: ${ultimoSaludo.nombre}`);
        bot.sendMessage(msg.chat.id, "¡Recibido! Tu saludo saldrá al aire pronto en La Fronterísima. 🎙️");
    }
});

// Manejo de errores de Telegram
bot.on('polling_error', (error) => {
    console.error('Error en polling de Telegram:', error.message);
});

// ======= 3. FUNCIONES DE DATOS =======

async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`https://az.azurafree.eu/api/nowplaying/${KEYS.STATION_ID}`, { 
            timeout: 4000 
        });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios artistas", titulo: "la mejor música" };
    } catch (e) {
        console.error("Error obteniendo ahora suena:", e.message);
        return { artista: "varios artistas", titulo: "tu música favorita" };
    }
}

async function obtenerNoticiasBBC() {
    try {
        const res = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml", { timeout: 5000 });
        
        // Método más robusto para extraer noticias
        const items = res.data.match(/<item>.*?<title>(.*?)<\/title>.*?<\/item>/gs);
        
        if (items && items.length >= 2) {
            const titulos = items.slice(0, 2).map(item => {
                const match = item.match(/<title>(.*?)<\/title>/);
                if (match) {
                    return match[1]
                        .replace(/<!\[CDATA\[|\]\]>/g, '')
                        .replace(/<[^>]*>/g, '')
                        .trim();
                }
                return '';
            }).filter(t => t.length > 0);
            
            if (titulos.length === 2) {
                return `${titulos[0]}. Además: ${titulos[1]}`;
            }
        }
        return "El mundo sigue vibrando con la mejor energía.";
    } catch (e) { 
        console.error("Error BBC:", e.message);
        return "Sigue en sintonía para más información."; 
    }
}

// ======= 4. INTELIGENCIA ARTIFICIAL =======

async function redactarIA(prompt) {
    // Intentar primero con Gemini
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { 
            contents: [{ parts: [{ text: prompt }] }] 
        }, { timeout: 6000 });
        
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
    } catch (e) {
        console.log("Gemini falló, intentando con Groq...");
    }
    
    // Fallback a Groq
    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: "Eres Salomé, locutora colombiana estrella de La Fronterísima. Tono alegre, rumbero y profesional. Respuestas cortas y directas." }, 
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 200
        }, { 
            headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, 
            timeout: 6000 
        });
        
        const texto = res.data?.choices?.[0]?.message?.content;
        if (texto) return limpiarTexto(texto);
    } catch (err) {
        console.error("Error en ambas IAs:", err.message);
    }
    
    // Respuesta de emergencia
    return "Sintonizas La Fronterísima, notas surcando fronteras. ¡La mejor música para ti!";
}

function limpiarTexto(t) {
    if (!t) return "Bienvenidos a La Fronterísima.";
    return t
        .replace(/[*#_~`]/g, '')
        .replace(/Locutor:|Guion:|Respuesta:|Locutora:|AI:|Assistant:/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ======= 5. VOZ Y PRODUCCIÓN =======

async function generarVoz(texto, archivoDestino) {
    const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
    config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
    const synth = new sdk.SpeechSynthesizer(config);
    
    try {
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural">
                <mstts:express-as style="cheerful" styledegree="1.4">
                    <prosody rate="+8%" pitch="+5%">${texto}</prosody>
                </mstts:express-as>
            </voice>
        </speak>`;
        
        return new Promise((resolve, reject) => {
            synth.speakSsmlAsync(ssml, r => {
                if (r.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                    try {
                        fs.writeFileSync(archivoDestino, Buffer.from(r.audioData));
                        resolve();
                    } catch (writeError) {
                        reject(`Error escribiendo archivo: ${writeError.message}`);
                    }
                } else {
                    reject(`Error TTS: ${sdk.ResultReason[r.reason] || r.reason}`);
                }
            }, e => {
                reject(`Error síntesis de voz: ${e.message || e}`);
            });
        });
    } finally {
        // CRÍTICO: Siempre cerrar el sintetizador para evitar memory leaks
        try {
            synth.close();
        } catch (closeError) {
            console.error("Error cerrando sintetizador:", closeError.message);
        }
    }
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondoExiste = fs.existsSync("fondo.mp3");
    
    // Función de limpieza reutilizable
    const limpiar = () => {
        try {
            if(fs.existsSync(archivoVoz)) fs.unlinkSync(archivoVoz);
            if(fs.existsSync(tempSalida)) fs.unlinkSync(tempSalida);
        } catch (e) {
            console.error("Error limpiando archivos temporales:", e.message);
        }
    };

    return new Promise((resolve, reject) => {
        let cmd;
        
        if (conFondo && fondoExiste) {
            // Mezclar con música de fondo
            cmd = `ffmpeg -y -i fondo.mp3 -i ${archivoVoz} -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.8,adelay=500|500[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`;
        } else {
            // Solo voz con normalización
            cmd = `ffmpeg -y -i ${archivoVoz} -af "volume=1.6,loudnorm=I=-16:LRA=11:TP=-1.5" -c:a libmp3lame -b:a 128k ${tempSalida}`;
        }
        
        exec(cmd, { timeout: 30000 }, async (err, stdout, stderr) => {
            if (err) {
                console.error("Error FFmpeg:", stderr);
                limpiar();
                return reject(`FFmpeg Error: ${err.message}`);
            }
            
            try {
                // Verificar que el archivo se creó correctamente
                if (!fs.existsSync(tempSalida)) {
                    throw new Error("FFmpeg no generó el archivo de salida");
                }
                
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                form.append('path', nombreFinal);
                
                await axios.post(AZURA_API_UPLOAD, form, { 
                    headers: { 
                        ...form.getHeaders(), 
                        "X-API-Key": KEYS.AZURA 
                    },
                    timeout: 15000,
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                });
                
                limpiar();
                console.log(`✅ Archivo ${nombreFinal} subido exitosamente a Azura`);
                resolve();
            } catch (e) {
                console.error("Error subiendo a Azura:", e.message);
                limpiar();
                reject(`Error Azura: ${e.message}`);
            }
        });
    });
}

// ======= 6. AUTOMATIZACIONES =======

async function autoReporte() {
    console.log("🎙️ Iniciando auto reporte...");
    try {
        const [climaRes, bbc, np] = await Promise.all([
            axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true", { timeout: 5000 })
                .catch(() => ({ data: { current_weather: { temperature: 25 } } })),
            obtenerNoticiasBBC(),
            obtenerAhoraSuena()
        ]);
        
        const hora = new Date().toLocaleTimeString("es-CO", { 
            timeZone: "America/Bogota", 
            hour: '2-digit', 
            minute: '2-digit', 
            hour12: true 
        });
        
        const temperatura = Math.round(climaRes.data.current_weather.temperature);
        
        // Integración del saludo de Telegram
        let mencionSaludo = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            mencionSaludo = `MENSAJE DE OYENTE (Telegram): ${ultimoSaludo.nombre} dice "${ultimoSaludo.texto}". Mándale un saludo rumbero y especial.`;
        }

        const prompt = `Eres Salomé, locutora estrella de La Fronterísima. 
        
        DATOS DEL MOMENTO:
        - Hora actual: ${hora}
        - Música sonando: "${np.titulo}" de ${np.artista}
        - Temperatura en Cali: ${temperatura}°C
        - Noticias BBC: ${bbc}
        ${mencionSaludo}
        
        INSTRUCCIONES:
        1. Guion de 55-60 palabras máximo
        2. Menciona la hora PRIMERO (obligatorio)
        3. Comenta la canción que suena
        4. Menciona el clima de ${temperatura}°C en Cali
        5. Incluye un resumen breve de noticias
        6. ${ultimoSaludo.fecha ? 'LEE EL SALUDO DEL OYENTE CON ALEGRÍA' : 'Anima a enviar saludos por Telegram'}
        7. Termina con: "La Fronterísima, notas surcando fronteras"
        
        SOLO TEXTO DEL GUIÓN, SIN ACOTACIONES.`;

        const guion = await redactarIA(prompt);
        console.log("📝 Guion generado:", guion);
        
        await generarVoz(guion, "v_auto.mp3");
        await producirYSubir("v_auto.mp3", "dj_auto.mp3", true);
        
        // Limpiar saludo usado
        if (ultimoSaludo.fecha) {
            ultimoSaludo.fecha = null;
            console.log("✅ Saludo de Telegram procesado y limpiado");
        }
        
        console.log("✅ dj_auto.mp3 actualizado exitosamente");
    } catch (e) { 
        console.error("❌ Error en AutoReporte:", e.message); 
    }
}

async function autoContenidoCreativo() {
    console.log("🎨 Generando contenido creativo...");
    const temas = [
        "un dato curioso sobre música colombiana",
        "un mensaje positivo para empezar el día con energía",
        "una historia breve de un artista de salsa o vallenato",
        "un tip para disfrutar mejor la música",
        "una frase motivadora sobre la vida y la música"
    ];
    const tema = temas[Math.floor(Math.random() * temas.length)];
    const prompt = `Eres Salomé de La Fronterísima. 
    Genera una locución breve de 35-40 palabras sobre ${tema}. 
    Tono alegre, rumbero y motivador. 
    Incluye al final: "La Fronterísima, notas surcando fronteras".
    SOLO TEXTO DEL GUIÓN.`;
    
    try {
        const guion = await redactarIA(prompt);
        console.log("📝 Guion creativo:", guion);
        
        await generarVoz(guion, "v_crea.mp3");
        await producirYSubir("v_crea.mp3", "Redactor_ia.mp3", true);
        console.log(`✅ Contenido creativo subido: ${tema}`);
    } catch (e) { 
        console.error("❌ Error en Contenido Creativo:", e.message); 
    }
}

// ======= 7. RUTAS DEL FRONTEND =======

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === KEYS.PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Clave incorrecta" });
    }
});

app.post("/redactar-guion", async (req, res) => {
    try {
        const { idea } = req.body;
        const prompt = `Eres Salomé, locutora de La Fronterísima. Redacta un guion breve (40 palabras máximo) sobre: ${idea}. Tono rumbero, alegre y profesional. Incluye el eslogan. SOLO TEXTO.`;
        const guion = await redactarIA(prompt);
        res.json({ guion });
    } catch (e) {
        console.error("Error en redactar-guion:", e.message);
        res.status(500).json({ error: "Error al redactar el guion" });
    }
});

app.post("/procesar-locucion", async (req, res) => {
    const { texto, conFondo } = req.body;
    
    if (!texto || texto.length < 10) {
        return res.status(400).send("El texto es muy corto");
    }
    
    const pathVoz = `v_manual_${Date.now()}.mp3`;
    try {
        console.log("🎤 Procesando locución manual...");
        await generarVoz(texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", conFondo);
        res.json({ success: true, message: "Locución procesada y subida exitosamente" });
    } catch (e) {
        console.error("Error en locución manual:", e.message);
        res.status(500).json({ error: "Error en la producción manual" });
    }
});

app.get("/estado", (req, res) => {
    res.json({
        status: "online",
        ultimoSaludo: ultimoSaludo.nombre || "Ninguno",
        timestamp: new Date().toISOString()
    });
});

// ======= 8. WEBHOOK DE AZURA Y HEALTH CHECK =======

app.get("/health", (req, res) => {
    res.status(200).json({ 
        status: "OK", 
        timestamp: new Date().toISOString(),
        service: "La Fronterísima AI"
    });
});

app.post("/azura-event", async (req, res) => {
    console.log("📻 Evento de AzuraCast recibido:", req.body?.event || "manual");
    
    // Responder inmediatamente para no bloquear a Azura
    res.sendStatus(200);
    
    // Ejecutar en background
    setImmediate(() => {
        autoReporte().catch(e => console.error("Error en autoReporte por webhook:", e));
    });
});

// Ruta para forzar actualización manual (debug)
app.post("/forzar-reporte", async (req, res) => {
    const { password } = req.body;
    if (password !== KEYS.PASSWORD) {
        return res.status(401).json({ error: "No autorizado" });
    }
    
    res.json({ message: "Generando reporte en background..." });
    setImmediate(() => {
        autoReporte().catch(console.error);
    });
});

// ======= 9. INICIO DEL SERVIDOR =======

const PORT = process.env.PORT || 8000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║  🎙️  LA FRONTERÍSIMA AI - ONLINE  🎙️  ║
    ╠════════════════════════════════════════╣
    ║  Puerto: ${PORT}                         ║
    ║  Estación: ${KEYS.STATION_ID}            ║
    ║  Telegram: ${KEYS.TELEGRAM_TOKEN ? '✅' : '❌'}                          ║
    ║  Azure TTS: ${KEYS.AZURE ? '✅' : '❌'}                          ║
    ╚════════════════════════════════════════╝
    `);
    
    // Iniciar automatizaciones
    console.log("⏰ Configurando automatizaciones...");
    
    // Primer reporte a los 10 segundos
    setTimeout(() => {
        console.log("🎬 Iniciando primer reporte...");
        autoReporte().catch(console.error);
    }, 10000);
    
    // Reportes cada 15 minutos
    setInterval(() => {
        console.log("⏲️ Ejecutando reporte programado...");
        autoReporte().catch(console.error);
    }, 15 * 60 * 1000);
    
    // Primer contenido creativo a los 30 segundos
    setTimeout(() => {
        console.log("🎨 Iniciando contenido creativo...");
        autoContenidoCreativo().catch(console.error);
    }, 30000);
    
    // Contenido creativo cada 50 minutos
    setInterval(() => {
        console.log("⏲️ Ejecutando contenido creativo programado...");
        autoContenidoCreativo().catch(console.error);
    }, 50 * 60 * 1000);
    
    console.log("✅ Sistema listo y automatizaciones configuradas");
});

// Manejo graceful shutdown
process.on('SIGTERM', () => {
    console.log('📴 Recibida señal SIGTERM, cerrando gracefully...');
    bot.stopPolling();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('📴 Recibida señal SIGINT, cerrando gracefully...');
    bot.stopPolling();
    process.exit(0);
});

// Capturar errores no manejados
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesa rechazada no manejada:', reason);
});
