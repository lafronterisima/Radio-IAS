 
// 馃敟 EXPRESS SERVER (REEMPLAZA http.createServer)
const express = require("express");
const path = require("path");
const app = express();

// 馃寪 HOME
app.get("/", (req, res) => {
    res.send("Radio IA activa 馃帶");
});

// 馃帣锔� VOZ REAL AZURE PARA WEB
app.get("/voz", async (req, res) => {
    try {
        const texto = req.query.texto || "Hola, est谩s escuchando La Fronter铆sima";

        const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
        speechConfig.speechSynthesisVoiceName = "es-ES-ElviraNeural";

        const filePath = path.join(__dirname, "voz_web.mp3");

        const audioConfig = sdk.AudioConfig.fromAudioFileOutput(filePath);
        const synth = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

        synth.speakTextAsync(
            texto,
            () => {
                synth.close();
                res.sendFile(filePath);
            },
            (err) => {
                console.error("鉂� Error Azure:", err);
                res.status(500).send("Error generando voz");
            }
        );

    } catch (err) {
        console.error("鉂� Error general:", err.message);
        res.status(500).send("Error servidor");
    }
});

// 馃殌 START SERVER
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log("馃寪 Servidor activo en puerto", PORT);
});
