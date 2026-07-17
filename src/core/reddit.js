const { URL } = require('node:url');
const { fetchUrl } = require('./httpClient');
const { htmlToMarkdownBuiltin } = require('./extractor');
const { profileToMarkdown, buildFrontMatter, countWords } = require('./social/common');

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

function parseRedditUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (!parts.length) return { kind: 'unknown' };
    const head = parts[0].toLowerCase();
    if (head === 'r' && parts[1]) return { kind: 'subreddit', name: parts[1] };
    if ((head === 'u' || head === 'user') && parts[1]) return { kind: 'user', name: parts[1] };
    if (parts.includes('comments')) return { kind: 'post' };
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

function toOldRedditUserUrl(username) {
  return `https://old.reddit.com/user/${encodeURIComponent(username)}/`;
}

function parseUserSidebar(html, baseUrl) {
  const titlebox = html.match(/class="titlebox[\s\S]*?<\/form>/i)?.[0] ?? '';
  const karmaText = stripTags(titlebox.match(/class="karma"[\s\S]*?<\/span>[\s\S]*?<\/span>/)?.[0] ?? '');
  const karmaMatch = karmaText.match(/([\d,]+)/);
  const cakeDay = titlebox.match(/class="age"[\s\S]*?<time[^>]*title="([^"]+)"/i)?.[1] ?? null;
  const bioHtml =
    titlebox.match(/class="usertext-body[\s\S]*?<div class="md">([\s\S]*?)<\/div>/)?.[1] ?? '';
  const bio = mdFromHtmlFragment(bioHtml, baseUrl);

  return {
    karma: karmaMatch ? karmaMatch[1].replace(/,/g, '') : null,
    cakeDay,
    bio,
  };
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

const PLACEHOLDER_THUMB_RE =
  /redditstatic\.com\/(new-icon|icon|interstitial|self|default|nsfw|spoiler|thumb)/i;

function extractPostThumbnail(chunk, baseUrl) {
  const thumbMatch = chunk.match(/<a class="thumbnail[^"]*"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/i);
  if (thumbMatch?.[1] && !PLACEHOLDER_THUMB_RE.test(thumbMatch[1])) {
    return absUrl(thumbMatch[1].startsWith('//') ? `https:${thumbMatch[1]}` : thumbMatch[1], baseUrl);
  }
  const bgMatch = chunk.match(/background-image:\s*url\(['"]?([^'")]+)/i);
  if (bgMatch?.[1] && !PLACEHOLDER_THUMB_RE.test(bgMatch[1])) {
    return absUrl(bgMatch[1], baseUrl);
  }
  return null;
}

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
    const thumbnailUrl = extractPostThumbnail(chunk, baseUrl);

    posts.push({
      title,
      flair: flair ? stripTags(flair) : null,
      author,
      score,
      comments,
      url: absUrl(permalink, baseUrl),
      selftext,
      thumbnailUrl,
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
    if (post.thumbnailUrl) {
      parts.push(`![${post.title}](${post.thumbnailUrl})`);
      parts.push('');
    }
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

function extractPostPreview(html, baseUrl) {
  const thumb =
    html.match(/<a class="thumbnail[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/i)?.[1] ??
    html.match(/property="og:image" content="([^"]+)"/i)?.[1] ??
    null;
  if (!thumb) return null;
  if (/redditstatic\.com\/(new-icon|icon|interstitial)/i.test(thumb)) return null;
  try {
    return new URL(thumb.startsWith('//') ? `https:${thumb}` : thumb, baseUrl).href;
  } catch {
    return thumb.startsWith('//') ? `https:${thumb}` : thumb;
  }
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

  if (data.previewUrl) {
    parts.push(`![Post image](${data.previewUrl})`);
    parts.push('');
  }

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
  let previewUrl = null;
  let postCount = 0;
  const parsed = parseRedditUrl(url);

  if (isPostUrl(oldUrl)) {
    const post = parsePostPage(html, oldUrl);
    previewUrl = extractPostPreview(html, oldUrl);
    post.previewUrl = previewUrl;
    title = post.title;
    markdown = postToMarkdown(post, url);
  } else if (parsed.kind === 'user') {
    const userUrl = toOldRedditUserUrl(parsed.name);
    const userRes =
      userUrl === oldUrl
        ? { body: html, statusCode: res.statusCode }
        : await fetchUrl(userUrl, { userAgent, timeout: options.timeout ?? 30000 });
    const userHtml = userRes.body;
    const sidebar = parseUserSidebar(userHtml, userUrl);
    const listing = parseListingPosts(userHtml, userUrl);
    if (!listing.length) {
      throw new Error('ERR_REDDIT_EMPTY: No public posts found on Reddit user profile');
    }
    postCount = listing.length;
    const profile = {
      fullName: `u/${parsed.name}`,
      username: parsed.name,
      bio: sidebar.bio || '_No bio._',
      karma: sidebar.karma,
      posts: listing.length,
      profileUrl: userUrl,
    };
    const posts = listing.map((post) => ({
      kind: 'Post',
      title: post.title,
      caption: post.selftext || post.title,
      score: post.score,
      comments: post.comments,
      thumbnailUrl: post.thumbnailUrl,
      url: post.url,
    }));
    title = `u/${parsed.name} on Reddit`;
    markdown = profileToMarkdown('Reddit', profile, posts, url);
    previewUrl = listing.find((p) => p.thumbnailUrl)?.thumbnailUrl ?? extractPostPreview(userHtml, userUrl);
  } else {
    const subreddit =
      stripTags(html.match(/<title>([^<]+)<\/title>/)?.[1] ?? '') || 'Reddit';
    const posts = parseListingPosts(html, oldUrl);
    if (!posts.length) {
      throw new Error('ERR_REDDIT_EMPTY: No public posts found on Reddit page');
    }
    postCount = posts.length;
    title = subreddit;
    markdown = listingToMarkdown(subreddit, posts, url);
    previewUrl = extractPostPreview(html, oldUrl);
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
    if (postCount) meta.post_count = postCount;
    markdown = buildFrontMatter(meta) + markdown + '\n';
  }

  return {
    markdown,
    wordCount,
    title,
    status: res.statusCode,
    navMs,
    method: 'reddit-public',
    html,
    previewUrl,
  };
}

function needsBrowserPool(url) {
  return false;
}

module.exports = {
  isRedditUrl,
  toOldRedditUrl,
  parseRedditUrl,
  scrapeRedditPublic,
  needsBrowserPool,
};
