const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const { exec } = require("child_process");
const Parser = require('rss-parser');
require('dotenv').config();

const app = express();
const parser = new Parser();

app.use(express.json());
app.use(express.static('public'));

// ======= CONFIGURACIÓN ESTACIÓN 24 =======
const STATION_ID = "24"; 
const AZURA_KEY = (process.env.AZURA_KEY || "").trim();
const AZURE_SPEECH_KEY = (process.env.AZURE_SPEECH_KEY || "").trim();
const AZURE_REGION = (process.env.AZURE_REGION || "").trim();
const AZURA_API_UPLOAD = `https://az.azurafree.eu/api/station/${STATION_ID}/files/upload`;

let ultimoEstado = {
  guion: "Esperando inicio de locución...",
  fecha: "--:--",
  status: "Iniciando sistema..."
};

// 1. UTILIDADES
function getHora() {
  return new Date().toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

function limpiarTexto(texto) {
  return texto
    .replace(/Now On Air:/gi, "")
    .replace(/\(.*?\)|\[.*?\]|- VIDEO OFICIAL|- HD|Official Video/gi, "")
    .trim();
}

// 2. FUNCIONES DE PROCESAMIENTO
async function crearGuion() {
  try {
    const songRes = await axios.get(`https://az.azurafree.eu/api/nowplaying/${STATION_ID}`, { timeout: 5000 });
    let artista = songRes.data.now_playing?.song?.artist || "varios artistas";
    let cancion = songRes.data.now_playing?.song?.title || "la mejor música";
    
    artista = limpiarTexto(artista);
    cancion = limpiarTexto(cancion);
    
    const weatherRes = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true", { timeout: 5000 });
    const temp = Math.round(weatherRes.data.current_weather.temperature);
    
    const feed = await parser.parseURL('https://feeds.bbci.co.uk/mundo/rss.xml');
    const noticias = feed.items.slice(0, 2).map(i => i.title.split(" - ")[0]).join(". ");

    return `Hola, son las ${getHora()} en Colombia. El clima es de ${temp} grados. Estás escuchando a ${artista} con el éxito ${cancion}. En noticias: ${noticias}. Sigue con más música en La Fronterísima.`;
  } catch (e) {
    return `Hola, son las ${getHora()}. Estás en sintonía de La Fronterísima, acompañándote con la mejor música siempre.`;
  }
}

async function generarVoz(texto) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_REGION);
    speechConfig.speechSynthesisVoiceName = "es-CO-SalomeNeural";
    // Formato estándar mp3
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16Khz128KBitRateMonoMp3;

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
    synthesizer.speakTextAsync(texto, result => {
      if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
        fs.writeFileSync("voz.mp3", Buffer.from(result.audioData));
        synthesizer.close();
        console.log("🔊 Voz de Salomé generada con éxito.");
        resolve();
      } else {
        synthesizer.close();
        reject("Error Azure: " + result.errorDetails);
      }
    }, err => {
      synthesizer.close();
      reject(err);
    });
  });
}

function mezclarAudio() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync("salida.mp3")) fs.unlinkSync("salida.mp3");
    
    // Verificamos si existen los archivos antes de mezclar
    const tieneVoz = fs.existsSync("voz.mp3");
    const tieneFondo = fs.existsSync("fondo.mp3");

    if (!tieneVoz) return reject("❌ Error: No se encontró voz.mp3 para mezclar");

    // COMANDO OPTIMIZADO: 
    // [0:a] es el fondo, [1:a] es la voz
    // Bajamos el fondo a 0.15 y subimos la voz a 1.5
    const comando = tieneFondo 
      ? `ffmpeg -y -i fondo.mp3 -i voz.mp3 -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.5[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k salida.mp3`
      : `ffmpeg -y -i voz.mp3 -c:a libmp3lame -b:a 128k salida.mp3`;

    exec(comando, (err) => {
      if (err) reject("Error FFmpeg: " + err);
      else {
        console.log("🎵 Mezcla terminada correctamente.");
        resolve();
      }
    });
  });
}

