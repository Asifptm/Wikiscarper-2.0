function extractMetaContent(html, property) {
  if (!html) return null;
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(
      `<meta[^>]*property=["']${escaped}["'][^>]*content=["']([^"']+)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${escaped}["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]*name=["']${escaped}["'][^>]*content=["']([^"']+)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]*content=["']([^"']+)["'][^>]*name=["']${escaped}["']`,
      'i',
    ),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

module.exports = { extractMetaContent };
