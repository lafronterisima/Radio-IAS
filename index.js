const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔥 VARIABLES (CONFIGURA ESTO)
const AZURE_KEY = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;

const WEATHER_KEY = process.env.WEATHER_KEY;
const NEWS_KEY = process.env.NEWS_KEY;

// 🌍 CIUDAD
const CITY = "Bogota,CO";

// 🔊 CONFIG VOZ AZURE
const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
speechConfig.speechSynthesisVoiceName = "es-CO-GonzaloNeural";

// 🟢 LOG INICIO
console.log("🚀 Servidor iniciado");

// 🧠 FUNCIÓN VOZ
async function generarVoz(texto) {
    return new Promise((resolve, reject) => {
        console.log("🎤 Generando voz...");

        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

        synthesizer.speakTextAsync(
            texto,
            result => {
                console.log("✅ Voz generada");
                resolve(result.audioData);
                synthesizer.close();
            },
            err => {
                console.error("❌ Error Azure:", err);
                synthesizer.close();
                reject(err);
            }
        );
    });
}

// 🌦 CLIMA
async function getWeather() {
    try {
        console.log("🌦 Obteniendo clima...");

        const url = `https://api.openweathermap.org/data/2.5/weather?q=${CITY}&appid=${WEATHER_KEY}&units=metric&lang=es`;

        const res = await axios.get(url);

        return `La temperatura actual es de ${Math.round(res.data.main.temp)} grados con ${res.data.weather[0].description}`;
    } catch (err) {
        console.error("❌ Error clima:", err.message);
        return "No se pudo obtener el clima";
    }
}

// 📰 NOTICIAS
async function getNews() {
    try {
        console.log("📰 Obteniendo noticias...");

        const url = `https://newsapi.org/v2/top-headlines?country=co&apiKey=${NEWS_KEY}`;

        const res = await axios.get(url);

        const headlines = res.data.articles.slice(0, 3).map(n => n.title);

        return "Noticias: " + headlines.join(". ");
    } catch (err) {
        console.error("❌ Error noticias:", err.message);
        return "No hay noticias disponibles";
    }
}

// 🕐 HORA
function getTime() {
    const now = new Date();

    return `Son las ${now.getHours()} y ${now.getMinutes()}`;
}

// 🎙 GENERAR AUDIO COMPLETO
app.get("/voz", async (req, res) => {
    try {
        console.log("📡 Generando boletín completo...");

        const hora = getTime();
        const clima = await getWeather();
        const noticias = await getNews();

        const texto = `${hora}. ${clima}. ${noticias}`;

        console.log("🧾 Texto:", texto);

        const audio = await generarVoz(texto);

        res.set({
            "Content-Type": "audio/wav"
        });

        res.send(Buffer.from(audio));
    } catch (err) {
        console.error("❌ ERROR GENERAL:", err);
        res.status(500).send("Error generando audio");
    }
});

// 🔍 ENDPOINT TEST
app.get("/status", (req, res) => {
    console.log("🔎 Status check");

    res.json({
        status: "ok",
        uptime: process.uptime(),
        time: new Date()
    });
});

// 🏠 HOME
app.get("/", (req, res) => {
    res.send("🎧 Radio IA funcionando");
});

// 🔴 ERROR GLOBAL
process.on("uncaughtException", (err) => {
    console.error("💥 ERROR GLOBAL:", err);
});

// 🚀 START
app.listen(PORT, () => {
    console.log(`🔥 Servidor corriendo en puerto ${PORT}`);
});
    
    
