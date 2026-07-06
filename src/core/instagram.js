const { URL } = require('node:url');
const { fetchUrl } = require('./httpClient');

const INSTAGRAM_HOSTS = ['instagram.com', 'www.instagram.com'];

const IG_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

const POST_PATH = /^\/(p|reel|reels|tv)\/([^/?#]+)/i;

const RESERVED_SEGMENTS = new Set([
  'explore',
  'accounts',
  'direct',
  'stories',
  'p',
  'reel',
  'reels',
  'tv',
  'about',
  'legal',
  'developer',
  'api',
  'graphql',
  'static',
  'embed',
]);

function isInstagramUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return INSTAGRAM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function parseInstagramUrl(url) {
  try {
    const parsed = new URL(url);
    const postMatch = parsed.pathname.match(POST_PATH);
    if (postMatch) {
      let kind = postMatch[1].toLowerCase();
      if (kind === 'reels') kind = 'reel';
      return { kind, shortcode: postMatch[2], username: null };
    }

    const segment = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
    if (segment && !RESERVED_SEGMENTS.has(segment.toLowerCase())) {
      return { kind: 'profile', username: segment, shortcode: null };
    }

    return { kind: 'unknown', shortcode: null, username: null };
  } catch {
    return { kind: 'unknown', shortcode: null, username: null };
  }
}

function normalizeCanonicalUrl(url) {
  const parsed = parseInstagramUrl(url);
  if (parsed.kind === 'profile' && parsed.username) {
    return `https://www.instagram.com/${parsed.username}/`;
  }
  if (parsed.shortcode) {
    const segment = parsed.kind === 'reel' ? 'reel' : parsed.kind === 'tv' ? 'tv' : 'p';
    return `https://www.instagram.com/${segment}/${parsed.shortcode}/`;
  }
  return url;
}

function toInstagramEmbedUrl(url) {
  const parsed = parseInstagramUrl(url);
  if (parsed.kind === 'profile' && parsed.username) {
    return `https://www.instagram.com/${parsed.username}/embed/`;
  }
  if (parsed.shortcode) {
    const segment = parsed.kind === 'reel' ? 'reel' : parsed.kind === 'tv' ? 'tv' : 'p';
    return `https://www.instagram.com/${segment}/${parsed.shortcode}/embed/captioned/`;
  }
  return url;
}

function decodeHtml(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractMeta(html, property) {
  const re = new RegExp(`property="${property}" content="([^"]+)"`, 'i');
  return decodeHtml(html.match(re)?.[1] ?? '');
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
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

function postToMarkdown(data, url) {
  const kind = parseInstagramUrl(url).kind;
  const label = kind === 'reel' ? 'Reel' : kind === 'tv' ? 'IGTV' : 'Post';
  const parts = [
    `# ${data.title || `${label} by ${data.author_name}`}`,
    '',
    '> **Source:** Instagram public embed (no login)',
    '',
    '---',
    '',
    '## Content',
    '',
    `**Author:** [@${data.author_name}](${data.author_url})`,
    '',
  ];

  if (data.title) {
    parts.push(data.title);
    parts.push('');
  }

  if (data.thumbnail_url) {
    parts.push(`![${data.title || label}](${data.thumbnail_url})`);
    parts.push('');
  }

  parts.push('---', '', '## Links', '');
  parts.push(`- [View on Instagram](${url})`);
  if (data.author_url) {
    parts.push(`- [${data.author_name} profile](${data.author_url})`);
  }
  parts.push('');

  return parts.join('\n').trim();
}

function profileToMarkdown(title, description, url, username) {
  const parts = [
    `# ${title || username}`,
    '',
    '> **Source:** Instagram public profile (no login)',
    '',
    '---',
    '',
    '## Content',
    '',
  ];

  if (description) {
    parts.push(description);
    parts.push('');
  }

  parts.push(
    'Individual post listings require login. Use a direct post or reel URL for full caption and media.',
    '',
    '---',
    '',
    '## Links',
    '',
    `- [View profile on Instagram](${url})`,
    '',
  );

  return parts.join('\n').trim();
}

async function fetchOEmbed(url, options = {}) {
  const canonical = normalizeCanonicalUrl(url);
  const oembedUrl = `https://www.instagram.com/api/v1/oembed?url=${encodeURIComponent(canonical)}`;
  const res = await fetchUrl(oembedUrl, {
    userAgent: options.userAgent ?? IG_UA,
    timeout: options.timeout ?? 30000,
  });

  if (res.statusCode >= 400) {
    throw new Error(`ERR_INSTAGRAM_OEMBED_${res.statusCode}: oEmbed returned ${res.statusCode}`);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error('ERR_INSTAGRAM_OEMBED_PARSE: Invalid oEmbed response');
  }

  if (!data.title && !data.author_name) {
    throw new Error('ERR_INSTAGRAM_OEMBED_EMPTY: oEmbed returned no content');
  }

  return data;
}

async function fetchProfileMeta(url, options = {}) {
  const canonical = normalizeCanonicalUrl(url);
  const res = await fetchUrl(canonical, {
    userAgent: options.userAgent ?? IG_UA,
    timeout: options.timeout ?? 30000,
  });

  if (res.statusCode >= 400) {
    throw new Error(`ERR_NAV_HTTP_${res.statusCode}: Instagram returned ${res.statusCode}`);
  }

  const title = extractMeta(res.body, 'og:title') || extractMeta(res.body, 'twitter:title');
  const description =
    extractMeta(res.body, 'og:description') || extractMeta(res.body, 'twitter:description');

  if (!title && !description) {
    throw new Error('ERR_INSTAGRAM_PROFILE_EMPTY: No public profile metadata found');
  }

  return { title, description };
}

async function scrapeInstagramPublic(url, options = {}) {
  const start = Date.now();
  const parsed = parseInstagramUrl(url);
  let markdown;
  let title;
  let status = 200;
  let source = 'instagram.com';

  if (parsed.kind === 'profile' && parsed.username) {
    const meta = await fetchProfileMeta(url, options);
    title = meta.title || parsed.username;
    markdown = profileToMarkdown(meta.title, meta.description, normalizeCanonicalUrl(url), parsed.username);
    source = 'instagram-profile-og';
  } else if (parsed.shortcode) {
    const data = await fetchOEmbed(url, options);
    title = data.title || `${data.author_name} on Instagram`;
    markdown = postToMarkdown(data, normalizeCanonicalUrl(url));
    source = 'instagram-oembed';
  } else {
    throw new Error('ERR_INSTAGRAM_UNSUPPORTED: URL type not supported for public scrape');
  }

  const wordCount = countWords(markdown);

  if (options.frontMatter !== false) {
    const meta = {
      title,
      url,
      scraped_at: new Date().toISOString(),
      source,
      login_required: false,
      word_count: wordCount,
      scrape_duration_ms: Date.now() - start,
    };
    markdown = buildFrontMatter(meta) + markdown + '\n';
  }

  return {
    markdown,
    wordCount,
    title,
    status,
    navMs: Date.now() - start,
    method: 'instagram-public',
  };
}

module.exports = {
  isInstagramUrl,
  parseInstagramUrl,
  normalizeCanonicalUrl,
  toInstagramEmbedUrl,
  scrapeInstagramPublic,
};
