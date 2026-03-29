// utils/news.js – Obtiene noticias destacadas desde Euronews RSS

const Parser = require("rss-parser");
const parser = new Parser();

// URL del feed RSS de Euronews
const EURONEWS_RSS = "https://www.euronews.com/rss?level=theme&name=just-in";

async function getNews(maxItems = 3) {
  try {
    const feed = await parser.parseURL(EURONEWS_RSS);
    if (!feed || !feed.items || feed.items.length === 0) return "No hay noticias disponibles";

    // Tomar los primeros `maxItems` titulares
    const headlines = feed.items.slice(0, maxItems).map((item, idx) => `${idx + 1}. ${item.title}`);

    return headlines.join(". ");
  } catch (err) {
    console.error("⚠️ Error al obtener noticias de Euronews:", err.message || err);
    return "No hay noticias disponibles";
  }
}

module.exports = { getNews };