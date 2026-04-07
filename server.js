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
        "Desde Cali, la sucursal del cielo, informa La Fronterísima",
        "La Fronterísima, sonando fuerte en todo el planeta"
    ],
    transiciones: [
        "¡Sube el volumen!",
        "Seguimos con el flow en La Fronterísima",
        "No te despegues, la mejor programación está aquí",
        "La Fronterísima te acompaña siempre"
    ]
};

const randomDe = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ======= OBTENER NOTICIAS =======
async function obtenerNoticia() {
    try {
        const res = await axios.get("https://news.google.com/rss/search?q=Cali+Colombia&hl=es-419&gl=CO&ceid=CO:es-419", { timeout: 5000 });
        const match = res.data.match(/<title>([^<]+)<\/title>/g);
        if (match && match.length > 1) {
            return match[1].replace(/<[^>]+>/g, "").split(" - ")[0];
        }
        return "Noticias en desarrollo para el suroccidente colombiano.";
    } catch (e) {
        return "Sigue conectado para más información de actualidad.";
    }
}

// ======= REDACTAR CON IA =======
async function redactarIA(textoManual) {
    const prompt = textoManual || `Genera un saludo radial corto (máximo 20 palabras), con mucha energía de Cali, para la emisora La Fronterísima. No uses asteriscos ni negritas.`;

    try {
        if (KEYS.GEMINI) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
            const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 5000 });
            const result = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (result) return result.trim();
        }
    } catch (e) { console.warn("⚠️ Falló Gemini, intentando Groq..."); }

    try {
        if (KEYS.GROQ) {
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: "Eres una locutora estrella de Cali. Alegre y breve. No uses formatos de texto." },
                    { role: "user", content: prompt }
                ]
            }, { headers: { Authorization: `Bearer ${KEYS.GROQ}` }, timeout: 5000 });
            return res.data?.choices?.[0]?.message?.content || randomDe(FRASES.ids);
        }
    } catch (e) { console.error("⚠️ Error en IAs."); }

    return randomDe(FRASES.ids);
}

// ======= GENERAR VOZ (Azure con Limpieza) =======
async function generarVoz(texto, archivo) {
    return new Promise((resolve, reject) => {
        const textoLimpio = texto.replace(/[*#_<>]/g, '').replace(/\n/g, ' ').trim();
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
        config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16Khz128KBitrateMonoMp3;

        const synth = new sdk.SpeechSynthesizer(config);
        const ssml = `
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="es-CO">
  <voice name="es-CO-SalomeNeural">
    <mstts:express-as style="cheerful">
      <prosody rate="+8%" pitch="+2%"> ${textoLimpio} </prosody>
    </mstts:express-as>
  </voice>
</speak>`;

        synth.speakSsmlAsync(ssml, result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync(archivo, Buffer.from(result.audioData));
                synth.close();
                resolve();
            } else {
                synth.close();
                reject(`Azure Error: ${result.reason}`);
            }
        }, err => { synth.close(); reject(err); });
    });
}

// ======= FFMPEG Y SUBIDA (Corrección atrim/aresample) =======
async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const salida = `prod_${Date.now()}.mp3`;
    const fondo = path.join(__dirname, "fondo.mp3");

    return new Promise((resolve, reject) => {
        // Comando base (voz sola)
        let cmd = `ffmpeg -y -i ${archivoVoz} -af "volume=1.8" -c:a libmp3lame -b:a 128k ${salida}`;
        
        if (conFondo && fs.existsSync(fondo)) {
            // CORREGIDO: atrim para audio y aresample para unificar frecuencias
            cmd = `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.08,atrim=duration=25,aresample=44100[bg];[1:a]volume=2.2,aresample=44100[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${salida}`;
        }

        exec(cmd, async (err, stdout, stderr) => {
            if (err) {
                console.error("FFmpeg Error:", stderr);
                return reject(err);
            }
            try {
                const form = new FormData();
                form.append("file", fs.createReadStream(salida), nombreFinal);
                await axios.post(AZURA_API_UPLOAD, form, {
                    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }
                });
                resolve();
            } catch (e) { reject(e); }
            finally {
                if (fs.existsSync(archivoVoz)) fs.unlinkSync(archivoVoz);
                if (fs.existsSync(salida)) fs.unlinkSync(salida);
            }
        });
    });
}

// ======= AUTO RADIO =======
async function autoRadio() {
    console.log("⏳ Iniciando locución automática...");
    try {
        let climaInfo = "un clima agradable";
        try {
            const cRes = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true", { timeout: 3000 });
            if (cRes.data?.current_weather) {
                climaInfo = `${Math.round(cRes.data.current_weather.temperature)} grados`;
            }
        } catch (e) { console.warn("⚠️ Clima no disponible."); }

        const noticia = await obtenerNoticia();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" });
        const scriptIA = await redactarIA(); 
        
        const textoFinal = `${scriptIA}. Son las ${hora} en Cali. Temperatura de ${climaInfo}. En noticias: ${noticia}. ${randomDe(FRASES.transiciones)}`;

        const vozTmp = `auto_${Date.now()}.mp3`;
        await generarVoz(textoFinal, vozTmp);
        await producirYSubir(vozTmp, "dj_auto.mp3", true);

        console.log("✅ [AUTO] Locución actualizada en AzuraCast");
    } catch (e) { console.error("❌ Error en AutoRadio:", e.message || e); }
}

// ======= RUTAS =======
app.get("/health", (req, res) => res.send("OK"));

app.post("/locucion-manual", async (req, res) => {
    try {
        const textoIA = await redactarIA(req.body.texto);
        const vozTmp = `manual_${Date.now()}.mp3`;
        await generarVoz(textoIA, vozTmp);
        await producirYSubir(vozTmp, "manual.mp3", true);
        res.json({ ok: true, texto: textoIA });
    } catch (e) { res.status(500).json({ error: e.message || e }); }
});

// ======= SERVER =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`🔥 La Fronterísima PRO corriendo en puerto ${PORT}`);
    setTimeout(autoRadio, 30000); // Primer inicio a los 30 segundos
    setInterval(autoRadio, 15 * 60 * 1000); // Cada 15 min
});
