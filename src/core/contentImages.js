const { URL } = require('node:url');
const { extractMetaContent } = require('./snapshot');

const PLACEHOLDER_IMAGE_RE =
  /redditstatic\.com\/(new-icon|icon|interstitial|self|default|nsfw|spoiler|thumb)|reddit\.com\/static\/pixel|communityIcon|styles\.redditmedia\.com\/t5_|\/favicon|\/logo|sprite|pixel\.gif|1x1\.|\/spacer\.|\/avatar\//i;

function resolveImageUrl(src, baseUrl) {
  if (!src || src.startsWith('data:')) return null;
  try {
    const raw = src.startsWith('//') ? `https:${src}` : src;
    return new URL(raw, baseUrl || undefined).href;
  } catch {
    return null;
  }
}

function extractOgImage(html, baseUrl) {
  const raw =
    extractMetaContent(html, 'og:image') ||
    extractMetaContent(html, 'og:image:secure_url') ||
    extractMetaContent(html, 'twitter:image') ||
    extractMetaContent(html, 'twitter:image:src');
  if (!raw) return null;
  const url = resolveImageUrl(raw, baseUrl);
  if (!url || PLACEHOLDER_IMAGE_RE.test(url)) return null;
  return url;
}

function extractImagesFromHtml(html, baseUrl) {
  if (!html) return [];

  const found = new Map();

  const add = (src, alt = 'Image') => {
    const url = resolveImageUrl(src, baseUrl);
    if (!url || PLACEHOLDER_IMAGE_RE.test(url)) return;
    const key = url.split('?')[0];
    if (!found.has(key)) found.set(key, { alt: alt.trim() || 'Image', src: url });
  };

  const imgRe = /<img[^>]+>/gi;
  let match;
  while ((match = imgRe.exec(html)) !== null) {
    const tag = match[0];
    const src =
      tag.match(/\ssrc=["']([^"']+)["']/i)?.[1] ||
      tag.match(/\sdata-src=["']([^"']+)["']/i)?.[1] ||
      tag.match(/\sdata-original=["']([^"']+)["']/i)?.[1];
    const alt = tag.match(/\salt=["']([^"']*)["']/i)?.[1] ?? 'Image';
    if (src) add(src, alt);
  }

  const bgRe = /background-image:\s*url\(['"]?([^'")]+)/gi;
  while ((match = bgRe.exec(html)) !== null) {
    add(match[1], 'Image');
  }

  const og = extractOgImage(html, baseUrl);
  if (og) add(og, 'Preview');

  return [...found.values()];
}

function extractImagesFromMarkdown(markdown) {
  const found = new Map();
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(markdown)) !== null) {
    const alt = match[1].trim() || 'Image';
    const src = match[2].trim();
    if (!src || src.startsWith('data:') || src.startsWith('./')) continue;
    const key = src.split('?')[0];
    if (!found.has(key)) found.set(key, { alt, src });
  }
  return [...found.values()];
}

function absolutizeMarkdownImages(markdown, baseUrl) {
  if (!markdown || !baseUrl) return markdown;
  return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full, alt, src) => {
    const trimmed = src.trim();
    if (
      trimmed.startsWith('http') ||
      trimmed.startsWith('data:') ||
      trimmed.startsWith('./') ||
      trimmed.startsWith('#')
    ) {
      return full;
    }
    const abs = resolveImageUrl(trimmed, baseUrl);
    return abs ? `![${alt}](${abs})` : full;
  });
}

function injectImagesSection(markdown, images) {
  if (!images.length) return markdown;

  const block = [
    '',
    '## Images',
    '',
    ...images.map(({ alt, src }) => `![${alt}](${src})`),
    '',
  ].join('\n');

  const linksIdx = markdown.search(/\n---\s*\n## (?:All Links|Links)\b/);
  if (linksIdx !== -1) {
    return `${markdown.slice(0, linksIdx)}\n---${block}${markdown.slice(linksIdx)}`;
  }

  if (/^---\n[\s\S]*?\n---\n/.test(markdown)) {
    return markdown.replace(/^(---\n[\s\S]*?\n---\n)/, `$1${block}`);
  }

  return `${markdown.trim()}\n${block}`;
}

function enrichMarkdownWithImages(markdown, html, baseUrl, options = {}) {
  if (options.includeImages === false) return markdown;

  let out = absolutizeMarkdownImages(markdown, baseUrl);
  const fromMd = extractImagesFromMarkdown(out);
  const fromHtml = extractImagesFromHtml(html, baseUrl);
  const merged = new Map();

  for (const img of [...fromMd, ...fromHtml]) {
    const key = img.src.split('?')[0];
    if (!merged.has(key)) merged.set(key, img);
  }

  const images = [...merged.values()];
  if (!images.length) return out;

  const existingKeys = new Set(fromMd.map((img) => img.src.split('?')[0]));
  const missing = images.filter((img) => !existingKeys.has(img.src.split('?')[0]));

  if (missing.length && /\n## Content\s*\n/.test(out) && !/\n## Images\b/.test(out)) {
    const block = missing.map(({ alt, src }) => `![${alt}](${src})`).join('\n');
    out = out.replace(/(\n## Content\s*\n)/, `$1${block}\n\n`);
  } else if (missing.length && !/\n## Images\b/.test(out)) {
    out = injectImagesSection(out, missing.length ? missing : images);
  }

  return out;
}

function addFrontMatterField(markdown, key, value) {
  if (!markdown || value == null || value === '') return markdown;
  const match = markdown.match(/^(---\n)([\s\S]*?)(\n---\n)/);
  if (!match) return markdown;
  const body = match[2];
  const line = `${key}: ${Array.isArray(value) ? JSON.stringify(value) : `"${String(value).replace(/"/g, '\\"')}"`}`;
  if (new RegExp(`^${key}:`, 'm').test(body)) {
    return markdown.replace(new RegExp(`^${key}:.*$`, 'm'), line);
  }
  return `${match[1]}${body}\n${line}${match[3]}${markdown.slice(match[0].length)}`;
}

function addImageFrontMatter(markdown, images) {
  if (!images.length) return markdown;
  const urls = images.map((img) => img.src);
  return addFrontMatterField(markdown, 'images', urls);
}

module.exports = {
  resolveImageUrl,
  extractOgImage,
  extractImagesFromHtml,
  extractImagesFromMarkdown,
  absolutizeMarkdownImages,
  enrichMarkdownWithImages,
  addImageFrontMatter,
  injectImagesSection,
  addFrontMatterField,
};
