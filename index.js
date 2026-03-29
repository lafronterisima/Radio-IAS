 
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");

const app = express();

// 🔓 PERMITIR CONEXIÓN DESDE TU WEB
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});


// 🎵 CANCIÓN ACTUAL (AZURACAST)
app.get("/song", async (req, res) => {
  try {
    const response = await axios.get(
      "https://az.azurafree.eu/api/nowplaying/la_fronterisima"
    );
    res.json(response.data);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Error obteniendo canción" });
  }
});


// 🌤️ CLIMA (CALI)
app.get("/weather", async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true"
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Error clima" });
  }
});


// 📰 NOTICIAS (RSS)
app.get("/news", async (req, res) => {
  try {
    const response = await axios.get(
      "https://feeds.bbci.co.uk/mundo/rss.xml"
    );
    res.send(response.data);
  } catch (error) {
    res.status(500).send("Error noticias");
  }
});


// 🔊 VOZ IA (AZURE)
app.get("/voz", async (req, res) => {

  const texto = req.query.texto;

  if (!texto) {
    return res.status(400).send("Texto requerido");
  }

  try {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.AZURE_KEY,
      process.env.AZURE_REGION
    );

    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    synthesizer.speakTextAsync(
      texto,
      result => {
        res.setHeader("Content-Type", "audio/mpeg");
        res.send(Buffer.from(result.audioData));
      },
      err => {
        console.error(err);
        res.status(500).send("Error voz");
      }
    );

  } catch (error) {
    res.status(500).send("Error servidor voz");
  }
});


// 🚀 INICIAR SERVIDOR
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🔥 Backend IA Radio activo en puerto " + PORT);
});