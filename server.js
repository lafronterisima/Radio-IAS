 
      require('dotenv').config();
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const { exec } = require("child_process");
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const FormData = require("form-data");

const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Configuración de Estación
const STATION_ID = "24"; 
const AZURA_API = `https://az.azurafree.eu/api/station/${STATION_ID}/files`;

// --- 1. OBTENER DATOS REALES ---
async function obtenerDatos() {
    try {
        // Hora, Clima de Cali y Noticias BBC
        const ahora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit' });
        const weather = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const rss = await parser.parseURL('https://feeds.bbci.co.uk/mundo/rss.xml');
        
        return {
            hora: ahora,
            temp: Math.round(weather.data.current_weather.temperature),
            noticia: rss.items[0].title
        };
    } catch (e) {
        return { hora: "al momento", temp: "agradable", noticia: "Sigue la mejor música." };
    }
}

// --- 2. REDACTAR CON GEMINI ---
async function redactarLocucion(datos) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Eres el locutor estrella de "La Fronterísima" en Cali. 
    Datos actuales: Hora ${datos.hora}, Temperatura ${datos.temp}°C, Noticia: ${datos.noticia}.
    Redacta un guion corto, dinámico y con sabor colombiano (neutro-profesional). 
    Usa el eslogan "Notas surcando fronteras". Entrega solo el texto.`;

    const result = await model.generateContent(prompt);
    return result.response.text().trim();
}

// --- 3. GENERAR VOZ (GONZALO NEUTRAL) ---
async function crearAudio(texto) {
    return new Promise((resolve, reject) => {
        const speechConfig = sdk.SpeechConfig.fromSubscription(process.env.AZURE_SPEECH_KEY, process.env.AZURE_REGION);
        speechConfig.speechSynthesisVoiceName = "es-CO-GonzaloNeural";
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

        const ssml = `<speak version="1.0" xml:lang="es-CO"><voice name="es-CO-GonzaloNeural"><prosody pitch="low">${texto}</prosody></voice></speak>`;

        synthesizer.speakSsmlAsync(ssml, result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync("temp_voz.mp3", Buffer.from(result.audioData));
                synthesizer.close();
                resolve();
            } else { reject(result.errorDetails); }
        }, err => reject(err));
    });
}

// --- 4. MEZCLA Y SUBIDA ---
async function procesarYSubir() {
    console.log("🎙️ Iniciando locución automática de los 15 minutos...");
    
    const datos = await obtenerDatos();
    const guion = await redactarLocucion(datos);
    console.log(`📝 Guion: ${guion}`);

    await crearAudio(guion);

    // FFmpeg para poner fondo y subir
    const comando = `ffmpeg -y -i fondo.mp3 -i temp_voz.mp3 -filter_complex "[0:a]volume=0.2[bg];[1:a]volume=1.3[v];[bg][v]sidechaincompress=threshold=0.1:ratio=20[out]" -map "[out]" -shortest -c:a libmp3lame -b:a 128k dj_auto.mp3`;

    exec(comando, async (err) => {
        if (err) return console.error("Error FFmpeg", err);
        
        // Subir a AzuraCast
        const form = new FormData();
        form.append("file", fs.createReadStream("dj_auto.mp3"));
        form.append("path", "dj_auto.mp3");

        try {
            await axios.post(AZURA_API, form, {
                headers: { ...form.getHeaders(), "X-API-Key": process.env.AZURA_KEY }
            });
            console.log("✅ Reporte actualizado en AzuraCast.");
        } catch (e) { console.error("Error subida", e.message); }
    });
}

// --- EJECUCIÓN CADA 15 MINUTOS ---
setInterval(procesarYSubir, 15 * 60 * 1000); 

// Ejecutar por primera vez al iniciar el script
procesarYSubir();
