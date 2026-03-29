// utils/news.js – Noticias resumidas para locución de IA DJ

const Parser = require("rss-parser");
const parser = new Parser();

// URL del feed RSS de Euronews
const EURONEWS_RSS = "https://www.euronews.com/rss?level=theme&name=just-in";

/**
 * Resumir un texto a un número máximo de palabras
 * @param {string} text 
 * @param {number} maxWords 
 * @returns {string}
 */
function summarizeText(text, maxWords = 12) {
  if (!text) return "";
  const words = text.split(" ");
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "...";
}

/**
 * Obtener noticias resumidas desde Euronews
 * @param {number} maxItems – máximo de noticias a mostrar
 * @param {number} maxWords – máximo de palabras por noticia
 * @returns {Promise<string>} – Noticias concatenadas para locución
 */
async function getNews(maxItems = 3, maxWords = 20) {
  try {
    const feed = await parser.parseURL(EURONEWS_RSS);
    if (!feed?.items || feed.items.length === 0) return "No hay noticias disponibles";

    const headlines = feed.items
      .slice(0, maxItems)
      .map((item, idx) => `${idx + 1}. ${summarizeText(item.title, maxWords)}`);

    return headlines.join(". ");
  } catch (err) {
    console.error("⚠️ Error al obtener noticias de Euronews:", err.message || err);
    return "No hay noticias disponibles";
  }
}

module.exports = { getNews };