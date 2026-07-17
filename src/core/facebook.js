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

const FB_HOSTS = ['facebook.com', 'www.facebook.com', 'm.facebook.com'];

function isFacebookUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, '');
    return FB_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function parseFacebookUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (!parts.length) return { kind: 'unknown' };
    const reserved = new Set(['login', 'watch', 'groups', 'events', 'marketplace', 'gaming']);
    if (reserved.has(parts[0].toLowerCase())) return { kind: 'unknown' };
    if (parts[0] === 'profile.php' && parsed.searchParams.get('id')) {
      return { kind: 'page', id: parsed.searchParams.get('id') };
    }
    return { kind: 'page', slug: parts[0] };
  } catch {
    return { kind: 'unknown' };
  }
}

function normalizeFacebookUrl(parsed) {
  if (parsed.id) return `https://www.facebook.com/profile.php?id=${parsed.id}`;
  return `https://www.facebook.com/${parsed.slug}/`;
}

async function collectFacebookPostsFromDom(page, maxPosts) {
  return page
    .evaluate((limit) => {
      const posts = [];
      const seen = new Set();
      const nodes = document.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"], div[dir="auto"]');
      for (const el of nodes) {
        if (posts.length >= limit) break;
        const text = (el.innerText || '').trim();
        if (text.length < 30 || text.length > 4000 || seen.has(text.slice(0, 100))) continue;
        seen.add(text.slice(0, 100));
        posts.push({ text });
      }
      return posts.slice(0, limit);
    }, maxPosts)
    .catch(() => []);
}

async function scrapeFacebookPage(url, parsed, options = {}) {
  const start = Date.now();
  const canonical = normalizeFacebookUrl(parsed);
  const maxPosts = options.maxProfilePosts ?? 24;

  let html = '';
  let posts = [];

  try {
    html = (
      await fetchUrl(canonical, {
        userAgent: options.userAgent ?? DESKTOP_UA,
        timeout: options.timeout ?? 30000,
      })
    ).body;
  } catch {
    /* browser below */
  }

  let og = extractOgProfile(html || '');

  if (options.browserPool) {
    const browser = await scrapeWithBrowser(options.browserPool, {
      url: canonical,
      userAgent: options.userAgent ?? DESKTOP_UA,
      bypassLogin: options.bypassLogin,
      scrollRounds: options.profileScrollRounds ?? 4,
      collectDom: (page) => collectFacebookPostsFromDom(page, maxPosts),
    });
    html = browser.html;
    og = extractOgProfile(html);
    posts = (browser.domData ?? []).map((item, index) => ({
      kind: 'Post',
      id: `post-${index + 1}`,
      caption: item.text,
      url: canonical,
    }));
  }

  const profile = {
    fullName: og.title?.replace(/ \| Facebook$/, '') || parsed.slug || parsed.id || 'Facebook Page',
    bio: og.description || '',
    avatar: og.image || null,
    profileUrl: canonical,
  };

  posts = posts.slice(0, maxPosts);
  if (!profile.bio && !posts.length) {
    throw new Error('ERR_FACEBOOK_EMPTY: No public Facebook page data found');
  }

  const markdown = profileToMarkdown('Facebook', profile, posts, url);
  const title = `${profile.fullName} / Facebook`;
  const wordCount = countWords(markdown);

  if (options.frontMatter !== false) {
    const meta = {
      title,
      url,
      scraped_at: new Date().toISOString(),
      source: posts.length ? 'facebook-browser' : 'facebook-og',
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
      method: 'facebook-public',
      html,
    };
  }

  return {
    markdown,
    wordCount,
    title,
    status: 200,
    navMs: Date.now() - start,
    method: 'facebook-public',
    html,
  };
}

async function scrapeFacebookPublic(url, options = {}) {
  const parsed = parseFacebookUrl(url);
  if (parsed.kind === 'page') return scrapeFacebookPage(url, parsed, options);
  throw new Error('ERR_FACEBOOK_UNSUPPORTED: Facebook URL type not supported for public scrape');
}

function needsBrowserPool(url) {
  return parseFacebookUrl(url).kind === 'page';
}

module.exports = {
  isFacebookUrl,
  parseFacebookUrl,
  scrapeFacebookPublic,
  needsBrowserPool,
};
