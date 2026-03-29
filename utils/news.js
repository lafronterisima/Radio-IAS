// utils/news.js
const Parser = require("rss-parser");
const parser = new Parser();

/**
 * Obtiene las últimas noticias de Euronews y devuelve un resumen
 * @param {number} maxItems - máximo de noticias a incluir
 * @returns {Promise<string>} resumen de titulares
 */
async function getNews(maxItems = 3) {
  const RSS_URL = "https://www.euronews.com/rss?level=theme&name=just-in";

  try {
    const feed = await parser.parseURL(RSS_URL);

    if (!feed.items || feed.items.length === 0) {
      console.warn("⚠️ No hay noticias disponibles en el feed RSS");
      return "No hay noticias disponibles.";
    }

    // Tomar los primeros maxItems titulares
    const headlines = feed.items.slice(0, maxItems).map(item => {
      // Limitar longitud de cada titular a 80 caracteres para locución
      let title = item.title || "";
      if (title.length > 80) title = title.slice(0, 77) + "...";
      return title;
    });

    return headlines.join(". ");
  } catch (err) {
    console.error("⚠️ Error al obtener noticias de Euronews:", err.message);
    return "No hay noticias disponibles.";
  }
}

module.exports = { getNews };