async function subirAzura() {
  if (!fs.existsSync("salida.mp3")) throw new Error("Archivo salida.mp3 no encontrado");

  const form = new FormData();
  form.append("file", fs.createReadStream("salida.mp3"), { 
    filename: 'dj_auto.mp3', 
    contentType: 'audio/mpeg' 
  });
  form.append("path", "dj_auto.mp3");

  await axios.post(AZURA_API_UPLOAD, form, {
    headers: { 
      ...form.getHeaders(), 
      "X-API-Key": AZURA_KEY,
      "Accept": "application/json"
    }
  });
}

// ======= 3. FUNCIÓN MAESTRA DJ (NUEVA) =======
// ======= FUNCIÓN MAESTRA DJ (Agrega esto) =======
async function DJ() {
  console.log(`🎙️ [${new Date().toISOString()}] Iniciando ciclo de locución...`);
  ultimoEstado.status = "Procesando locución...";
  
  try {
    // 1. Crear el guion con clima y noticias
    const guion = await crearGuion();
    ultimoEstado.guion = guion;
    
    // 2. Generar el audio con Azure
    console.log("🔊 Generando voz con Azure...");
    await generarVoz(guion);
    
    // 3. Mezclar con fondo musical usando FFmpeg
    console.log("🎵 Mezclando audio con FFmpeg...");
    await mezclarAudio();
    
    // 4. Subir el resultado final a AzuraCast
    console.log("📤 Subiendo dj_auto.mp3 a AzuraCast...");
    await subirAzura();
    
    ultimoEstado.fecha = getHora();
    ultimoEstado.status = "Al aire (Sincronizado)";
    console.log("✅ Ciclo completado exitosamente.");
    
  } catch (error) {
    ultimoEstado.status = "Error: " + error.message;
    console.error("❌ Fallo en el ciclo DJ:", error.message);
  }
}
// ================================================

// 4. RUTAS Y SERVIDOR
app.get("/api/status", (req, res) => res.json(ultimoEstado));

app.post("/api/disparar", (req, res) => {
  DJ().catch(console.error);
  res.json({ success: true });
});

app.get("/", (req, res) => {
    res.send(`
    <html>
        <head><title>Fronterisima DJ</title><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-slate-900 text-white flex items-center justify-center min-h-screen">
            <div class="p-8 bg-slate-800 rounded-3xl shadow-xl w-full max-w-md border border-slate-700">
                <h1 class="text-2xl font-bold text-blue-400 mb-4 text-center tracking-tighter">LA FRONTERÍSIMA IA</h1>
                <div class="mb-6 p-4 bg-slate-900 rounded-xl">
                    <p class="text-xs text-slate-500 uppercase font-bold mb-1">Estado</p>
                    <p id="st" class="font-mono text-green-400">${ultimoEstado.status}</p>
                </div>
                <div class="mb-6">
                    <p class="text-xs text-slate-500 uppercase font-bold mb-1">Última locución</p>
                    <p id="gn" class="text-sm italic text-slate-300">${ultimoEstado.guion}</p>
                </div>
                <button onclick="fetch('/api/disparar',{method:'POST'}); this.innerText='Procesando...'; setTimeout(()=>this.innerText='Lanzar Locución Manual', 5000)" class="w-full bg-blue-600 p-4 rounded-xl font-bold hover:bg-blue-500 transition-all">Lanzar Locución Manual</button>
                <script>
                    setInterval(async()=>{
                        const r=await fetch('/api/status');const d=await r.json();
                        document.getElementById('st').innerText=d.status;
                        document.getElementById('gn').innerText=d.guion;
                    },5000);
                </script>
            </div>
        </body>
    </html>`);
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
  setTimeout(DJ, 5000); // Primera ejecución a los 5 segundos
  setInterval(DJ, 15 * 60 * 1000); // Ciclo cada 15 min
});
