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
    AZURE: process.env.AZURE_SPEECH_KEY,
    AZURE_REGION: process.env.AZURE_REGION,
    AZURA: process.env.AZURA_KEY,
    STATION_ID: process.env.STATION_ID || "24",
    PASSWORD: process.env.APP_PASSWORD
};

const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`;

// ======= FRASES PRO =======
const FRASES = {
    ids: [
        "Estás en La Fronterísima, la que rompe fronteras",
        "La Fronterísima, más música más flow",
        "Desde Colombia para el mundo, La Fronterísima",
        "La Fronterísima, la que manda"
    ],
    transiciones: [
        "Seguimos sin parar",
        "Más éxitos vienen en camino",
        "Sube el volumen que esto se pone bueno",
        "No te despegues de La Fronterísima"
    ]
};

const randomDe = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ======= LOGIN =======
app.post('/login', (req, res) => {
    const { password } = req.body;

    if (!KEYS.PASSWORD) {
        return res.status(500).json({ error: "APP_PASSWORD no configurada" });
    }

    if (password === KEYS.PASSWORD) {
        return res.json({ success: true });
    }

    return res.status(401).json({ success: false, message: "Clave incorrecta" });
});

// ======= NOTICIAS =======
async function obtenerNoticia() {
    try {
        const res = await axios.get(
            "https://news.google.com/rss/search?q=Colombia&hl=es-419&gl=CO&ceid=CO:es-419"
        );

        const match = res.data.match(/<title>([^<]+)<\/title>/g);
        if (match && match.length > 2) {
            return match[2].replace(/<[^>]+>/g, "").split(" - ")[0];
        }

        return "Noticias en desarrollo en este momento.";
    } catch {
        return "Información en curso en Colombia.";
    }
}

// ======= IA =======
async function redactarIA(texto) {
    if (!texto) return randomDe(FRASES.ids);

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, {
            contents: [{ parts: [{ text: texto }] }]
        });

        return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || texto;
    } catch {
        return texto;
    }
}

// ======= VOZ AZURE =======
async function generarVoz(texto, archivo) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";

        const synth = new sdk.SpeechSynthesizer(config);

        const ssml = `
<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO">
  <voice name="es-CO-SalomeNeural">
    <mstts:express-as style="cheerful" xmlns:mstts="https://www.w3.org/2001/mstts">
      <prosody rate="+10%" pitch="+2%">
        ${texto}
      </prosody>
    </mstts:express-as>
  </voice>
</speak>`;

        synth.speakSsmlAsync(ssml,
            result => {
                fs.writeFileSync(archivo, Buffer.from(result.audioData));
                synth.close();
                resolve();
            },
            err => {
                synth.close();
                reject(err);
            }
        );
    });
}

// ======= PRODUCCIÓN + SUBIDA =======
async function producirYSubir(archivo, nombreFinal, conFondo) {
    const salida = `out_${Date.now()}.mp3`;
    const fondo = "fondo.mp3";

    return new Promise((resolve, reject) => {

        const cmd = (conFondo && fs.existsSync(fondo))
            ? `ffmpeg -y -i ${fondo} -i ${archivo} -filter_complex "[0:a]volume=0.08[bg];[1:a]volume=2.2[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${salida}`
            : `ffmpeg -y -i ${archivo} -af "volume=1.5" -c:a libmp3lame -b:a 128k ${salida}`;

        exec(cmd, async (err) => {
            if (err) return reject(err);

            try {
                const form = new FormData();
                form.append("file", fs.createReadStream(salida), nombreFinal);

                await axios.post(AZURA_API_UPLOAD, form, {
                    headers: {
                        ...form.getHeaders(),
                        "X-API-Key": KEYS.AZURA
                    }
                });

                if (fs.existsSync(archivo)) fs.unlinkSync(archivo);
                if (fs.existsSync(salida)) fs.unlinkSync(salida);

                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

// ======= AUTO RADIO =======
async function autoRadio() {
    console.log("🎙️ Generando radio...");

    try {
        const clima = await axios.get(
            "https://api.open-meteo.com/v1/forecast?latitude=4.71&longitude=-74.07&current_weather=true"
        );

        const noticia = await obtenerNoticia();

        const hora = new Date().toLocaleTimeString("es-CO", {
            timeZone: "America/Bogota",
            hour: "2-digit",
            minute: "2-digit"
        });

        const texto = `
${randomDe(FRASES.ids)}...

Son las ${hora} en Bogotá...
Temperatura actual ${Math.round(clima.data.current_weather.temperature)} grados...

Atención:
${noticia}...

${randomDe(FRASES.transiciones)}...
${randomDe(FRASES.ids)} 🔥
`;

        const voz = `voz_${Date.now()}.mp3`;

        await generarVoz(texto, voz);
        await producirYSubir(voz, "dj_auto.mp3", true);

        console.log("✅ Radio generada");
    } catch (e) {
        console.error("❌ Error:", e.message);
    }
}

// ======= ENDPOINT MANUAL =======
app.post("/locucion", async (req, res) => {
    try {
        const texto = await redactarIA(req.body.texto);
        const voz = `manual_${Date.now()}.mp3`;

        await generarVoz(texto, voz);
        await producirYSubir(voz, "manual.mp3", true);

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ======= HEALTH =======
app.get("/health", (req, res) => res.send("OK"));

// ======= SERVIDOR =======
const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
    console.log(`🔥 La Fronterísima PRO en puerto ${PORT}`);

    // Auto radio cada 15 min
    setTimeout(() => {
        autoRadio();
        setInterval(autoRadio, 15 * 60 * 1000);
    }, 60000);
});
