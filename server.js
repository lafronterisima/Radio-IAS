require('dotenv').config();
const express = require("express");
const axios = require("axios");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fs = require("fs");
const FormData = require("form-data");
const { exec } = require("child_process");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 1. CONFIGURACIÓN =======
const safeTrim = (val) => val ? val.trim() : "";
const sID = (process.env.STATION_ID || "24").replace(/\D/g, "");

const KEYS = {
    GEMINI: safeTrim(process.env.GOOGLE_API_KEY),
    GROQ: safeTrim(process.env.GROQ_API_KEY),
    AZURE: safeTrim(process.env.AZURE_SPEECH_KEY),
    AZURE_REGION: safeTrim(process.env.AZURE_REGION),
    AZURA: safeTrim(process.env.AZURA_KEY),
    STATION_ID: sID,
    PASSWORD: safeTrim(process.env.APP_PASSWORD),
    TELEGRAM_TOKEN: safeTrim(process.env.TELEGRAM_TOKEN),
    JAMENDO_ID: safeTrim(process.env.JAMENDO_CLIENT_ID) || "c230e1f4"
};

const AZURA_BASE = `https://az.azurafree.eu/api/station/${KEYS.STATION_ID}`;
const AZURA_API_UPLOAD = `${AZURA_BASE}/files/upload`;

// ======= 2. TELEGRAM (SALUDOS Y PEDIDOS) =======
const bot = new TelegramBot(KEYS.TELEGRAM_TOKEN, { polling: true });
let ultimoSaludo = { nombre: "", texto: "", fecha: null };
let cancionRecienDescubierta = null;

bot.on('polling_error', () => {}); 

bot.on('message', async (msg) => {
    if (!msg.text) return;

    if (msg.text.startsWith('/pedir ')) {
        const busqueda = msg.text.replace('/pedir ', '').trim();
        if (busqueda.length < 3) return bot.sendMessage(msg.chat.id, "¡Dime el nombre de la canción! 🎵");

        bot.sendMessage(msg.chat.id, `🔎 Buscando "${busqueda}"...`);
        const track = await buscarMusicaJamendo(busqueda, true); 

        if (track) {
            const exito = await descargarYSubirAzura(track);
            if (exito) {
                ultimoSaludo = { 
                    nombre: msg.from.first_name || "un oyente", 
                    texto: `pidió la canción "${track.info}"`, 
                    fecha: new Date() 
                };
                bot.sendMessage(msg.chat.id, `✅ ¡Subida! "${track.info}". Salomé la presentará pronto.`);
            } else {
                bot.sendMessage(msg.chat.id, `❌ Error al procesar el archivo.`);
            }
        } else {
            bot.sendMessage(msg.chat.id, `❌ No encontré esa canción.`);
        }
        return;
    }

    if (msg.text === '/descubrir') {
        bot.sendMessage(msg.chat.id, "🔎 Buscando un éxito rumbero...");
        const track = await buscarMusicaJamendo('latin', false);
        if (track) {
            await descargarYSubirAzura(track);
            cancionRecienDescubierta = track.info;
            bot.sendMessage(msg.chat.id, `✅ ¡Nuevo estreno! "${track.info}".`);
        }
        return;
    }

    if (!msg.text.startsWith('/')) {
        ultimoSaludo = {
            nombre: msg.from.first_name || "un oyente",
            texto: msg.text,
            fecha: new Date()
        };
        bot.sendMessage(msg.chat.id, "¡Recibido! Tu saludo saldrá al aire. 🎙️");
    }
});

// ======= 3. FUNCIONES DE APOYO =======

