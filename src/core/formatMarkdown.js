/**
 * Post-processes scraped markdown into structured sections.
 * Keeps all readable content + links inline; strips code/noise only.
 */

const { applyLlmStrict } = require('./llmStrict');

function fixEscapes(text) {
  return text
    .replace(/\\#/g, '#')
    .replace(/\\\*\\\*/g, '**')
    .replace(/\\\*/g, '*')
    .replace(/\\([\[\]])/g, '$1')
    .replace(/\*\*\\?\*\\?\*([^*]+)\*\*\\?\*\\?\*/g, '**$1**')
    .replace(/\*\*\*\*([^*]+)\*\*\*\*\*/g, '**$1**');
}

function normalizeHeading(line) {
  const fixed = fixEscapes(line.trim());
  const m = fixed.match(/^(#{1,6})\s+(.*)$/);
  if (!m) return fixed;
  const body = m[2].replace(/^#+\s*/, '').trim();
  if (!body) return null;
  return `${m[1]} ${body}`;
}

const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

function normalizeHref(href) {
  try {
    const u = new URL(href);
    let path = u.pathname.replace(/\/$/, '') || '/';
    path = path.replace(/^\/(en|ai)\//, '/');
    return `${u.origin}${path}${u.search}`;
  } catch {
    return href.split('#')[0].replace(/\/$/, '');
  }
}

function cleanLinkLabel(text) {
  const t = String(text ?? '').trim();
  const md = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (md) return md[1].trim();
  return t.replace(/\s+/g, ' ');
}

function dedupeLinks(links) {
  const byHref = new Map();
  for (const item of links) {
    const text = cleanLinkLabel(item.text || item.label || '');
    const href = (item.href || item.url || '').trim();
    if (!text || !href) continue;
    if (href.startsWith('javascript:') || href === '#') continue;
    const key = normalizeHref(href);
    const existing = byHref.get(key);
    if (!existing || text.length > existing.text.length) {
      byHref.set(key, { text, href });
    }
  }
  return [...byHref.values()].sort((a, b) => a.text.localeCompare(b.text));
}

function extractLinks(text) {
  const links = new Map();
  let match;
  const re = new RegExp(LINK_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    let label = fixEscapes(match[1]).trim();
    let url = match[2].trim();

    label = label.replace(/^\[+|\]+$/g, '').replace(/\\([\[\]])/g, '$1').trim();
    url = url.replace(/\\([\[\]])/g, '$1').trim();

    const nested = label.match(/\[([^\]]*)\]\(([^)]+)\)/);
    if (nested) {
      label = nested[1].trim();
      url = nested[2].trim();
    }

    if (!url || url.startsWith('#') || url.startsWith('javascript:')) continue;
    if (/_next\/image/i.test(url)) continue;
    if (label.includes('![')) continue;
    if (!label) continue;

    const key = url.split('?')[0];
    const existing = links.get(key);
    if (!existing || label.length > existing.text.length) {
      links.set(key, { text: label, href: url });
    }
  }
  return [...links.values()].sort((a, b) => a.text.localeCompare(b.text));
}

function extractImages(text) {
  const images = new Map();
  let match;
  const re = new RegExp(IMAGE_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    const alt = fixEscapes(match[1]).trim();
    const src = match[2].trim();
    if (!src || src.startsWith('data:')) continue;
    if (/_next\/image.*logo/i.test(src) && /logo/i.test(alt)) continue;
    const key = src.split('?')[0];
    if (!images.has(key)) images.set(key, { alt: alt || 'Image', src });
  }
  return [...images.values()];
}

function cleanLine(line) {
  return fixEscapes(line)
    .replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '')
    .trim();
}

function isCodeNoise(line) {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith('```')) return true;
  if (/^`\{/.test(t) || /^`\[/.test(t)) return true;
  if (looksLikeJson(t)) return true;
  if (looksLikeCss(t)) return true;
  if (/!\[[^\]]*\]\(data:/.test(t)) return true;
  return false;
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

function isStructuralLine(line) {
  const t = line.trim();
  return (
    /^#{1,6}\s/.test(t) ||
    /^[-*+]\s/.test(t) ||
    /^\d+\.\s/.test(t) ||
    /^```/.test(t) ||
    /^\|/.test(t) ||
    /^>/.test(t)
  );
}

function splitFrontMatter(raw) {
  if (!raw.startsWith('---')) return { frontMatter: '', body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { frontMatter: '', body: raw };
  return {
    frontMatter: raw.slice(0, end + 4).trim(),
    body: raw.slice(end + 4).trim(),
  };
}

function extractRawBody(body) {
  const contentMatch = body.match(/## Content\s*\n([\s\S]*?)(?:\n---\s*\n## |\n## (?:All Links|Links|Images|Navigation|Footer))/);
  if (contentMatch) return contentMatch[1].trim();
  return body;
}

function parseContentBlocks(body, options = {}) {
  const lines = body.split('\n');
  const blocks = [];
  let i = 0;
  let skippedTitle = false;

  while (i < lines.length) {
    const line = cleanLine(lines[i]);

    if (!line) {
      i += 1;
      continue;
    }

    if (isCodeNoise(line)) {
      if (line.startsWith('```')) {
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith('```')) i += 1;
        if (i < lines.length) i += 1;
      } else {
        i += 1;
      }
      continue;
    }

    const heading = normalizeHeading(line);
    if (heading?.startsWith('#')) {
      const level = heading.match(/^#+/)[0].length;
      const headingText = heading.replace(/^#+\s*/, '').trim();
      if (!headingText) {
        i += 1;
        continue;
      }
      if (
        !skippedTitle &&
        level === 1 &&
        options.title &&
        (headingText === options.title || headingText.startsWith(options.title.slice(0, 20)))
      ) {
        skippedTitle = true;
        i += 1;
        continue;
      }
      blocks.push({ type: 'heading', text: heading });
      i += 1;
      continue;
    }

    if (line.startsWith('|')) {
      const chunk = [line];
      i += 1;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        chunk.push(cleanLine(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', text: chunk.join('\n') });
      continue;
    }

    if (/^[-*+]\s/.test(line) || /^\d+\.\s/.test(line)) {
      const chunk = [line];
      i += 1;
      while (i < lines.length) {
        const next = cleanLine(lines[i]);
        if (!next || (!/^[-*+]\s/.test(next) && !/^\d+\.\s/.test(next))) break;
        if (!isCodeNoise(next)) chunk.push(next);
        i += 1;
      }
      blocks.push({ type: 'list', text: chunk.join('\n') });
      continue;
    }

    const paraParts = [];
    while (i < lines.length) {
      const next = cleanLine(lines[i]);
      if (!next) break;
      if (isStructuralLine(next) || isCodeNoise(next)) break;
      paraParts.push(next);
      i += 1;
    }

    if (paraParts.length) {
      const merged = paraParts.join(' ').replace(/\s+/g, ' ').trim();
      if (merged.length >= 2) {
        blocks.push({ type: 'paragraph', text: merged });
      }
    } else {
      // Avoid infinite loop on structural lines that aren't headings/lists/tables.
      i += 1;
    }
  }

  return blocks;
}

function renderContentBlocks(blocks) {
  const lines = [];
  let lastType = null;

  for (const block of blocks) {
    if (block.type === 'heading') {
      if (lastType && lastType !== 'heading') lines.push('');
      lines.push(block.text, '');
      lastType = 'heading';
      continue;
    }

    if (block.type === 'paragraph' || block.type === 'list' || block.type === 'table') {
      lines.push(block.text, '');
      lastType = block.type;
    }
  }

  return lines.join('\n').trim();
}

function headingAnchor(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function escapeTableCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderLinkTable(links) {
  const deduped = dedupeLinks(links);
  if (!deduped.length) return ['_No links in this section._'];
  return [
    '| Link | URL |',
    '| --- | --- |',
    ...deduped.map((l) => `| ${escapeTableCell(l.text)} | ${l.href} |`),
  ];
}

function renderLinkSubsection(title, links) {
  const deduped = dedupeLinks(links);
  if (!deduped.length) return [];
  return [`### ${title}`, '', ...renderLinkTable(deduped), ''];
}

function buildTableOfContents(blocks) {
  const headings = blocks.filter((b) => b.type === 'heading');
  if (!headings.length) return [];

  const lines = ['## Table of Contents', ''];
  for (const block of headings) {
    const level = (block.text.match(/^#+/) ?? ['#'])[0].length;
    if (level === 1) continue;
    const text = block.text.replace(/^#+\s*/, '').trim();
    if (!text) continue;
    const indent = '  '.repeat(Math.max(0, level - 2));
    lines.push(`${indent}- [${text}](#${headingAnchor(text)})`);
  }
  if (lines.length <= 2) return [];
  lines.push('');
  return lines;
}

function renderLinkSection(title, links) {
  if (!links?.length) return [];
  const deduped = dedupeLinks(links);
  if (!deduped.length) return [];
  return ['', '---', '', `## ${title}`, '', ...renderLinkTable(deduped), ''];
}

function formatLlmMarkdown(rawMarkdown, options = {}) {
  const { body } = splitFrontMatter(rawMarkdown);
  const rawBody = extractRawBody(body);
  const blocks = parseContentBlocks(rawBody, { title: options.title });
  let content = renderContentBlocks(blocks);

  const title = options.title || rawBody.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Untitled';
  const cleanTitle = title.replace(/\s+-\s+Wikipedia$/i, '');
  const hasTitle = content.startsWith('#');

  const parts = [];
  if (!hasTitle) {
    parts.push(`# ${fixEscapes(cleanTitle)}`, '');
  }
  parts.push(content || '_No content extracted._');

  let result = `${parts.join('\n').trim()}\n`;

  const llmStrict = options.llmStrict !== false;
  if (llmStrict) {
    result = applyLlmStrict(result, { url: options.url, includeSource: true });
  }

  return result;
}

function formatMarkdown(rawMarkdown, options = {}) {
  const mode = options.mode ?? 'llm';
  if (mode === 'full') {
    return formatStructuredMarkdown(rawMarkdown, options);
  }
  return formatLlmMarkdown(rawMarkdown, options);
}

function formatStructuredMarkdown(rawMarkdown, options = {}) {
  const { frontMatter, body } = splitFrontMatter(rawMarkdown);
  const rawBody = extractRawBody(body);
  const inlineLinks = extractLinks(body);
  const images = extractImages(body);
  const blocks = parseContentBlocks(rawBody, { title: options.title });

  const titleFromBody = rawBody.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = options.title || titleFromBody || 'Scraped Page';
  const toc = buildTableOfContents(blocks);

  const parts = [];

  if (frontMatter) parts.push(frontMatter, '');

  parts.push(`# ${fixEscapes(title)}`, '');

  if (options.url) {
    parts.push(`> **Source:** ${options.url}`);
    if (options.description?.trim()) {
      parts.push(`> **Description:** ${options.description.trim().slice(0, 300)}`);
    }
    parts.push('> **Includes:** navigation, header, footer, sidebar, and main page content.');
    parts.push('');
  }

  if (toc.length) parts.push(...toc, '---', '');

  const siteMapParts = [
    ...renderLinkSubsection('Breadcrumbs', options.breadcrumbLinks),
    ...renderLinkSubsection('Main Navigation', options.navLinks),
    ...renderLinkSubsection('Header', options.headerLinks),
    ...renderLinkSubsection('Sidebar', options.asideLinks),
    ...renderLinkSubsection('Footer', options.footerLinks),
  ];

  if (siteMapParts.length) {
    parts.push('## Site Map', '', ...siteMapParts, '---', '');
  }

  parts.push('## Content', '');

  const content = renderContentBlocks(blocks);
  parts.push(content || '_No readable content extracted._', '');

  parts.push('---', '', '## All Links', '');

  const allLinks = dedupeLinks([
    ...(options.breadcrumbLinks ?? []),
    ...(options.navLinks ?? []),
    ...(options.headerLinks ?? []),
    ...(options.asideLinks ?? []),
    ...(options.footerLinks ?? []),
    ...inlineLinks.map((l) => ({ text: l.text, href: l.href })),
  ]);

  if (allLinks.length) {
    parts.push(...renderLinkTable(allLinks), '');
  } else {
    parts.push('_No links found._', '');
  }

  parts.push('---', '', '## Images', '');

  if (images.length) {
    for (const { alt, src } of images) {
      parts.push(`![${alt}](${src})`, '');
    }
  } else {
    parts.push('_No images extracted._', '');
  }

  return parts.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
}

module.exports = {
  formatMarkdown,
  formatLlmMarkdown,
  formatStructuredMarkdown,
  extractLinks,
  dedupeLinks,
};
