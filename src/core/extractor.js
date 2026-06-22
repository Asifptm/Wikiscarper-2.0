const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

function createTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
  });

  td.use(gfm);

  td.addRule('code-block', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (content, node) => {
      const code = node.querySelector('code');
      const lang = (code?.className?.match(/language-(\w+)/) ?? [])[1] ?? '';
      const body = code?.textContent ?? content;
      return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
    },
  });

  td.addRule('svg', {
    filter: 'svg',
    replacement: (_, node) => `[SVG: ${node.getAttribute('aria-label') ?? 'image'}]`,
  });

  return td;
}

function buildFrontMatter(meta) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    const formatted = typeof value === 'string' ? `"${value.replace(/"/g, '\\"')}"` : value;
    lines.push(`${key}: ${formatted}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function extractPageMeta(html, url, stats = {}) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  const linkCount = (html.match(/<a\s/gi) ?? []).length;
  const imageCount = (html.match(/<img\s/gi) ?? []).length;

  return {
    title,
    url,
    scraped_at: new Date().toISOString(),
    status: stats.status ?? 200,
    content_type: stats.contentType ?? 'text/html',
    etag: stats.etag ?? null,
    scrape_duration_ms: stats.durationMs ?? 0,
    word_count: stats.wordCount ?? 0,
    image_count: imageCount,
    link_count: linkCount,
    scrolls: stats.scrolls ?? 0,
    captcha: stats.captcha ?? false,
  };
}

function htmlToMarkdown(html, options = {}) {
  const td = createTurndown();
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  const markdown = td.turndown(bodyHtml);
  const wordCount = countWords(markdown);

  if (!options.frontMatter) {
    return { markdown, wordCount, meta: null };
  }

  const meta = extractPageMeta(html, options.url, {
    ...options.stats,
    wordCount,
  });

  const cleaned = markdown.replace(/^#\s+.+\n+/, '');
  const withFrontMatter = buildFrontMatter(meta) + `# ${meta.title}\n\n${cleaned}`;
  return { markdown: withFrontMatter, wordCount, meta };
}

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&ldquo;': '“',
  '&rdquo;': '”',
};

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-zA-Z#0-9]+;/g, (ent) => HTML_ENTITIES[ent] ?? ent);
}

function extractMainContent(html) {
  const contentMatch = html.match(
    /<div[^>]*id=["']mw-content-text["'][^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]*id=["']catlinks|<noscript|<\/main)/i
  );
  if (contentMatch) return contentMatch[1];

  const parserOutput = html.match(/<div[^>]*class=["'][^"']*mw-parser-output[^"']*["'][^>]*>([\s\S]*)/i);
  if (parserOutput) return parserOutput[1];

  const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (article) return article[1];

  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return body ? body[1] : html;
}

function htmlToMarkdownBuiltin(html, options = {}) {
  let content = extractMainContent(html);

  content = content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<table[\s\S]*?<\/table>/gi, '')
    .replace(/<sup[^>]*class=["'][^"']*reference[^"']*["'][\s\S]*?<\/sup>/gi, '')
    .replace(/<span[^>]*class=["'][^"']*mw-editsection[^"']*["'][\s\S]*?<\/span>/gi, '')
    .replace(/<div[^>]*class=["'][^"']*(navbox|reflist|hatnote|metadata|mw-references|thumb|infobox)[^"']*["'][\s\S]*?<\/div>/gi, '');

  content = content
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n\n# ${stripTags(t)}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n\n## ${stripTags(t)}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n\n### ${stripTags(t)}\n\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, t) => `\n\n#### ${stripTags(t)}\n\n`)
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, t) => `\n\n##### ${stripTags(t)}\n\n`)
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, t) => `\n\n###### ${stripTags(t)}\n\n`);

  content = content
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, t) => `**${stripTags(t)}**`)
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, t) => `*${stripTags(t)}*`);

  content = content.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
    const text = stripTags(t).trim();
    if (!text) return '';
    if (href.startsWith('#') || href.startsWith('/wiki/') === false && href.startsWith('http') === false) {
      return text;
    }
    const abs = href.startsWith('/') && options.url
      ? new URL(href, options.url).href
      : href;
    return `[${text}](${abs})`;
  });

  content = content
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${stripTags(t).trim()}`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => `\n\n${stripTags(t).trim()}\n\n`)
    .replace(/<br\s*\/?>/gi, '\n');

  let text = decodeEntities(stripTags(content));

  text = text
    .replace(/\[[0-9]+\]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/^\[?edit\]?$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const wordCount = countWords(text);

  if (!options.frontMatter) {
    return { markdown: text, wordCount, meta: null };
  }

  const meta = extractPageMeta(html, options.url, { ...options.stats, wordCount });
  const title = meta.title.replace(/ - Wikipedia$/, '');
  const markdown = buildFrontMatter({ ...meta, title }) + `# ${title}\n\n${text}\n`;
  return { markdown, wordCount, meta };
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

module.exports = {
  htmlToMarkdown,
  htmlToMarkdownBuiltin,
  extractPageMeta,
  createTurndown,
};
