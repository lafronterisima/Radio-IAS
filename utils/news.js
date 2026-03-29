
const Parser = require("rss-parser");
const parser = new Parser();

// Feed RSS de Euronews (noticias destacadas en español)
const EURONEWS_RSS = "https://www.euronews.com/rss?level=theme&name=top";

async function getNews() {
  try {
    const feed = await parser.parseURL(EURONEWS_RSS);
    // Tomamos las 3 primeras noticias
    const topNews = feed.items.slice(0, 3).map(item => item.title);
    if (topNews.length === 0) return "No hay noticias disponibles";
    return topNews.join(". ");
  } catch (err) {
    console.error("⚠️ Error al obtener noticias de Euronews:", err.message);
    return "No hay noticias disponibles";
  }
}

module.exports = { getNews };