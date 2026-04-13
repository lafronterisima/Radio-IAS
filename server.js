require('dotenv').config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const Groq = require("groq-sdk");
const textToSpeech = require('@google-cloud/text-to-speech');

const app = express();
app.use(express.json());

// ======= CONFIG =======
const KEYS = {
    AZURA: process.env.AZURA_KEY?.trim(),
    STATION_ID: process.env.STATION_ID || "24",
    GROQ: process.env.GROQ_API_KEY?.trim(),
    GOOGLE_CREDS: process.env.GOOGLE_CREDS 
};

const groq = new Groq({ apiKey: KEYS.GROQ });

// ======= VOZ (GOOGLE CLOUD TTS) =======
async function generarVozGoogle(texto, archivoDestino) {
    try {
        console.log("🎙️ Solicitando voz a Google Cloud...");
        
        const credentials = JSON.parse(KEYS.GOOGLE_CREDS);
        const client = new textToSpeech.TextToSpeechClient({ credentials });

        const request = {
            input: { text: texto },
            // CORRECCIÓN: Se usa Wavenet-A porque Neural2 no existe para es-CO
            voice: { 
                languageCode: 'es-CO', 
                name: 'es-CO-Wavenet-A' 
            },
            audioConfig: { 
                audioEncoding: 'MP3', 
                pitch: 0, 
                speakingRate: 1.05 // Un toque más de energía para radio
            },
        };

        const [response] = await client.synthesizeSpeech(request);
        fs.writeFileSync(archivoDestino, response.audioContent, 'binary');
        console.log("✅ Audio generado exitosamente");
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
                { 
                    role: "system", 
                    content: "Eres la voz oficial de la emisora La Fronterísima. Tono profesional, alegre, cálido y muy colombiano. Sé breve (máximo 30 palabras)." 
                },
                { role: "user", content: prompt }
            ],
            model: "llama-3.3-70b-versatile",
        });
        return completion.choices[0]?.message?.content || "Sintonizas La Fronterísima, la emisora que te mueve.";
    } catch (e) {
        return "Estás en sintonía de La Fronterísima, música y alegría.";
    }
}

// ======= AZURACAST (SUBIDA) =======
async function subirAAzura(archivoLocal) {
    try {
        const form = new FormData();
        form.append('file', fs.createReadStream(archivoLocal), { filename: 'locucion_ia.mp3' });

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

        console.log("✅ Locución subida a AzuraCast");
        if (fs.existsSync(archivoLocal)) fs.unlinkSync(archivoLocal);
    } catch (e) {
        console.error("❌ Error subida Azura:", e.message);
    }
}

// ======= CICLO DE RADIO =======
async function ejecutarCiclo() {
    console.log("⏰ Iniciando ciclo automático...");
    
    const hora = new Date().toLocaleTimeString("es-CO", {
        timeZone: "America/Bogota",
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });

    const texto = await redactarIA(`Saluda con energía y menciona que son las ${hora} en La Fronterísima.`);
    const tempMP3 = path.join(__dirname, `locucion_${Date.now()}.mp3`);

    try {
        await generarVozGoogle(texto, tempMP3);
        await subirAAzura(tempMP3);
    } catch (e) {
        console.error("🚨 Fallo crítico en el ciclo:", e.message);
    }
}

// ======= SERVER =======
app.get('/health', (req, res) => res.send("Servidor de Radio Activo"));

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor de Locución IA en puerto ${PORT}`);
    
    // Pequeño delay inicial para asegurar que el sistema está listo
    setTimeout(ejecutarCiclo, 5000);
    
    // Programación cada 15 minutos
    setInterval(ejecutarCiclo, 15 * 60 * 1000);
});
