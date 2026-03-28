
const { exec } = require("child_process");
const { FFMPEG_PATH } = require("../config");

function mixAudio(musicFile, voiceFile, outputFile) {
  return new Promise((resolve, reject) => {
    const cmd = `${FFMPEG_PATH} -y -i "${musicFile}" -i "${voiceFile}" -filter_complex "[0:a]volume=0.5[a0];[1:a]volume=1[a1];[a0][a1]amix=inputs=2" "${outputFile}"`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      resolve(outputFile);
    });
  });
}

module.exports = { mixAudio };