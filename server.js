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

// ======= CONFIGURACIÓN =======
const KEYS = {
    GEMINI: process.env.GOOGLE_API_KEY,
    GROQ: process.env.GROQ_API_KEY,
    AZURE: process.env.AZURE_SPEECH_KEY,
    AZURE_REGION: process.env.AZURE_REGION,
    AZURA: process.env.AZURA_KEY,
    STATION_ID: process.env.STATION_ID || "24",
    PASSWORD: process.env.APP_PASSWORD
};

const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;

const FRASES = {
    ids: [
        "Estás en La Fronterísima, la que rompe fronteras",
        "La Fronterísima, más música más flow",
        "Desde Cali, la capital de la alegría, informa La Fronterísima",
        "La Fronterísima, sonando fuerte en todo el mundo"
    ],
    transiciones: [
        "¡Sube el volumen!",
        "Seguimos con más éxitos aquí en La Fronterísima",
        "No te despegues, esto se pone bueno",
        "La Fronterísima te acompaña siempre"
    ]
};

const randomDe = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ======= OBTENER NOTICIAS (Validado) =======
async function obtenerNoticia() {
    try {
        const res = await axios.get("https://news.google.com/rss/search?q=Cali+Colombia&hl=es-419&gl=CO&ceid=CO:es-419", { timeout: 5000 });
        const match = res.data.match(/<title>([^<]+)<\/title>/g);
        if (match && match.length > 1) {
            // El match[0] suele ser el título del RSS, usamos el [1] o [2]
            return match[1].replace(/<[^>]+>/g, "").split(" - ")[0];
        }
        return "Noticias en desarrollo para todo el suroccidente colombiano.";
    } catch (e) {
        return "Sigue conectado para más información de actualidad.";
    }
}

// ======= REDACTAR CON IA (Gemini -> Groq -> Backup) =======
async function redactarIA(textoManual) {
    const prompt = textoManual || `Genera un saludo radial muy corto (15-20 palabras), con mucha energía de Cali, para la emisora La Fronterísima. No uses hashtags.`;

    // 1. Gemini
    try {
        if (KEYS.GEMINI) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
            const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 5000 });
            const result = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (result) return result.trim();
        }
    } catch (e) { console.warn("⚠️ Falló Gemini, saltando a Groq..."); }

    // 2. Groq
    try {
        if (KEYS.GROQ) {
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: "Eres una locutora estrella de Cali para la emisora La Fronterísima. Alegre y breve." },
                    { role: "user", content: prompt }
                ]
            }, { headers: { Authorization: `Bearer ${KEYS.GROQ}` }, timeout: 5000 });
            return res.data?.choices?.[0]?.message?.content || randomDe(FRASES.ids);
        }
    } catch (e) { console.error("⚠️ Falló Groq también."); }

    return randomDe(FRASES.ids);
}

// ======= GENERAR VOZ (Azure SSML) =======
async function generarVoz(texto, archivo) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
        const synth = new sdk.SpeechSynthesizer(config);

        const ssml = `
<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO">
  <voice name="es-CO-SalomeNeural">
    <mstts:express-as style="cheerful" xmlns:mstts="https://www.w3.org/2001/mstts">
      <prosody rate="+8%" pitch="+2%"> ${texto} </prosody>
    </mstts:express-as>
  </voice>
</speak>`;

        synth.speakSsmlAsync(ssml, result => {
            if (result.audioData) {
                fs.writeFileSync(archivo, Buffer.from(result.audioData));
                synth.close();
                resolve();
            } else {
                synth.close();
                reject("Fallo en audioData");
            }
        }, err => { synth.close(); reject(err); });
    });
}

// ======= FFMPEG Y SUBIDA (Con Limpieza Total) =======
async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const salida = `prod_${Date.now()}.mp3`;
    const fondo = path.join(__dirname, "fondo.mp3");

    return new Promise((resolve, reject) => {
        let cmd = `ffmpeg -y -i ${archivoVoz} -af "volume=1.8" -c:a libmp3lame -b:a 128k ${salida}`;
        
        if (conFondo && fs.existsSync(fondo)) {
            cmd = `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.08,trim=duration=25[bg];[1:a]volume=2.2[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${salida}`;
        }

        exec(cmd, async (err) => {
            if (err) return reject(err);
            try {
                const form = new FormData();
                form.append("file", fs.createReadStream(salida), nombreFinal);
                await axios.post(AZURA_API_UPLOAD, form, {
                    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }
                });
                resolve();
            } catch (e) {
                reject(e);
            } finally {
                // Borrar siempre los archivos para evitar llenar el disco
                if (fs.existsSync(archivoVoz)) fs.unlinkSync(archivoVoz);
                if (fs.existsSync(salida)) fs.unlinkSync(salida);
            }
        });
    });
}

// ======= AUTO RADIO (Cali) =======
async function autoRadio() {
    console.log("⏳ Iniciando proceso de locución automática...");
    try {
        // Clima con validación de error
        let climaInfo = "un clima agradable";
        try {
            const cRes = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true", { timeout: 3000 });
            if (cRes.data?.current_weather) {
                climaInfo = `${Math.round(cRes.data.current_weather.temperature)} grados centígrados`;
            }
        } catch (e) { console.warn("⚠️ Clima no disponible."); }

        const noticia = await obtenerNoticia();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" });

        const script = `
        ${randomDe(FRASES.ids)}. 
        En Cali son las ${hora}. 
        Estamos a ${climaInfo}. 
        Lo más reciente: ${noticia}. 
        ${randomDe(FRASES.transiciones)}.`;

        const vozTmp = `auto_${Date.now()}.mp3`;
        await generarVoz(script, vozTmp);
        await producirYSubir(vozTmp, "dj_auto.mp3", true);

        console.log("✅ Locución automática actualizada con éxito.");
    } catch (e) {
        console.error("❌ Error en AutoRadio:", e.response?.data || e.message || e);
    }
}

// ======= RUTAS API =======
app.get("/health", (req, res) => res.send("La Fronterísima OK"));

app.post("/locucion-manual", async (req, res) => {
    try {
        const textoIA = await redactarIA(req.body.texto);
        const vozTmp = `manual_${Date.now()}.mp3`;
        await generarVoz(textoIA, vozTmp);
        await producirYSubir(vozTmp, "manual.mp3", true);
        res.json({ ok: true, texto: textoIA });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// ======= SERVER =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`🔥 La Fronterísima PRO corriendo en puerto ${PORT}`);
    
    // Primera ejecución tras 1 minuto para dar tiempo al servidor de estabilizarse
    setTimeout(autoRadio, 60000);
    
    // Intervalo de 15 minutos
    setInterval(autoRadio, 15 * 60 * 1000);
});
