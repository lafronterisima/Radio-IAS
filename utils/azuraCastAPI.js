
const axios = require("axios");
const { AZURA_API_KEY, AZURA_API_URL, STATION_ID } = require("../config");
const fs = require("fs");

async function uploadToAzura(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const form = new FormData();
  form.append("file", fileStream);

  await axios.post(`${AZURA_API_URL}/stations/${STATION_ID}/files`, form, {
    headers: {
      Authorization: `Bearer ${AZURA_API_KEY}`,
      ...form.getHeaders()
    }
  });
}

module.exports = { uploadToAzura };