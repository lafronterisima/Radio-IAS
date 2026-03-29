// 🚀 EXPRESS + AZURE VOZ REAL
const express = require("express");
const path = require("path");
const fs = require("fs");
const sdk = require("microsoft-cognitiveservices-speech-sdk");

const app = express();

// 🔐 ENV
const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;

// 🌐 HOME
app.get("/", (req, res) => {
    res.send("Radio IA activa 🎧");
});

// 🎙️ VOZ REAL (MEJORADO)
app.get("/voz", async (req, res) => {
    try {
        const texto = req.query.texto || "Hola, estás escuchando La Fronterísima";

        const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
        speechConfig.speechSynthesisVoiceName = "es-ES-ElviraNeural";

        // 🔥 archivo único (evita conflictos si hay varias peticiones)
        const fileName = `voz_${Date.now()}.mp3`;
        const filePath = path.join(__dirname, fileName);

        const audioConfig = sdk.AudioConfig.fromAudioFileOutput(filePath);
        const synth = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

        synth.speakTextAsync(
            texto,
            () => {
                synth.close();

                // 🎧 enviar audio
                res.setHeader("Content-Type", "audio/mpeg");
                res.sendFile(filePath, () => {
                    // 🧹 borrar archivo después de enviarlo
                    fs.unlink(filePath, () => {});
                });
            },
            (err) => {
                console.error("❌ Error Azure:", err);
                res.status(500).send("Error generando voz");
            }
        );

    } catch (err) {
        console.error("❌ Error general:", err.message);
        res.status(500).send("Error servidor");
    }
});

// 🚀 START SERVER
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log("🌐 Servidor activo en puerto", PORT);
});
