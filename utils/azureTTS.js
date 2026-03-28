
const fs = require("fs");
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const { AZURE_KEY, AZURE_REGION } = require("../config");

async function textToSpeech(text, outputFile) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

    const audioConfig = sdk.AudioConfig.fromAudioFileOutput(outputFile);

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

    // SSML para locutor de radio
    const ssml = `
      <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-ES">
        <voice name="es-ES-AlvaroNeural">
          <prosody rate="0%" pitch="0%">
            ${text}
          </prosody>
        </voice>
      </speak>
    `;

    synthesizer.speakSsmlAsync(
      ssml,
      result => {
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          synthesizer.close();
          resolve();
        } else {
          synthesizer.close();
          reject(new Error("Error en síntesis de voz"));
        }
      },
      error => {
        synthesizer.close();
        reject(error);
      }
    );
  });
}

module.exports = { textToSpeech };