function extractDescription(html) {
  const match =
    html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ??
    html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
  return match?.[1]?.trim() ?? null;
}

function titleFromMarkdown(markdown) {
  return markdown?.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function buildScrapeResponse(pageResult, meta = {}) {
  const success = !pageResult.error;
  const markdown = pageResult.markdown ?? '';
  return {
    success,
    data: success
      ? {
          markdown,
          metadata: {
            title: meta.title ?? titleFromMarkdown(markdown),
            description: meta.description ?? null,
            sourceURL: pageResult.url,
            url: pageResult.url,
            statusCode: pageResult.status ?? null,
            wordCount: pageResult.word_count ?? 0,
            scrapeDurationMs: pageResult.total_ms ?? 0,
            cacheHit: pageResult.cache_hit ?? false,
          },
        }
      : null,
    error: pageResult.error ?? null,
  };
}

module.exports = { buildScrapeResponse, extractDescription };