async function buscarMusicaJamendo(query, esBusquedaEspecifica = false) {
    const generos = ['salsa', 'reggaeton', 'bachata', 'vallenato'];
    let parametro = esBusquedaEspecifica ? `search=${encodeURIComponent(query)}` : `fuzzytags=${generos[Math.floor(Math.random() * generos.length)]}&order=ratingdesc`;
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${KEYS.JAMENDO_ID}&format=json&limit=1&audioformat=mp32&durationbetween=120_600&${parametro}`;
    try {
        const res = await axios.get(url, { timeout: 8000 });
        if (res.data.results?.length > 0) {
            const t = res.data.results[0];
            return { url: t.audio, info: `${t.name} de ${t.artist_name}` };
        }
    } catch (e) { return null; }
}



// URL CORREGIDA: Se añade /api/ antes de /station/
const AZURA_API_UPLOAD = 'https://az.azurafree.eu/api/station/24/files/upload';
const AZURA_KEY = '3fe83928421317df:fded3074080312a158077455cc24419c';

async function descargarYSubirAzura(track) {
    const idUnico = Date.now();
    // Guardamos temporalmente como mp3 para mantener consistencia
    const tempFile = path.join(__dirname, `tmp_${idUnico}.mp3`);
    
    const carpeta = "diss";
    const nombreFinal = `pedido_${idUnico}.mp3`;
    const pathCompleto = `${carpeta}/${nombreFinal}`;

    try {
        console.log(`⏳ Descargando track...`);
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);

        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log(`🚀 Subiendo a AzuraCast (Carpeta: ${carpeta})...`);
        
Conversación con Gemini
Tú dijiste
Multipart para enviar archivos y datos de texto combinados a una API, lo cual es fundamental para entender por qué el orden de los campos y el nombre del archivo son cruciales en tu integración con AzuraCast.

Gemini dijo
Entender cómo funciona multipart/form-data es como entender cómo empacar una caja para una mudanza internacional: si no etiquetas bien las cosas o pones los documentos importantes al fondo, la aduana (en este caso, la API de AzuraCast) podría rechazar el paquete.

Aquí te explico por qué el orden y la estructura no son solo "buenas prácticas", sino requisitos técnicos.

1. ¿Qué es exactamente Multipart?
Cuando envías un formulario simple, los datos viajan como una cadena de texto larga. Pero cuando quieres enviar un archivo (como un .mp3) junto con datos (como el nombre del locutor), HTTP utiliza un Boundary (límite).

El Boundary es una cadena única que separa cada "pieza" de información. Imaginalo como un separador de cartón entre los objetos de tu caja.

2. Por qué el Orden de los Campos es Crucial
Aunque el estándar HTTP no obliga estrictamente a un orden, muchas APIs (incluyendo AzuraCast/Nginx) procesan los datos de forma secuencial (streaming) para ahorrar memoria.

Procesamiento en tiempo real: Si envías primero el archivo de 20MB y al final los metadatos de autenticación o el ID de la estación, el servidor tiene que "guardar" todo el archivo en un búfer temporal antes de saber qué hacer con él.

La Regla de Oro: Siempre envía los campos de texto pequeños (API Keys, IDs, carpetas de destino) antes que el archivo binario pesado. Esto permite que la API valide la petición antes de gastar recursos procesando los bytes del archivo.

3. La Anatomía de la Parte del Archivo
Para AzuraCast, no basta con enviar los bytes; el encabezado Content-Disposition debe ser perfecto. Se ve algo así:

Content-Disposition: form-data; name="file"; filename="cancion.mp3"

El Nombre del Campo (name)
Es el identificador que espera el código de la API (por ejemplo, file o music_file). Si usas un nombre distinto, la API simplemente dirá que el campo está vacío.

El Nombre del Archivo (filename)
A diferencia del name, el filename es el nombre real que AzuraCast usará para guardar el archivo en el sistema de archivos de la radio.

Importante: Debe incluir la extensión correcta. Si envías un audio pero el filename no termina en .mp3 o .ogg, es probable que el procesador de medios de AzuraCast lo ignore o no pueda generar las ondas de forma (waveforms).

4. Ejemplo Visual de una Petición Correcta
Así es como se ve la "caja" que recibe AzuraCast:

HTTP
POST /api/station/1/files/upload HTTP/1.1
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary7MA4YW

------WebKitFormBoundary7MA4YW
Content-Disposition: form-data; name="path"

/musica/rock
------WebKitFormBoundary7MA4YW
Content-Disposition: form-data; name="file"; filename="highway-to-hell.mp3"
Content-Type: audio/mpeg

(DATOS BINARIOS DEL ARCHIVO)
------WebKitFormBoundary7MA4YW--
Nota de experto: Si estás usando herramientas como curl o Postman, asegúrate de no sobrescribir manualmente el encabezado Content-Type para incluir el boundary; deja que la herramienta lo genere automáticamente para evitar errores de desajuste.

¿Estás experimentando algún error específico de "Missing File" o "Unauthorized" al intentar subir tus archivos a AzuraCast?

Tú dijiste
Integrar async function descargarYSubirAzura(track) {

    const tempFile = path.join(__dirname, 'tmp_track.mp3');

    const nombreArchivo = `${Date.now()}_pedido.mp3`;

    // IMPORTANTE: Sin barras diagonales al inicio ni al final

    const carpetaDestino = "Musica_Nueva"; 



    try {

        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });

        const writer = fs.createWriteStream(tempFile);

        

        return new Promise((resolve) => {

            response.data.pipe(writer);

            writer.on('finish', async () => {

                try {

                    const form = new FormData();

                    

                    // 1. El campo 'path' indica a AzuraCast la carpeta de destino

                    form.append('path', carpetaDestino); 



                    // 2. El archivo se envía con su nombre simple

                    form.append('file', fs.createReadStream(tempFile), { 

                        filename: nombreArchivo,

                        contentType: 'audio/mpeg'

                    });



                    // 3. Petición POST a la API de AzuraCast

                    await axios.post(AZURA_API_UPLOAD, form, { 

                        headers: { 

                            ...form.getHeaders(), 

                            "X-API-Key": KEYS.AZURA 

                        },

                        // Importante: Aumentar timeout para archivos grandes

                        timeout: 90000 

                    });



                    console.log(`✅ ${nombreArchivo} guardado en: ${carpetaDestino}`);



                    if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

                    resolve(true);

                } catch (err) { 

                    console.error("❌ Error subiendo a Azura:", err.response?.data || err.message);

                    if(fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

                    resolve(false); 

                }

            });

        });

    } catch (e) { 

        console.error("❌ Error en descarga de pista:", e.message);

        return false; 

    }

}  

Gemini dijo
¡Excelente estructura! Tu código refleja exactamente la teoría del multipart/form-data que discutimos. Estás respetando el orden (primero el path, luego el file) y manejando correctamente los encabezados.

Sin embargo, para que el código sea verdaderamente robusto y no te deje archivos "huérfanos" en el servidor o errores de memoria, te sugiero un par de ajustes técnicos:

El Código Optimizado
JavaScript
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

async function descargarYSubirAzura(track) {
    const tempFile = path.join(__dirname, `tmp_${Date.now()}.mp3`); // Nombre único para evitar colisiones
    const nombreArchivo = `${Date.now()}_pedido.mp3`;
    const carpetaDestino = "Musica_Nueva"; 

    try {
        // 1. Descarga con Stream
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);
        
        // Usar pipeline es más seguro para manejar errores de stream
        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // 2. Preparar el Formulario
        const form = new FormData();
        
        // EL ORDEN IMPORTA: Los metadatos primero
        form.append('path', carpetaDestino); 

        // El archivo al final
        form.append('file', fs.createReadStream(tempFile), { 
            filename: nombreArchivo,
            contentType: 'audio/mpeg'
        });

        // 3. Envío a AzuraCast
        await axios.post(AZURA_API_UPLOAD, form, { 
            headers: { 
                ...form.getHeaders(), 
                "X-API-Key": KEYS.AZURA 
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 120000 // 2 minutos para archivos pesados
        });

        console.log(`✅ ${nombreArchivo} guardado en: ${carpetaDestino}`);
        return true;

    } catch (err) { 
        console.error("❌ Fallo en la operación:", err.response?.data || err.message);
        return false; 
    } finally {
        // Siempre limpiar el archivo temporal, pase lo que pase
        if (fs.existsSync(tempFile)) {
            try { fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
        }
    }
}
¿Qué mejoras implementamos y por qué?
Bloque finally para el unlinkSync:
En tu versión original, si la descarga fallaba antes de entrar al writer.on('finish'), el archivo temporal podía no borrarse nunca. El bloque finally garantiza la limpieza del disco sin importar si la función tuvo éxito o falló.

maxContentLength y maxBodyLength:
Axios, por defecto, tiene límites de tamaño para el cuerpo de las peticiones (a veces 2MB o 10MB). Para subir audio .mp3, es vital setear estos valores en Infinity para que Axios no corte la subida antes de tiempo.

Identificador Único en tempFile:
Si dos personas piden una canción al mismo tiempo, ambos procesos intentarían escribir en tmp_track.mp3. Usar Date.now() en el nombre del archivo temporal evita que una descarga sobrescriba a la otra.

Manejo de Promesas:
Cambié el flujo a un await de la descarga directamente. Es un poco más limpio que anidar el Promise dentro del finish, haciendo que el código sea más fácil de leer (plano en lugar de anidado).

Un detalle sobre AzuraCast
Recuerda que si carpetaDestino no existe, AzuraCast intentará crearla o podría dar error dependiendo de los permisos de la API. Tu valor "Musica_Nueva" es perfecto porque no usa / inicial, lo cual es la forma correcta de referenciar rutas relativas a la raíz de la estación.

¿Tienes configurado el endpoint de AzuraCast para que apunte específicamente a /api/station/{id}/files/upload?

Tú dijiste
Di

Gemini dijo
¡Entendido! Estás en el punto exacto donde la teoría se convierte en práctica funcional.

Para que tu integración sea sólida como una roca, aquí tienes un par de "pro-tips" finales sobre cómo AzuraCast interpreta esos datos que estás enviando:

1. El comportamiento del "Path"
Cuando envías form.append('path', 'Musica_Nueva'), AzuraCast busca esa carpeta dentro de la raíz de archivos de la estación (/var/azuracast/stations/nombre_estacion/media).

Si la carpeta no existe: La API la creará automáticamente en la mayoría de las versiones recientes.

Si quieres subcarpetas: Puedes usar Musica_Nueva/Pedidos (sin barras al inicio ni al final).

2. El "Content-Type" del Archivo
En tu código usas contentType: 'audio/mpeg'. Esto es excelente porque ayuda a que el servidor web (Nginx) y la aplicación (PHP) identifiquen el flujo de datos sin tener que "adivinar" mediante la lectura de bytes iniciales.

3. Evitando el "Zombi" de archivos temporales
Como estás descargando un stream y luego subiéndolo, asegúrate de que el servidor tenga permisos de escritura en la carpeta donde ejecutas el script. Si el proceso se detiene abruptamente, podrías llenar el disco de archivos tmp_....

Recomendación: Considera añadir un proceso de limpieza que busque archivos que empiecen con tmp_ y tengan más de 24 horas de antigüedad, solo por seguridad.

¿Quieres que revisemos cómo capturar la respuesta de AzuraCast para obtener el ID del archivo recién subido? (Esto es útil si después quieres añadirlo automáticamente a una Playlist).

Tú dijiste
Si

Gemini dijo
¡Perfecto! Capturar la respuesta de AzuraCast es el "toque final" para automatizar tu radio por completo. Cuando la subida es exitosa, la API no solo te dice "OK", sino que te devuelve un objeto JSON con toda la información del archivo en su base de datos.

Aquí tienes cómo capturar esos datos y para qué sirven:

1. Capturando la respuesta en el código
Modifica la parte de la petición axios.post para guardar el resultado:

JavaScript
// ... dentro del try de la subida ...
const res = await axios.post(AZURA_API_UPLOAD, form, { 
    headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120000 
});

// La respuesta de AzuraCast suele ser un array de archivos (porque podrías subir varios)
const infoArchivo = res.data; 
console.log(`✅ Archivo procesado. ID en Base de Datos: ${infoArchivo.unique_id}`);

return infoArchivo; // Ahora devuelves la data real del archivo
2. ¿Qué contiene esa respuesta?
AzuraCast te devolverá un objeto (o un array con un objeto) que incluye:

Campo	Descripción
unique_id	El ID único que usa AzuraCast para identificar la canción.
path	La ruta completa donde quedó guardado (ej: Musica_Nueva/12345_pedido.mp3).
text	Generalmente el nombre del archivo o metadatos básicos.
links	URLs para editar el archivo o borrarlo vía API.
3. El siguiente paso lógico: Asignar a una Playlist
Si tu intención es que la canción se reproduzca pronto, podrías usar ese path o unique_id para mover el archivo a una lista de reproducción específica mediante otro endpoint:

Endpoint: POST /api/station/{station_id}/file/{file_id} (donde file_id es el path codificado o el ID).

4. Un último consejo: El "Processing Delay"
AzuraCast procesa los archivos apenas llegan (extrae carátulas, calcula el volumen ReplayGain, etc.). Si intentas añadir el archivo a una playlist milisegundos después de subirlo, a veces la API puede dar un error de "archivo no encontrado" porque aún se está moviendo internamente.

Truco: Si vas a encadenar acciones, pon un pequeño setTimeout de 1 o 2 segundos entre la subida y la asignación a una playlist para darle un respiro al servidor.

¿Te gustaría que te ayude a armar la función para añadir ese archivo a una playlist específica ahora que ya tenemos sus datos?

Tú dijiste
Como queda el código completo

Gemini dijo
Aquí tienes el código completo, limpio y profesional. He consolidado todas las optimizaciones: el manejo de streams con promesas, el orden correcto de los campos multipart, la limpieza garantizada del archivo temporal y la captura de la respuesta de la API.

JavaScript
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

/**
 * Descarga un track desde una URL y lo sube automáticamente a AzuraCast.
 * @param {Object} track - Objeto con la información del track (debe tener .url)
 */
async function descargarYSubirAzura(track) {
    // Generamos un nombre único para el archivo temporal y el destino
    const idUnico = Date.now();
    const tempFile = path.join(__dirname, `tmp_${idUnico}.mp3`);
    const nombreArchivo = `${idUnico}_pedido.mp3`;
    const carpetaDestino = "Musica_Nueva"; // Sin barras / al inicio ni al final

    try {
        console.log(`⏳ Iniciando descarga de: ${track.url}`);
        
        // 1. DESCARGA: Obtener el archivo como stream
        const response = await axios({ 
            url: track.url, 
            method: 'GET', 
            responseType: 'stream' 
        });

        const writer = fs.createWriteStream(tempFile);

        // Promesa para asegurar que la descarga terminó antes de seguir
        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', (err) => {
                writer.close();
                reject(err);
            });
        });

        console.log(`📦 Descarga completada. Subiendo a AzuraCast...`);

        // 2. PREPARAR MULTIPART: El orden de los campos es vital
        const form = new FormData();
        
        // Primero metadatos (campos de texto)
        form.append('path', carpetaDestino); 

        // Luego el archivo binario (al final para optimizar el stream del servidor)
        form.append('file', fs.createReadStream(tempFile), { 
            filename: nombreArchivo,
            contentType: 'audio/mpeg'
        });

        // 3. SUBIDA: Petición POST a la API
        const res = await axios.post(AZURA_API_UPLOAD, form, { 
            headers: { 
                ...form.getHeaders(), 
                "X-API-Key": KEYS.AZURA 
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 120000 // 2 minutos de margen
        });

        // La respuesta suele ser un objeto con los datos del archivo en Azura
        const dataAzura = res.data;
        console.log(`✅ ¡Éxito! Archivo guardado como: ${dataAzura.path}`);
        
        return dataAzura; // Retorna la info (ID, path, etc.) para pasos posteriores

    } catch (err) {
        const errorMsg = err.response?.data?.message || err.message;
        console.error("❌ Error en el proceso:", errorMsg);
        return null;

    } finally {
        // LIMPIEZA: Borrar el archivo temporal siempre, sea éxito o error
        if (fs.existsSync(tempFile)) {
            try {
                fs.unlinkSync(tempFile);
                console.log(`🧹 Archivo temporal ${idUnico} eliminado.`);
            } catch (e) {
                console.error("⚠️ No se pudo borrar el temporal:", e.message);
            }
        }
    }
}
Puntos clave que incluí:
Nombre de archivo dinámico: Usar Date.now() evita que si dos usuarios piden una canción al mismo tiempo, los archivos se sobrescriban entre sí en la carpeta /tmp.

Manejo de Memoria: Al usar responseType: 'stream' y fs.createReadStream, el archivo nunca se carga completamente en la memoria RAM de tu servidor. Pasa directamente del origen a AzuraCast.

Encabezados Dinámicos: ...form.getHeaders() es fundamental porque FormData genera un "boundary" (separador) aleatorio único para cada envío, y Axios necesita saber cuál es para que la API entienda dónde termina el texto y dónde empieza el audio.

Resiliencia: El bloque finally es tu red de seguridad. Sin él, un error en la subida dejaría el archivo .mp3 ocupando espacio en tu disco para siempre.

¡Ya tienes el motor de subida listo! ¿Quieres que hagamos la pequeña función para asignar este dataAzura.path a una lista de reproducción de forma automática?

Tú dijiste
Dice que se debe usar post para subir un audio a una carpeta se

Puede usar la extructura de este código curl --location --request POST 'http://localhost:8888/api/station/1/files/upload' \

--header 'Content-Type: application/json' \

--header 'X-API-Key: 87ec9c8949e65a53:8a8bfe685010c170a57632eba4d6ce00' \

--header 'Cookie: PHPSESSID=fd0k8qipgadolnqkv0jeomgpge' \

--form 'path="diss/dis1.mp3"' \

--form 'file=@"/home/little/tmp/theloai-nhanha.m4a"' \

--form 'currentDirectory="diss"'

Gemini dijo
¡Cuidado aquí! Hay una pequeña confusión en el comando curl que pusiste que es muy común, pero que causará un error en la API.

El error en el comando Curl
En tu comando tienes:
--header 'Content-Type: application/json'

Esto es incorrecto para subir archivos. Al usar --form, el mismo curl (y tu código de Node.js) debe generar automáticamente un Content-Type: multipart/form-data. Si fuerzas a que sea application/json, AzuraCast intentará leer el archivo como si fuera texto y la subida fallará.

Cómo adaptar esa estructura a tu código Node.js
Para que tu función haga exactamente lo que hace ese curl (subir a una subcarpeta específica y asignar el nombre correctamente), así es como se integra:

JavaScript
async function descargarYSubirAzura(track) {
    const tempFile = path.join(__dirname, 'temp_audio.m4a');
    
    try {
        // ... (Tu código anterior de descarga se mantiene igual) ...

        const form = new FormData();

        // EQUIVALENTE A: --form 'path="diss/nuevo_nombre.mp3"'
        // OJO: AzuraCast usa 'path' para el nombre final del archivo dentro de la carpeta
        const pathDestino = "diss/pedido_" + Date.now() + ".mp3";
        form.append('path', pathDestino);

        // EQUIVALENTE A: --form 'file=@"/ruta/al/archivo"'
        form.append('file', fs.createReadStream(tempFile));

        // EQUIVALENTE A: --form 'currentDirectory="diss"'
        // Esto le dice a AzuraCast en qué contexto de carpeta estás trabajando
        form.append('currentDirectory', 'diss');

        const res = await axios.post(AZURA_API_UPLOAD, form, { 
            headers: { 
                ...form.getHeaders(), // Esto genera el multipart/form-data CORRECTO
                "X-API-Key": KEYS.AZURA 
            }
        });

        console.log("✅ Subida exitosa a la carpeta 'diss'");
        return res.data;

    } catch (err) {
        console.error("❌ Error:", err.response?.data || err.message);
    }
}
Diferencias Clave que debes notar:
El campo path vs currentDirectory:

En el curl que mostraste, path incluye el nombre del archivo (diss/dis1.mp3).

currentDirectory es la carpeta donde "estás parado".

Mi recomendación: Manténlo simple. Si envías path con la ruta completa (carpeta + nombre), AzuraCast lo ubicará perfectamente.

Eliminación del JSON Header:
En Node.js, al hacer ...form.getHeaders(), Axios se encarga de decirle a AzuraCast: "Oye, esto no es un JSON, es un formulario con un archivo pesado". Nunca añadidas el header de JSON manualmente cuando uses FormData.

Extensiones de archivo:
Nota que en tu curl descargas un .m4a pero lo guardas como .mp3. AzuraCast es flexible, pero lo ideal es que la extensión coincida con el contenido real del audio para evitar problemas en el auto-DJ.

¿Quieres que ajustemos la variable AZURA_API_UPLOAD para asegurarnos de que el ID de la estación en la URL coincida con el de tu comando curl (estación 1)?

Tú dijiste
Si

Gemini dijo
¡Hecho! Vamos a ajustar la URL y el código final para que coincida exactamente con la estructura de tu comando curl.

En tu comando curl, la URL apunta a la estación 1. Es vital que esa variable esté bien definida. Aquí tienes la integración final lista para copiar y usar:

JavaScript
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// Configuración basada en tu CURL
const AZURA_API_UPLOAD = 'http://localhost:8888/api/station/1/files/upload';
const AZURA_KEY = '87ec9c8949e65a53:8a8bfe685010c170a57632eba4d6ce00';

async function descargarYSubirAzura(track) {
    const idUnico = Date.now();
    const tempFile = path.join(__dirname, `tmp_${idUnico}.m4a`);
    
    // Basado en tu curl: carpeta "diss" y nombre de archivo
    const carpeta = "diss";
    const nombreFinal = `pedido_${idUnico}.mp3`;
    const pathCompleto = `${carpeta}/${nombreFinal}`;

    try {
        // 1. Descarga del archivo
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);

        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // 2. Creación del Formulario (siguiendo tu estructura CURL)
        const form = new FormData();
        
        // --form 'path="diss/dis1.mp3"'
        form.append('path', pathCompleto);

        // --form 'file=@"/home/little/tmp/theloai-nhanha.m4a"'
        form.append('file', fs.createReadStream(tempFile), {
            filename: nombreFinal, // El nombre que verá AzuraCast
            contentType: 'audio/mpeg'
        });

        // --form 'currentDirectory="diss"'
        form.append('currentDirectory', carpeta);

        // 3. Envío POST
        const res = await axios.post(AZURA_API_UPLOAD, form, { 
            headers: { 
                ...form.getHeaders(), // Genera el multipart/form-data correcto
                'X-API-Key': AZURA_KEY
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        console.log(`✅ Subido con éxito: ${res.data.path}`);
        return res.data;

    } catch (err) {
        console.error("❌ Error en la integración:", err.response?.data || err.message);
        return null;
    } finally {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
}
Notas importantes sobre tu CURL vs el Código:
Ruta del Archivo (path): En tu comando usaste diss/dis1.mp3. En el código, he usado pathCompleto para que sea dinámico, pero mantiene la misma lógica de "Carpeta/Archivo.mp3".

currentDirectory: Lo hemos incluido tal cual estaba en tu ejemplo. Esto ayuda a AzuraCast a entender en qué contexto de carpeta se está realizando la operación.

Seguridad: Asegúrate de que la IP localhost:8888 sea accesible desde donde ejecutas este script de Node.js. Si Node está en un servidor y AzuraCast en otro, deberás usar la IP pública o privada real.

Headers: He eliminado el Content-Type: application/json que tenías en el curl, ya que form.getHeaders() pondrá automáticamente multipart/form-data, que es lo que realmente permite subir el archivo.

¿Deseas que probemos enviando también los metadatos de Artista y Título para que aparezcan correctamente en la radio?

Tú dijiste
Así funcionaria  





// Configuración basada en tu CURL

const AZURA_API_UPLOAD = 'https://az.azurafree.eu/station/24/files/upload';

const AZURA_KEY = '3fe83928421317df:fded3074080312a158077455cc24419c';



async function descargarYSubirAzura(track) {

    const idUnico = Date.now();

    const tempFile = path.join(__dirname, `tmp_${idUnico}.m4a`);

    

    // Basado en tu curl: carpeta "diss" y nombre de archivo

    const carpeta = "diss";

    const nombreFinal = `pedido_${idUnico}.mp3`;

    const pathCompleto = `${carpeta}/${nombreFinal}`;



    try {

        // 1. Descarga del archivo

        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });

        const writer = fs.createWriteStream(tempFile);



        await new Promise((resolve, reject) => {

            response.data.pipe(writer);

            writer.on('finish', resolve);

            writer.on('error', reject);

        });



        // 2. Creación del Formulario (siguiendo tu estructura CURL)

        const form = new FormData();

        

        // --form 'path="diss/dis1.mp3"'

        form.append('path', pathCompleto);



        // --form 'file=@"/home/little/tmp/theloai-nhanha.m4a"'

        form.append('file', fs.createReadStream(tempFile), {

            filename: nombreFinal, // El nombre que verá AzuraCast

            contentType: 'audio/mpeg'

        });



        // --form 'currentDirectory="diss"'

        form.append('currentDirectory', carpeta);



        // 3. Envío POST

        const res = await axios.post(AZURA_API_UPLOAD, form, { 

            headers: { 

                ...form.getHeaders(), // Genera el multipart/form-data correcto

                'X-API-Key': AZURA_KEY

            },

            maxContentLength: Infinity,

            maxBodyLength: Infinity

        });



        console.log(`✅ Subido con éxito: ${res.data.path}`);

        return res.data;



    } catch (err) {

        console.error("❌ Error en la integración:", err.response?.data || err.message);

        return null;

    } finally {

        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

    }

}

Gemini dijo
Casi perfecto, pero hay un detalle crítico en la URL de tu configuración que hará que la API te devuelva un error 404 o 405.

El Ajuste Necesario
En AzuraCast, los endpoints de la API siempre deben llevar el prefijo /api/.

Tu URL actual:
https://az.azurafree.eu/station/24/files/upload ❌ (Esta es la URL de la interfaz web)

La URL correcta de la API:
https://az.azurafree.eu/api/station/24/files/upload ✅

Código Final Corregido
He ajustado la URL y añadido un pequeño cambio en el filename para asegurar compatibilidad total:

JavaScript
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// URL CORREGIDA: Se añade /api/ antes de /station/
const AZURA_API_UPLOAD = 'https://az.azurafree.eu/api/station/24/files/upload';
const AZURA_KEY = '3fe83928421317df:fded3074080312a158077455cc24419c';

async function descargarYSubirAzura(track) {
    const idUnico = Date.now();
    // Guardamos temporalmente como mp3 para mantener consistencia
    const tempFile = path.join(__dirname, `tmp_${idUnico}.mp3`);
    
    const carpeta = "diss";
    const nombreFinal = `pedido_${idUnico}.mp3`;
    const pathCompleto = `${carpeta}/${nombreFinal}`;

    try {
        console.log(`⏳ Descargando track...`);
        const response = await axios({ url: track.url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempFile);

        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log(`🚀 Subiendo a AzuraCast (Carpeta: ${carpeta})...`);
        const form = new FormData();
        
        // El orden que definimos como crucial:
        form.append('path', pathCompleto);
        form.append('currentDirectory', carpeta);
        
        // El archivo siempre al final
        form.append('file', fs.createReadStream(tempFile), {
            filename: nombreFinal,
            contentType: 'audio/mpeg'
        });

        const res = await axios.post(AZURA_API_UPLOAD, form, { 
            headers: { 
                ...form.getHeaders(),
                'X-API-Key': AZURA_KEY
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        console.log(`✅ ¡Éxito! Archivo disponible en: ${res.data.path}`);
        return res.data;

    } catch (err) {
        // Manejo de errores detallado
        if (err.response) {
            console.error("❌ Error de la API:", err.response.status, err.response.data);
        } else {
            console.error("❌ Error de red/sistema:", err.message);
        }
        return null;
    } finally {
        if (fs.existsSync(tempFile)) {
            try { fs.unlinkSync(tempFile); } catch (e) {}
        }
    }
}
¿Por qué este cambio es vital?
Endpoint /api/: Las estaciones de AzuraCast separan la navegación del usuario de las funciones de integración. Si no usas /api/, el servidor intentará cargar la página de login en lugar de procesar tu archivo.

Referencia diss: Al enviar currentDirectory: 'diss' y path: 'diss/archivo.mp3', le das redundancia a la API para que no haya duda de dónde debe aterrizar el archivo.

Con esa URL corregida, el script debería funcionar a la primera. ¿Quieres que hagamos una prueba de ejecución para ver qué devuelve el console.log?

Tú dijiste
No sube a la carpeta indicada https://az.azurafree.eu/station/24/files/diss

Gemini dijo
Si el archivo no está aterrizando en la carpeta diss, el problema suele ser cómo AzuraCast interpreta la ruta cuando se envían los campos por separado.

Para forzar a que el sistema reconozca la carpeta correctamente en un entorno de producción como azurafree.eu, realiza estos dos ajustes en tu código:

1. Simplifica el campo path
En lugar de enviar la ruta completa en path, envía solo el nombre del archivo y deja que currentDirectory se encargue de la ubicación. Esto evita que la API se confunda con barras diagonales dobles o rutas mal formadas.

2. Código Ajustado
Prueba con esta estructura exacta de FormData:

JavaScript
// ... dentro de tu función descargarYSubirAzura ...

const form = new FormData();

// 1. Especificamos el nombre del archivo SOLAMENTE
const nombreFinal = `pedido_${Date.now()}.mp3`;
form.append('path', nombreFinal); 

// 2. Especificamos la carpeta destino SOLAMENTE
// Asegúrate de que la carpeta "diss" ya esté creada en tu AzuraCast
form.append('currentDirectory', 'diss'); 

// 3. El archivo binario
form.append('file', fs.createReadStream(tempFile), {
    filename: nombreFinal,
    contentType: 'audio/mpeg'
});

// 4. Envío con la URL de la API corregida
const res = await axios.post(AZURA_API_UPLOAD, form, { 
    headers: { 
        ...form.getHeaders(),
        'X-API-Key': AZURA_KEY
    }
});
    
}




async function obtenerAhoraSuena() {
    try {
        const res = await axios.get(`${AZURA_BASE}/nowplaying`, { timeout: 4000 });
        const np = res.data.now_playing?.song;
        return np ? { artista: np.artist, titulo: np.title } : { artista: "varios", titulo: "buena música" };
    } catch (e) { return { artista: "varios", titulo: "tu música favorita" }; }
}

async function obtenerNoticiasBBC() {
    try {
        const res = await axios.get("https://feeds.bbci.co.uk/mundo/rss.xml", { timeout: 5000 });
        const matches = res.data.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>([^<]+)<\/title>/g);
        if (matches && matches.length > 2) {
            return matches[1].replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').trim();
        }
        return "El mundo sigue vibrando.";
    } catch (e) { return "Sigue en sintonía."; }
}

function limpiarTexto(t) {
    if (!t) return "";
    return t.replace(/[*#_~]/g, '').replace(/Locutor:|Guion:|Respuesta:|Locutora:|Salomé:/gi, '').trim();
}

// ======= 4. INTELIGENCIA ARTIFICIAL =======

async function redactarIA(prompt) {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.GEMINI}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 10000 });
        const texto = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (texto) return limpiarTexto(texto);
    } catch (e) {
        try {
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.1-8b-instant",
                messages: [{ role: "system", content: "Locutora colombiana rumbera de Cali." }, { role: "user", content: prompt }]
            }, { headers: { "Authorization": `Bearer ${KEYS.GROQ}` }, timeout: 8000 });
            return limpiarTexto(res.data?.choices?.[0]?.message?.content);
        } catch (err) { return "Sintonizas La Fronterísima, notas surcando fronteras."; }
    }
}

// ======= 5. VOZ Y PRODUCCIÓN =======

async function generarVoz(texto, archivoDestino) {
    return new Promise((resolve, reject) => {
        const config = sdk.SpeechConfig.fromSubscription(KEYS.AZURE, KEYS.AZURE_REGION);
        config.speechSynthesisVoiceName = "es-CO-SalomeNeural";
        const synth = new sdk.SpeechSynthesizer(config);
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-CO">
            <voice name="es-CO-SalomeNeural"><mstts:express-as style="cheerful" styledegree="1.4" xmlns:mstts="https://www.w3.org/2001/mstts">
            <prosody rate="+8%">${texto}</prosody></mstts:express-as></voice></speak>`;
        
        synth.speakSsmlAsync(ssml, r => {
            if (r.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                fs.writeFileSync(archivoDestino, Buffer.from(r.audioData));
                synth.close(); resolve();
            } else { synth.close(); reject("Error TTS"); }
        }, e => { synth.close(); reject(e); });
    });
}

