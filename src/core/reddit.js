const { URL } = require('node:url');
const { fetchUrl } = require('./httpClient');
const { htmlToMarkdownBuiltin } = require('./extractor');

const REDDIT_HOSTS = ['reddit.com', 'old.reddit.com', 'redd.it', 'www.reddit.com'];

const REDDIT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function isRedditUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return REDDIT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function toOldRedditUrl(url) {
  const parsed = new URL(url);
  parsed.hostname = 'old.reddit.com';
  parsed.protocol = 'https:';
  return parsed.href.replace(/\/$/, '') + (parsed.pathname.endsWith('/') ? '' : '');
}

function isPostUrl(url) {
  return /\/comments\/[a-z0-9]+\//i.test(url);
}

function absUrl(href, base) {
  if (!href) return '';
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function decodeHtml(text) {
  return text
    .replace(/&#32;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html) {
  return decodeHtml(String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function extractMdHtml(html) {
  const match = html.match(/<div class="md">([\s\S]*?)<\/div>/i);
  return match ? match[1] : '';
}

function mdFromHtmlFragment(html, url) {
  if (!html.trim()) return '';
  const { markdown } = htmlToMarkdownBuiltin(`<body>${html}</body>`, { url, frontMatter: false });
  return markdown.trim();
}

const THING_POST_SPLIT = /<div class="\s*thing id-t3_/;
const THING_COMMENT_SPLIT = /<div class="\s*thing id-t1_/;

function parseListingPosts(html, baseUrl) {
  const posts = [];
  const chunks = html.split(THING_POST_SPLIT).slice(1);

  for (const chunk of chunks) {
    const author = chunk.match(/data-author="([^"]+)"/)?.[1] ?? 'unknown';
    const score = chunk.match(/data-score="([^"]+)"/)?.[1] ?? '0';
    const comments = chunk.match(/data-comments-count="([^"]+)"/)?.[1] ?? '0';
    const permalink = chunk.match(/data-permalink="([^"]+)"/)?.[1];
    const titleHtml = chunk.match(/<a class="title[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';
    const title = stripTags(titleHtml);
    if (!title) continue;

    const flair = chunk.match(/<span class="linkflairlabel[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1];
    const selfHtml = chunk.match(/<div class="expando[\s\S]*?<div class="md">([\s\S]*?)<\/div>/)?.[1] ?? '';
    const selftext = mdFromHtmlFragment(selfHtml, baseUrl);

    posts.push({
      title,
      flair: flair ? stripTags(flair) : null,
      author,
      score,
      comments,
      url: absUrl(permalink, baseUrl),
      selftext,
    });
  }

  return posts;
}

function parsePostPage(html, baseUrl) {
  const title =
    stripTags(html.match(/<a class="title[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '') ||
    stripTags(html.match(/<title>([^<]+)<\/title>/)?.[1] ?? 'Reddit Post');

  const linkChunk = html.split(THING_POST_SPLIT)[1] ?? html;
  const author = linkChunk.match(/data-author="([^"]+)"/)?.[1] ?? 'unknown';
  const score = linkChunk.match(/data-score="([^"]+)"/)?.[1] ?? '0';
  const comments = linkChunk.match(/data-comments-count="([^"]+)"/)?.[1] ?? '0';

  const bodyHtml =
    linkChunk.match(/<div class="usertext-body[\s\S]*?<div class="md">([\s\S]*?)<\/div>/)?.[1] ?? '';
  const body = mdFromHtmlFragment(bodyHtml, baseUrl);

  const commentChunks = html.split(THING_COMMENT_SPLIT).slice(1);
  const parsedComments = [];

  for (const chunk of commentChunks) {
    const cAuthor = chunk.match(/data-author="([^"]+)"/)?.[1];
    if (!cAuthor || cAuthor === '[deleted]') continue;
    const cScore = chunk.match(/data-score="([^"]+)"/)?.[1] ?? '0';
    const cHtml =
      chunk.match(/<div class="usertext-body[\s\S]*?<div class="md">([\s\S]*?)<\/div>/)?.[1] ?? '';
    const cBody = mdFromHtmlFragment(cHtml, baseUrl);
    if (!cBody) continue;
    parsedComments.push({ author: cAuthor, score: cScore, body: cBody });
  }

  return { title, author, score, comments, body, parsedComments };
}

function listingToMarkdown(subreddit, posts, url) {
  const parts = [
    `# ${subreddit}`,
    '',
    '> **Source:** Reddit public feed (no login)',
    '',
    '---',
    '',
    '## Content',
    '',
    `**${posts.length}** public posts from this subreddit.`,
    '',
  ];

  for (const post of posts) {
    parts.push(`### ${post.title}`);
    if (post.flair) parts.push(`**Flair:** ${post.flair}`);
    parts.push('');
    parts.push(`By **u/${post.author}** · Score **${post.score}** · ${post.comments} comments`);
    parts.push('');
    if (post.selftext) {
      parts.push(post.selftext);
      parts.push('');
    }
  }

  parts.push('---', '', '## Links', '');
  for (const post of posts) {
    parts.push(`- [${post.title}](${post.url})`);
  }
  parts.push('');

  return parts.join('\n').trim();
}

function postToMarkdown(data, url) {
  const parts = [
    `# ${data.title}`,
    '',
    '> **Source:** Reddit public post (no login)',
    '',
    '---',
    '',
    '## Content',
    '',
    `By **u/${data.author}** · Score **${data.score}** · ${data.comments} comments`,
    '',
  ];

  if (data.body) {
    parts.push(data.body);
    parts.push('');
  }

  if (data.parsedComments.length) {
    parts.push(`### Comments (${data.parsedComments.length})`);
    parts.push('');
    for (const c of data.parsedComments) {
      parts.push(`**u/${c.author}** (${c.score} points)`);
      parts.push('');
      parts.push(c.body);
      parts.push('');
    }
  }

  parts.push('---', '', '## Links', '');
  parts.push(`- [View on Reddit](${url})`);
  parts.push('');

  return parts.join('\n').trim();
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

async function scrapeRedditPublic(url, options = {}) {
  const start = Date.now();
  const oldUrl = toOldRedditUrl(url);
  const userAgent = options.userAgent ?? REDDIT_UA;

  const res = await fetchUrl(oldUrl, {
    userAgent,
    timeout: options.timeout ?? 30000,
  });

  if (res.statusCode >= 400) {
    throw new Error(`ERR_NAV_HTTP_${res.statusCode}: Reddit returned ${res.statusCode}`);
  }

  const html = res.body;
  const navMs = Date.now() - start;

  if (
    /you.?ve been blocked by network security/i.test(html) ||
    /login to continue to view this page/i.test(html)
  ) {
    throw new Error('ERR_REDDIT_BLOCKED: Reddit blocked the request — old.reddit fallback failed');
  }

  let markdown;
  let title;

  if (isPostUrl(oldUrl)) {
    const post = parsePostPage(html, oldUrl);
    title = post.title;
    markdown = postToMarkdown(post, url);
  } else {
    const subreddit =
      stripTags(html.match(/<title>([^<]+)<\/title>/)?.[1] ?? '') || 'Reddit';
    const posts = parseListingPosts(html, oldUrl);
    if (!posts.length) {
      throw new Error('ERR_REDDIT_EMPTY: No public posts found on Reddit page');
    }
    title = subreddit;
    markdown = listingToMarkdown(subreddit, posts, url);
  }

  const wordCount = countWords(markdown);

  if (options.frontMatter !== false) {
    const meta = {
      title,
      url,
      scraped_at: new Date().toISOString(),
      source: 'old.reddit.com',
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
    status: res.statusCode,
    navMs,
    method: 'reddit-public',
  };
}

module.exports = {
  isRedditUrl,
  toOldRedditUrl,
  scrapeRedditPublic,
};
