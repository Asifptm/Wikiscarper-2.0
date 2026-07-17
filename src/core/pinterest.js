const { URL } = require('node:url');
const { fetchUrl } = require('./httpClient');
const { scrapeWithBrowser } = require('./social/browserProfile');
const {
  DESKTOP_UA,
  buildFrontMatter,
  countWords,
  extractOgProfile,
  profileToMarkdown,
} = require('./social/common');

const PIN_HOSTS = ['pinterest.com', 'www.pinterest.com'];

function isPinterestUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return PIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function parsePinterestUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (!parts.length) return { kind: 'unknown' };
    if (parts[0] === 'pin' && parts[1]) return { kind: 'pin', pinId: parts[1] };
    return { kind: 'profile', username: parts[0] };
  } catch {
    return { kind: 'unknown' };
  }
}

async function collectPinsFromDom(page, username, maxPosts) {
  const hrefs = await page
    .$$eval('a[href*="/pin/"]', (els) => [
      ...new Set(els.map((a) => a.getAttribute('href')).filter(Boolean)),
    ])
    .catch(() => []);

  const posts = [];
  for (const href of hrefs) {
    if (posts.length >= maxPosts) break;
    const match = href.match(/\/pin\/(\d+)/);
    if (!match) continue;
    posts.push({
      kind: 'Pin',
      id: match[1],
      url: `https://www.pinterest.com/pin/${match[1]}/`,
      caption: '',
      thumbnailUrl: null,
    });
  }
  return posts;
}

async function enrichPins(posts, options) {
  for (const post of posts) {
    if (post.caption && post.thumbnailUrl) continue;
    try {
      const html = (
        await fetchUrl(post.url, {
          userAgent: options.userAgent ?? DESKTOP_UA,
          timeout: options.timeout ?? 20000,
        })
      ).body;
      const og = extractOgProfile(html);
      if (!post.caption) post.caption = og.description || og.title || '';
      if (!post.thumbnailUrl) post.thumbnailUrl = og.image || null;
    } catch {
      /* skip failed pin */
    }
  }
}

async function scrapePinterestProfile(url, username, options = {}) {
  const start = Date.now();
  const canonical = `https://www.pinterest.com/${username}/`;
  const maxPosts = options.maxProfilePosts ?? 24;

  let html = '';
  let posts = [];
  const ogDirect = extractOgProfile(
    (
      await fetchUrl(canonical, {
        userAgent: options.userAgent ?? DESKTOP_UA,
        timeout: options.timeout ?? 30000,
      })
    ).body,
  );

  if (options.browserPool) {
    const browser = await scrapeWithBrowser(options.browserPool, {
      url: canonical,
      userAgent: options.userAgent ?? DESKTOP_UA,
      bypassLogin: options.bypassLogin,
      scrollRounds: options.profileScrollRounds ?? 4,
      collectDom: (page) => collectPinsFromDom(page, username, maxPosts),
    });
    html = browser.html;
    posts = browser.domData ?? [];
  }

  const og = html ? extractOgProfile(html) : ogDirect;
  const profile = {
    fullName: og.title?.replace(/ \| Pinterest$/, '') || username,
    username,
    bio: og.description || '',
    avatar: og.image || null,
    profileUrl: canonical,
  };

  posts = posts.slice(0, maxPosts);
  await enrichPins(posts.slice(0, Math.min(maxPosts, 12)), options);

  if (!posts.length && !profile.bio) {
    throw new Error('ERR_PINTEREST_EMPTY: No public Pinterest profile data found');
  }

  const markdown = profileToMarkdown('Pinterest', profile, posts, url);
  const title = `${profile.fullName} (@${username}) / Pinterest`;
  const wordCount = countWords(markdown);

  if (options.frontMatter !== false) {
    const meta = {
      title,
      url,
      scraped_at: new Date().toISOString(),
      source: posts.length ? 'pinterest-browser' : 'pinterest-og',
      login_required: false,
      word_count: wordCount,
      post_count: posts.length,
      scrape_duration_ms: Date.now() - start,
    };
    return {
      markdown: buildFrontMatter(meta) + markdown + '\n',
      wordCount,
      title,
      status: 200,
      navMs: Date.now() - start,
      method: 'pinterest-public',
      html,
    };
  }

  return {
    markdown,
    wordCount,
    title,
    status: 200,
    navMs: Date.now() - start,
    method: 'pinterest-public',
    html,
  };
}

async function scrapePinterestPin(url, pinId, options = {}) {
  const start = Date.now();
  const canonical = `https://www.pinterest.com/pin/${pinId}/`;
  const html = (
    await fetchUrl(canonical, {
      userAgent: options.userAgent ?? DESKTOP_UA,
      timeout: options.timeout ?? 30000,
    })
  ).body;
  const og = extractOgProfile(html);
  const markdownBody = [
    `# ${og.title || 'Pinterest Pin'}`,
    '',
    '> **Source:** Pinterest public pin (no login)',
    '',
    '---',
    '',
    '## Content',
    '',
    og.description || '_No description._',
    '',
    og.image ? `![Pin image](${og.image})` : '',
    '',
    '---',
    '',
    '## Links',
    '',
    `- [View on Pinterest](${canonical})`,
    '',
  ]
    .filter(Boolean)
    .join('\n');

  const title = og.title || 'Pinterest Pin';
  const wordCount = countWords(markdownBody);
  let markdown = markdownBody;

  if (options.frontMatter !== false) {
    markdown =
      buildFrontMatter({
        title,
        url: canonical,
        scraped_at: new Date().toISOString(),
        source: 'pinterest-pin',
        login_required: false,
        word_count: wordCount,
        scrape_duration_ms: Date.now() - start,
      }) +
      markdown +
      '\n';
  }

  return {
    markdown,
    wordCount,
    title,
    status: 200,
    navMs: Date.now() - start,
    method: 'pinterest-public',
    thumbnailUrl: og.image,
    previewUrl: og.image,
  };
}

async function scrapePinterestPublic(url, options = {}) {
  const parsed = parsePinterestUrl(url);
  if (parsed.kind === 'profile') return scrapePinterestProfile(url, parsed.username, options);
  if (parsed.kind === 'pin') return scrapePinterestPin(url, parsed.pinId, options);
  throw new Error('ERR_PINTEREST_UNSUPPORTED: Pinterest URL type not supported for public scrape');
}

function needsBrowserPool(url) {
  return parsePinterestUrl(url).kind === 'profile';
}

module.exports = {
  isPinterestUrl,
  parsePinterestUrl,
  scrapePinterestPublic,
  needsBrowserPool,
};
