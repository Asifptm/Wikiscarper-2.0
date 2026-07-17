const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');
const { formatMarkdown } = require('./formatMarkdown');

const NON_CONTENT_TAGS =
  /<(script|style|noscript|template|iframe|svg|link|meta|object|embed|canvas)[^>]*>[\s\S]*?<\/\1>/gi;

const NON_CONTENT_VOID = /<(link|meta|base)[^>]*\/?>/gi;

const MAIN_CONTENT_SELECTORS = [
  /<div[^>]*id=["']mw-content-text["'][^>]*>([\s\S]*?)<div[^>]*class=["']printfooter/i,
  /<div[^>]*class=["'][^"']*mw-parser-output[^"']*["'][^>]*>([\s\S]*?)<div[^>]*class=["']printfooter/i,
  /<main[^>]*>([\s\S]*?)<\/main>/i,
  /<article[^>]*>([\s\S]*?)<\/article>/i,
  /<div[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/div>/i,
  /<div[^>]*id=["']AppRouter-main-content["'][^>]*>([\s\S]*?)<\/div>/i,
  /<div[^>]*data-testid=["'][^"']*post[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  /<shreddit-post[^>]*>([\s\S]*?)<\/shreddit-post>/i,
];

function extractWikipediaContent(html) {
  const startMatch = html.match(/<div[^>]*id=["']mw-content-text["'][^>]*>/i);
  if (!startMatch) return null;

  const start = startMatch.index + startMatch[0].length;
  const tail = html.slice(start);
  const endPatterns = [
    /<div[^>]*class=["']printfooter/i,
    /<div[^>]*id=["']catlinks/i,
    /<noscript/i,
  ];

  let end = tail.length;
  for (const pattern of endPatterns) {
    const idx = tail.search(pattern);
    if (idx !== -1 && idx < end) end = idx;
  }

  const chunk = tail.slice(0, end).trim();
  return chunk.length > 100 ? chunk : null;
}

const CHROME_SELECTORS =
  /<(nav|header|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi;

const CODE_TAGS =
  /<(script|style|noscript|template|code)[^>]*>[\s\S]*?<\/\1>/gi;

function createTurndown(baseUrl) {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
  });

  td.use(gfm);

  td.addRule('dropNonContent', {
    filter: ['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'link', 'meta', 'code'],
    replacement: () => '',
  });

  td.addRule('preMarkdownTable', {
    filter: (node) => {
      if (node.nodeName !== 'PRE') return false;
      const text = (node.textContent ?? '').replace(/\\n/g, '\n').trim();
      return isMarkdownTable(text);
    },
    replacement: (_content, node) => {
      const text = (node.textContent ?? '').replace(/\\n/g, '\n').trim();
      return `\n\n${text}\n\n`;
    },
  });

  td.addRule('dropDataImages', {
    filter: (node) =>
      node.nodeName === 'IMG' && String(node.getAttribute('src') ?? '').startsWith('data:'),
    replacement: () => '',
  });

  td.addRule('imagesToAlt', {
    filter: 'img',
    replacement: (_, node) => {
      const alt = node.getAttribute('alt')?.trim();
      let src = node.getAttribute('src') ?? node.getAttribute('data-src') ?? '';
      if (!alt && !src) return '';
      if (src.startsWith('data:')) return '';
      if (src.startsWith('//')) src = `https:${src}`;
      else if (baseUrl && src && !/^https?:/i.test(src)) {
        try {
          src = new URL(src, baseUrl).href;
        } catch {
          /* keep relative */
        }
      }
      return `\n\n![${alt || 'Image'}](${src})\n\n`;
    },
  });

  td.addRule('svg', {
    filter: 'svg',
    replacement: (_, node) => {
      const label = node.getAttribute('aria-label');
      return label ? `[${label}]` : '';
    },
  });

  return td;
}

function looksLikeCss(text) {
  const t = text.trim();
  return (
    t.length > 120 &&
    (/:root\s*\{/.test(t) ||
      /--[\w-]+\s*:/.test(t) ||
      /\.[\w-]+(?:[,>~\s\{])/.test(t))
  );
}

function looksLikeJson(text) {
  const t = text.trim();
  if (t.length < 80) return false;
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  return (
    t.includes('"require"') ||
    t.includes('"__bbox"') ||
    t.includes('"serverJS"') ||
    (t.startsWith('{') && t.endsWith('}') && (t.match(/"/g) ?? []).length > 20)
  );
}

function isNoiseLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (looksLikeCss(t)) return true;
  if (looksLikeJson(t)) return true;
  if (/!\[[^\]]*\]\(data:/.test(t)) return true;
  if (t.startsWith('data:image')) return true;
  if (t.length > 500 && !/\s/.test(t.slice(0, 200))) return true;
  return false;
}

function expandCollapsedTableLine(line) {
  const t = line.trim();
  if (!t.startsWith('|') || t.includes('\n')) return line;
  if (!/\|\s+\|/.test(t)) return line;

  const segments = t.split(/\|\s+\|/);
  if (segments.length < 3) return line;

  const rows = segments.map((seg) => {
    const inner = seg.replace(/^\|/, '').replace(/\|$/, '').trim();
    return `| ${inner} |`;
  });

  if (!/^\|\s*[-:| ]+\|\s*$/.test(rows[1])) return line;

  return rows.join('\n');
}

function expandCollapsedMarkdownTables(markdown) {
  return markdown
    .split('\n')
    .map(expandCollapsedTableLine)
    .join('\n');
}

function cleanMarkdown(markdown) {
  const expanded = expandCollapsedMarkdownTables(markdown);
  const lines = expanded.split('\n').filter((line) => !isNoiseLine(line));
  return lines
    .join('\n')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '')
    .replace(/^\[SVG: [^\]]+\]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeHtml(html, options = {}) {
  let out = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(NON_CONTENT_TAGS, '')
    .replace(NON_CONTENT_VOID, '')
    .replace(CODE_TAGS, '');

  if (options.stripChrome) {
    out = out.replace(CHROME_SELECTORS, '');
  }
  return out;
}

function extractPageHtml(html, options = {}) {
  const fullPage = options.fullPage !== false;
  if (!fullPage) {
    const wiki = extractWikipediaContent(html);
    if (wiki) return wiki;

    for (const pattern of MAIN_CONTENT_SELECTORS) {
      const match = html.match(pattern);
      if (match?.[1]?.trim().length > 80) return match[1];
    }
  }

  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return body ? body[1] : html;
}

function extractMainContentHtml(html) {
  return extractPageHtml(html, { fullPage: true });
}

/** Strip scripts/styles and cap size before Turndown (avoids multi-minute regex on huge pages). */
function extractHtmlTitle(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch?.[1]?.trim()) return titleMatch[1].trim();
  const og =
    html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ??
    html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  return og?.[1]?.trim() ?? null;
}

function slimHtmlForExtraction(html, maxBytes = 100000) {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');

  const narrowed = extractPageHtml(out, { fullPage: false });
  if (narrowed.length > 200 && narrowed.length < out.length) out = narrowed;

  out = sanitizeHtml(out, { stripChrome: true });
  if (out.length > maxBytes) out = out.slice(0, maxBytes);
  return out;
}

function collectLinksFromHtmlBlock(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const re = /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1].trim();
    const text = stripTags(m[2]).replace(/\s+/g, ' ').trim();
    if (!text || !href || href.startsWith('javascript:') || href === '#') continue;
    try {
      href = href.startsWith('http') ? href : new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    const key = `${href}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ text, href });
  }
  return links;
}

function normalizeLinkHref(href) {
  try {
    const u = new URL(href);
    let path = u.pathname.replace(/\/$/, '') || '/';
    path = path.replace(/^\/(en|ai)\//, '/');
    return `${u.origin}${path}${u.search}`;
  } catch {
    return href.split('#')[0].replace(/\/$/, '');
  }
}

function dedupeLinkList(links) {
  const byHref = new Map();
  for (const item of links) {
    const text = (item.text || '').trim();
    const href = (item.href || '').trim();
    if (!text || !href) continue;
    const key = normalizeLinkHref(href);
    const existing = byHref.get(key);
    if (!existing || text.length > existing.text.length) {
      byHref.set(key, { text, href });
    }
  }
  return [...byHref.values()].sort((a, b) => a.text.localeCompare(b.text));
}

function extractSectionLinksFromHtml(html, baseUrl) {
  const navLinks = [];
  const headerLinks = [];
  const footerLinks = [];
  const asideLinks = [];
  const breadcrumbLinks = [];

  const navRe = /<nav([^>]*)>([\s\S]*?)<\/nav>/gi;
  let m;
  while ((m = navRe.exec(html)) !== null) {
    const attrs = m[1] || '';
    const inner = m[2];
    const isBreadcrumb =
      /breadcrumb/i.test(attrs) ||
      /aria-label=["'][^"']*breadcrumb/i.test(attrs);
    const links = collectLinksFromHtmlBlock(inner, baseUrl);
    if (isBreadcrumb) breadcrumbLinks.push(...links);
    else navLinks.push(...links);
  }

  const headerRe = /<header[^>]*>([\s\S]*?)<\/header>/gi;
  while ((m = headerRe.exec(html)) !== null) {
    headerLinks.push(...collectLinksFromHtmlBlock(m[1], baseUrl));
  }

  const footerRe = /<footer[^>]*>([\s\S]*?)<\/footer>/gi;
  while ((m = footerRe.exec(html)) !== null) {
    footerLinks.push(...collectLinksFromHtmlBlock(m[1], baseUrl));
  }

  const asideRe = /<aside[^>]*>([\s\S]*?)<\/aside>/gi;
  while ((m = asideRe.exec(html)) !== null) {
    asideLinks.push(...collectLinksFromHtmlBlock(m[1], baseUrl));
  }

  const breadcrumbClassRe =
    /<(?:ol|ul|div)[^>]*class=["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/(?:ol|ul|div)>/gi;
  while ((m = breadcrumbClassRe.exec(html)) !== null) {
    breadcrumbLinks.push(...collectLinksFromHtmlBlock(m[1], baseUrl));
  }

  const roleNavRe =
    /<[^>]+role=["']navigation["'][^>]*>([\s\S]*?)<\/[^>]+>/gi;
  while ((m = roleNavRe.exec(html)) !== null) {
    navLinks.push(...collectLinksFromHtmlBlock(m[1], baseUrl));
  }

  const menuDivRe =
    /<div[^>]*class=["'][^"']*(?:navbar|nav-bar|site-nav|navigation|header-nav|main-nav|top-nav|NavBar|Navigation)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  while ((m = menuDivRe.exec(html)) !== null) {
    navLinks.push(...collectLinksFromHtmlBlock(m[1], baseUrl));
  }

  return {
    navLinks: dedupeLinkList(navLinks),
    headerLinks: dedupeLinkList(headerLinks),
    footerLinks: dedupeLinkList(footerLinks),
    asideLinks: dedupeLinkList(asideLinks),
    breadcrumbLinks: dedupeLinkList(breadcrumbLinks),
  };
}

async function extractPageContent(page, options = {}) {
  const llmMode = options.llmMode === true;
  return page.evaluate((llm) => {
    const CODE_SEL =
      'script, style, noscript, template, iframe, link[rel="stylesheet"], meta, object, embed, pre, code';
    const CHROME_SEL = 'nav, header, footer, aside, form, [role="navigation"], [role="banner"], [role="contentinfo"]';

    function collectLinks(root) {
      const seen = new Set();
      const links = [];
      root.querySelectorAll('a[href]').forEach((a) => {
        const href = a.href;
        const text = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
        if (!text || !href || href.startsWith('javascript:') || href.endsWith('#')) return;
        const key = href + '|' + text;
        if (seen.has(key)) return;
        seen.add(key);
        links.push({ text, href });
      });
      return links;
    }

    function pickMainRoot() {
      const selectors = [
        'article',
        'main',
        '[role="main"]',
        '.post-content',
        '.article-content',
        '.article-body',
        '.entry-content',
        '.markdown',
        '#content',
        '#mw-content-text',
        '.mw-parser-output',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && (el.innerText?.trim().length ?? 0) > 80) return el;
      }
      let best = null;
      let bestLen = 0;
      for (const el of document.body.querySelectorAll('article, main, section, div')) {
        const len = el.innerText?.trim().length ?? 0;
        if (len > bestLen) {
          bestLen = len;
          best = el;
        }
      }
      return bestLen > 120 ? best : document.body;
    }

    if (llm) {
      const root = pickMainRoot();
      const clone = root.cloneNode(true);
      clone.querySelectorAll(`${CODE_SEL}, ${CHROME_SEL}`).forEach((el) => el.remove());
      clone.querySelectorAll('svg, img[src^="data:"]').forEach((el) => el.remove());
      return {
        bodyHtml: clone.innerHTML,
        navLinks: [],
        headerLinks: [],
        footerLinks: [],
        asideLinks: [],
        breadcrumbLinks: [],
      };
    }

    const navLinks = [];
    document.querySelectorAll('nav, [role="navigation"]').forEach((el) => {
      const isBreadcrumb =
        el.classList?.contains('breadcrumb') ||
        /breadcrumb/i.test(el.getAttribute('aria-label') || '');
      if (isBreadcrumb) return;
      navLinks.push(...collectLinks(el));
    });

    document
      .querySelectorAll('[class*="nav" i], [class*="navbar" i], [class*="menu" i]')
      .forEach((el) => {
        if (el.closest('footer, [role="contentinfo"]')) return;
        if (el.closest('.breadcrumb, [class*="breadcrumb" i], nav[aria-label*="breadcrumb" i]')) return;
        navLinks.push(...collectLinks(el));
      });

    const headerLinks = [];
    document.querySelectorAll('header, [role="banner"]').forEach((el) => {
      headerLinks.push(...collectLinks(el));
    });

    const footerLinks = [];
    document.querySelectorAll('footer, [role="contentinfo"]').forEach((el) => {
      footerLinks.push(...collectLinks(el));
    });

    const asideLinks = [];
    document.querySelectorAll('aside, [role="complementary"], .sidebar, .side-bar').forEach((el) => {
      asideLinks.push(...collectLinks(el));
    });

    const breadcrumbLinks = [];
    document
      .querySelectorAll(
        'nav[aria-label*="breadcrumb" i], .breadcrumb, [class*="breadcrumb"], ol.breadcrumb, ul.breadcrumb',
      )
      .forEach((el) => {
        breadcrumbLinks.push(...collectLinks(el));
      });

    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(CODE_SEL).forEach((el) => el.remove());
    clone.querySelectorAll(`${CHROME_SEL}, .breadcrumb, [class*="breadcrumb"]`).forEach((el) => el.remove());
    clone.querySelectorAll('svg, img[src^="data:"]').forEach((el) => el.remove());

    return {
      bodyHtml: clone.innerHTML,
      navLinks,
      headerLinks,
      footerLinks,
      asideLinks,
      breadcrumbLinks,
    };
  }, llmMode);
}

async function extractHtmlFromPage(page) {
  const { bodyHtml } = await extractPageContent(page);
  return bodyHtml;
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

function resolveTitle(html, url) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return titleMatch ? titleMatch[1].trim() : url;
}

function htmlToMarkdown(html, options = {}) {
  const outputMode = options.outputMode ?? 'llm';
  const fullPage = options.fullPage ?? outputMode === 'full';
  const td = createTurndown(options.url);

  const sectionLinks =
    outputMode === 'full'
      ? (options.sectionLinks ?? extractSectionLinksFromHtml(options.fullHtml ?? html, options.url))
      : { navLinks: [], headerLinks: [], footerLinks: [], asideLinks: [], breadcrumbLinks: [] };

  const contentHtml =
    options.mainContent || outputMode === 'llm'
      ? html
      : extractPageHtml(html, { fullPage });

  const prepared = sanitizeHtml(contentHtml, { stripChrome: outputMode === 'full' });
  const raw = td.turndown(prepared);
  const cleaned = cleanMarkdown(raw);
  const title = options.title ?? resolveTitle(options.fullHtml ?? html, options.url);

  const structured = formatMarkdown(cleaned, {
    mode: outputMode,
    title,
    url: options.url,
    description: options.description,
    llmStrict: options.llmStrict,
    navLinks: outputMode === 'full' ? (options.navLinks ?? sectionLinks.navLinks) : [],
    headerLinks: outputMode === 'full' ? (options.headerLinks ?? sectionLinks.headerLinks) : [],
    footerLinks: outputMode === 'full' ? (options.footerLinks ?? sectionLinks.footerLinks) : [],
    asideLinks: outputMode === 'full' ? (options.asideLinks ?? sectionLinks.asideLinks) : [],
    breadcrumbLinks:
      outputMode === 'full' ? (options.breadcrumbLinks ?? sectionLinks.breadcrumbLinks) : [],
  });
  const wordCount = countWords(structured);

  if (!options.frontMatter) {
    return { markdown: structured, wordCount, meta: null };
  }

  const meta = extractPageMeta(options.fullHtml ?? html, options.url, {
    ...options.stats,
    wordCount,
  });

  const withFrontMatter = buildFrontMatter(meta) + structured;
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

function isMarkdownTable(text) {
  const lines = text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;
  if (!lines[0].startsWith('|') || !lines[0].endsWith('|')) return false;
  return lines.some((l) => /^\|[\s\-:|]+\|$/.test(l));
}

/** Converts <pre> blocks that contain markdown tables into raw table text. */
function promotePreMarkdownTables(html) {
  return html.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (match, inner) => {
    let text = inner.replace(/<[^>]+>/g, '');
    text = decodeEntities(text).replace(/\\n/g, '\n').trim();
    if (!isMarkdownTable(text)) return '';
    return `\n\n${text}\n\n`;
  });
}

function htmlToMarkdownBuiltin(html, options = {}) {
  const outputMode = options.outputMode ?? 'llm';
  const fullPage = options.fullPage ?? outputMode === 'full';
  let content = sanitizeHtml(extractPageHtml(html, { fullPage }));

  content = content
    .replace(/<div[^>]*class=["'][^"']*navbox[^"']*["'][\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class=["'][^"']*sidebar[^"']*["'][\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*role=["']navigation["'][\s\S]*?<\/div>/gi, '')
    .replace(/<table[\s\S]*?<\/table>/gi, '')
    .replace(/<table[^>]*class=["'][^"']*navbox[^"']*["'][\s\S]*?<\/table>/gi, '')
    .replace(/<span[^>]*class=["'][^"']*mwe-math[^"']*["'][\s\S]*?<\/span>/gi, '')
    .replace(/<span[^>]*class=["'][^"']*texhtml[^"']*["'][\s\S]*?<\/span>/gi, '')
    .replace(/<sup[^>]*class=["'][^"']*reference[^"']*["'][\s\S]*?<\/sup>/gi, '')
    .replace(/<span[^>]*class=["'][^"']*mw-editsection[^"']*["'][\s\S]*?<\/span>/gi, '')
    .replace(/<div[^>]*id=["']catlinks["'][\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*id=["']toc["'][\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class=["'][^"']*(navbox|reflist|hatnote|metadata|mw-references|thumb|infobox|catlinks|shortdescription|side-box|sistersitebox)[^"']*["'][\s\S]*?<\/div>/gi, '');

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
    if (/action=edit|#cite_/i.test(href)) return text;
    if (href.startsWith('#')) return text;
    if (!href.startsWith('http') && !href.startsWith('/')) return text;
    const abs = href.startsWith('/') && options.url
      ? new URL(href, options.url).href
      : href.startsWith('//')
        ? `https:${href}`
        : href;
    return `[${text}](${abs})`;
  });

  content = content
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${stripTags(t).trim()}`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => `\n\n${stripTags(t).trim()}\n\n`)
    .replace(/<br\s*\/?>/gi, '\n');

  let text = cleanMarkdown(decodeEntities(stripTags(content)));
  const title = resolveTitle(html, options.url);
  const sectionLinks = extractSectionLinksFromHtml(html, options.url);
  text = formatMarkdown(text, {
    mode: outputMode,
    url: options.url,
    title,
    llmStrict: options.llmStrict,
    navLinks: outputMode === 'full' ? sectionLinks.navLinks : [],
    headerLinks: outputMode === 'full' ? sectionLinks.headerLinks : [],
    footerLinks: outputMode === 'full' ? sectionLinks.footerLinks : [],
    asideLinks: outputMode === 'full' ? sectionLinks.asideLinks : [],
    breadcrumbLinks: outputMode === 'full' ? sectionLinks.breadcrumbLinks : [],
  });
  const wordCount = countWords(text);

  if (!options.frontMatter) {
    return { markdown: text, wordCount, meta: null };
  }

  const meta = extractPageMeta(html, options.url, { ...options.stats, wordCount });
  const metaTitle = meta.title.replace(/ - Wikipedia$/, '');
  const markdown = buildFrontMatter({ ...meta, title: metaTitle }) + text;
  return { markdown, wordCount, meta };
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

module.exports = {
  htmlToMarkdown,
  htmlToMarkdownBuiltin,
  extractPageMeta,
  extractHtmlFromPage,
  extractPageContent,
  extractSectionLinksFromHtml,
  createTurndown,
  cleanMarkdown,
  sanitizeHtml,
  formatMarkdown,
  slimHtmlForExtraction,
  extractHtmlTitle,
  resolveTitle,
};
