require('dotenv').config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const TelegramBot = require('node-telegram-bot-api');
const Groq = require("groq-sdk");
const textToSpeech = require('@google-cloud/text-to-speech'); // Google TTS

const app = express();
app.use(express.json());

// ======= CONFIG =======
const KEYS = {
    AZURA: process.env.AZURA_KEY?.trim(),
    STATION_ID: process.env.STATION_ID || "24",
    GROQ: process.env.GROQ_API_KEY?.trim(),
    TELEGRAM: process.env.TELEGRAM_TOKEN?.trim(),
    // Aquí pegas el contenido del JSON de tu Service Account
    GOOGLE_CREDS: process.env.GOOGLE_CREDS 
};

const groq = new Groq({ apiKey: KEYS.GROQ });

// ======= VOZ (GOOGLE CLOUD TTS) =======
async function generarVozGoogle(texto, archivoDestino) {
    try {
        console.log("🎙️ Solicitando voz a Google Cloud...");
        
        // Parseamos las credenciales desde la variable de entorno
        const credentials = JSON.parse(KEYS.GOOGLE_CREDS);
        const client = new textToSpeech.TextToSpeechClient({ credentials });

        const request = {
            input: { text: texto },
            // Voz 'Neural2-A' es la más avanzada para Colombia (Salomé-like)
            voice: { languageCode: 'es-CO', name: 'es-CO-Neural2-A' },
            audioConfig: { audioEncoding: 'MP3', pitch: 0, speakingRate: 1.0 },
        };

        const [response] = await client.synthesizeSpeech(request);
        
        // Guardamos el buffer directamente como MP3
        fs.writeFileSync(archivoDestino, response.audioContent, 'binary');
        console.log("✅ Audio generado por Google Cloud");
    } catch (e) {
        console.error("❌ Error en Google TTS:", e.message);
        throw e;
    }
}

// ======= IA (REDACCIÓN) =======
async function redactarIA(prompt) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "Eres la voz oficial de La Fronterísima. Tono profesional, alegre y colombiano. Sé breve (máximo 35 palabras)." },
                { role: "user", content: prompt }
            ],
            model: "llama-3.3-70b-versatile",
        });
        return completion.choices[0]?.message?.content || "La Fronterísima, conectando tus sentidos.";
    } catch (e) {
        return "Sintonizas La Fronterísima en Pereira y el mundo.";
    }
}

// ======= AZURACAST (SUBIDA) =======
async function subirAAzura(archivoLocal) {
    try {
        const form = new FormData();
        // Nota: Google entrega MP3, así que lo subimos con extensión .mp3
        form.append('file', fs.createReadStream(archivoLocal), { filename: 'dj_google.mp3' });

        await axios.post(
            `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}/files/upload`,
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    "X-API-Key": KEYS.AZURA
                }
            }
        );

        console.log("✅ Subido a AzuraCast");
        if (fs.existsSync(archivoLocal)) fs.unlinkSync(archivoLocal);
    } catch (e) {
        console.error("❌ Error subida:", e.message);
    }
}

// ======= CICLO DE RADIO =======
async function ejecutarCiclo() {
    console.log("⏰ Iniciando ciclo automático (Google TTS)...");
    
    const hora = new Date().toLocaleTimeString("es-CO", {
        timeZone: "America/Bogota",
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });

    const texto = await redactarIA(`Saluda y di que son las ${hora} en La Fronterísima.`);
    const tempMP3 = path.join(__dirname, `google_voice_${Date.now()}.mp3`);

    try {
        await generarVozGoogle(texto, tempMP3);
        await subirAAzura(tempMP3);
    } catch (e) {
        console.error("🚨 Fallo en el ciclo:", e.message);
    }
}

// ======= BOOT / SERVER =======
app.get('/health', (req, res) => res.send("OK"));

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor Google TTS activo en puerto ${PORT}`);
    
    // Ejecutar primer locución a los 5 segundos
    setTimeout(ejecutarCiclo, 5000);
    // Repetir cada 15 minutos
    setInterval(ejecutarCiclo, 15 * 60 * 1000);
});