async function producirYSubir(archivoVoz, nombreFinal, conFondo) {
    const tempSalida = `prod_${Date.now()}.mp3`;
    const fondo = "fondo.mp3";
    let cmd = (conFondo && fs.existsSync(fondo))
        ? `ffmpeg -y -i ${fondo} -i ${archivoVoz} -filter_complex "[0:a]volume=0.08,atrim=duration=35,aresample=44100[bg];[1:a]volume=1.8,aresample=44100[v];[bg][v]amix=inputs=2:duration=shortest" -c:a libmp3lame -b:a 128k ${tempSalida}`
        : `ffmpeg -y -i ${archivoVoz} -af "volume=1.6" -c:a libmp3lame -b:a 128k ${tempSalida}`;

    return new Promise((resolve) => {
        exec(cmd, async () => {
            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(tempSalida), { filename: nombreFinal });
                form.append('path', nombreFinal);
                await axios.post(AZURA_API_UPLOAD, form, { headers: { ...form.getHeaders(), "X-API-Key": KEYS.AZURA }, timeout: 60000 });
                [archivoVoz, tempSalida].forEach(f => { if(fs.existsSync(f)) fs.unlinkSync(f); });
                resolve();
            } catch (e) { resolve(); }
        });
    });
}

// ======= 6. AUTOMATIZACIÓN =======

