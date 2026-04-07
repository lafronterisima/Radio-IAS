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

// ======= CONFIG =======
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

// ======= FRASES =======
const FRASES = {
    ids: [
        "Estás en La Fronterísima, la que rompe fronteras",
        "La Fronterísima, más música más flow",
        "Desde Cali para el mundo, La Fronterísima",
        "La Fronterísima, la que manda en el dial"
    ],
    transiciones: [
        "Seguimos con más éxitos",
        "Sube el volumen, esto es La Fronterísima",
        "No te despegues, la mejor programación está aquí"
    ]
};

const randomDe = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ======= NOTICIAS (Mejorado para Cali/Colombia) =======
async function obtenerNoticia() {
    try {
        // Buscamos específicamente noticias de Cali y Colombia
        const res = await axios.get("https://news.google.com/rss/search?q=Cali+Colombia&hl=es-419&gl=CO&ceid=CO:es-419", { timeout: 5000 });
        const match = res.data.match(/<title>([^<]+)<\/title>/g);
        // Saltamos el primer título que suele ser el nombre de la búsqueda
        return match?.[1]?.replace(/<[^>]+>/g, "").split(" - ")[0] || "Actualidad en desarrollo para nuestra gente.";
    } catch {
        return "Sigue conectado con la mejor información en La Fronterísima.";
    }
}

// ======= IA (GEMINI → GROQ FALLBACK) =======
async function redactarIA(textoManual) {
    const promptBase = textoManual || `Genera un saludo radial muy breve (máximo 20 palabras), con mucha energía colombiana para la emisora "La Fronterísima".`;

    // 1. Intento con Gemini
    try {
        if (KEYS.GEMINI) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
            const res = await axios.post(url, {
                contents: [{ parts: [{ text: promptBase }] }]
            }, { timeout: 5000 });
            const result = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (result) return result.trim();
        }
    } catch (e) { console.warn("⚠️ Gemini Offline, intentando Groq..."); }

    // 2. Fallback Groq
    try {
        if (KEYS.GROQ) {
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: "Eres una locutora de Cali, Colombia, para la emisora La Fronterísima. Eres enérgica y alegre." },
                    { role: "user", content: promptBase }
                ]
            }, { headers: { Authorization: `Bearer ${KEYS.GROQ}` }, timeout: 5000 });
            return res.data?.choices?.[0]?.message?.content || randomDe(FRASES.ids);
        }
    } catch (e) { console.error("❌ Error en IAs"); }

    return randomDe(FRASES.ids);
}

// ======= VOZ (AZURE) =======
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
                reject("Error en síntesis de voz");
            }
        }, err => { synth.close(); reject(err); });
    });
}

// ======= FFMPEG Y UPLOAD =======
async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const salida = `prod_${Date.now()}.mp3`;
    const fondoPath = path.join(__dirname, "fondo.mp3");

    return new Promise((resolve, reject) => {
        let cmd = `ffmpeg -y -i ${archivoVoz} -af "volume=1.8" -c:a libmp3lame -b:a 128k ${salida}`;
        
        if (conFondo && fs.existsSync(fondoPath)) {
            cmd = `ffmpeg -y -i ${fondoPath} -i ${archivoVoz} -filter_complex "[0:a]volume=0.1,trim=duration=20[bg];[1:a]volume=2.0[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${salida}`;
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
            } catch (e) { reject(e); }
            finally {
                // Limpieza de temporales
                if (fs.existsSync(archivoVoz)) fs.unlinkSync(archivoVoz);
                if (fs.existsSync(salida)) fs.unlinkSync(salida);
            }
        });
    });
}

// ======= AUTO RADIO (Cali) =======
async function autoRadio() {
    try {
        // Coordenadas de Cali: 3.45, -76.53
        const climaRes = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const noticia = await obtenerNoticia();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" });

        const textoScript = `
        ${randomDe(FRASES.ids)}. 
        En Cali son las ${hora}. 
        Tenemos un clima de ${Math.round(climaRes.data.current_weather.temperature)} grados. 
        En noticias: ${noticia}. 
        ${randomDe(FRASES.transiciones)}.`;

        const vozTmp = `voz_auto_${Date.now()}.mp3`;
        await generarVoz(textoScript, vozTmp);
        await producirYSubir(vozTmp, "dj_auto.mp3", true);
        console.log("✅ [AUTO] Locución actualizada en AzuraCast");
    } catch (e) { console.error("❌ Error en AutoRadio:", e.message); }
}

// ======= RUTAS =======
app.post("/locucion-manual", async (req, res) => {
    try {
        const textoIA = await redactarIA(req.body.texto);
        const vozTmp = `voz_man_${Date.now()}.mp3`;
        await generarVoz(textoIA, vozTmp);
        await producirYSubir(vozTmp, "Redactor_ia.mp3", true);
        res.json({ ok: true, texto: textoIA });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (req, res) => res.send("La Fronterísima is Live 🎧"));

// ======= INICIO =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    // Ejecutar al minuto de encender y luego cada 15 min
    setTimeout(autoRadio, 60000);
    setInterval(autoRadio, 15 * 60 * 1000);
});
