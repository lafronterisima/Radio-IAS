
// server.js (Node.js Express)
import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post('/tts', async (req, res) => {
  const texto = req.body.texto;
  try {
    const ttsRes = await fetch(`https://${process.env.AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3'
      },
      body: `<speak version='1.0' xml:lang='es-ES'><voice name='es-ES-ElviraNeural'>${texto}</voice></speak>`
    });
    const blob = await ttsRes.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(blob));
  } catch (err) {
    console.error(err);
    res.status(500).send('Error TTS');
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));