async function autoReporte() {
    try {
        const clim = await axios.get("https://api.open-meteo.com/v1/forecast?latitude=3.45&longitude=-76.53&current_weather=true");
        const bbc = await obtenerNoticiasBBC();
        const np = await obtenerAhoraSuena();
        const hora = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: '2-digit', minute: '2-digit', hour12: true });
        
        let extras = "";
        if (ultimoSaludo.fecha && (new Date() - ultimoSaludo.fecha < 30 * 60 * 1000)) {
            extras += ` SALUDO: ${ultimoSaludo.nombre} dice ${ultimoSaludo.texto}.`;
        }

        const prompt = `Salomé de La Fronterísima Cali. Hora: ${hora}. Música: ${np.titulo}. Clima: ${Math.round(clim.data.current_weather.temperature)}°C. Noticias: ${bbc}. ${extras} Guion rumbero de 50 palabras.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_auto_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "dj_auto.mp3", true);
        ultimoSaludo.fecha = null; 
        console.log("✅ dj_auto.mp3 (15 min) actualizado.");
    } catch (e) { console.error("Error AutoReporte:", e.message); }
}

async function autoRedactorIA() {
    try {
        const temas = ["un mensaje positivo", "una efeméride musical", "un dato curioso de Cali", "historia de un artista de salsa"];
        const tema = temas[Math.floor(Math.random() * temas.length)];
        const prompt = `Salomé de La Fronterísima. Redacta 40 palabras sobre ${tema}. Muy alegre. Termina: Notas surcando fronteras.`;
        const guion = await redactarIA(prompt);
        const pathVoz = `v_red_${Date.now()}.mp3`;
        await generarVoz(guion, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", true);
        console.log("✅ Redactor_ia.mp3 (50 min) actualizado.");
    } catch (e) { console.error("Error AutoRedactor:", e.message); }
}

// ======= 7. RUTAS API =======

app.post("/redactar-guion", async (req, res) => {
    try {
        const promptManual = `Salomé de La Fronterísima. Guion alegre sobre: ${req.body.idea}. Máximo 40 palabras.`;
        const textoIa = await redactarIA(promptManual);
        res.json({ guion: textoIa }); 
    } catch (e) { res.json({ guion: "¡Sintonizas La Fronterísima!" }); }
});

app.post("/procesar-locucion", async (req, res) => {
    const pathVoz = `v_man_${Date.now()}.mp3`;
    try {
        await generarVoz(req.body.texto, pathVoz);
        await producirYSubir(pathVoz, "Redactor_ia.mp3", req.body.conFondo);
        res.send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

app.post('/login', (req, res) => {
    if (req.body.password === KEYS.PASSWORD) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.get("/health", (req, res) => res.sendStatus(200));

// ======= 8. INICIO DEL SERVIDOR =======
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 La Fronterísima Pro en puerto ${PORT}`);
    
    // Reporte de clima/noticias cada 15 minutos
    setTimeout(autoReporte, 5000);
    setInterval(autoReporte, 15 * 60 * 1000);

    // Contenido variado (Redactor_ia) cada 50 minutos
    setTimeout(autoRedactorIA, 20000); 
    setInterval(autoRedactorIA, 50 * 60 * 1000);
});
