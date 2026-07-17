const { URL } = require('node:url');
const { fetchUrl } = require('./httpClient');
const { scrapeWithBrowser } = require('./social/browserProfile');
const {
  DESKTOP_UA,
  buildFrontMatter,
  countWords,
  extractOgProfile,
  extractJsonLdByType,
  profileToMarkdown,
  mergePosts,
} = require('./social/common');

const LI_HOSTS = ['linkedin.com', 'www.linkedin.com'];

function isLinkedInUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return LI_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function parseLinkedInUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (!parts.length) return { kind: 'unknown' };
    const head = parts[0].toLowerCase();
    if (head === 'company' && parts[1]) return { kind: 'company', slug: parts[1] };
    if (head === 'in' && parts[1]) return { kind: 'profile', slug: parts[1] };
    if (head === 'school' && parts[1]) return { kind: 'school', slug: parts[1] };
    if (head === 'posts' || head === 'feed') return { kind: 'post' };
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

function normalizeLinkedInUrl(parsed) {
  if (parsed.kind === 'company') return `https://www.linkedin.com/company/${parsed.slug}/`;
  if (parsed.kind === 'profile') return `https://www.linkedin.com/in/${parsed.slug}/`;
  if (parsed.kind === 'school') return `https://www.linkedin.com/school/${parsed.slug}/`;
  return null;
}

function profileFromJsonLd(html, og, parsed) {
  const org = extractJsonLdByType(html, 'Organization');
  const person = extractJsonLdByType(html, 'Person');
  const entity = org || person;

  if (entity) {
    return {
      fullName: entity.name || og.title || parsed.slug,
      bio: entity.description || og.description || '',
      website: entity.url || entity.sameAs?.[0] || null,
      avatar: entity.logo?.url || entity.image?.url || entity.image || og.image || null,
      location: entity.address?.addressLocality || null,
      industry: entity.industry || null,
      followers: entity.numberOfEmployees?.value || null,
      profileUrl: normalizeLinkedInUrl(parsed),
    };
  }

  return {
    fullName: og.title?.replace(/ \| LinkedIn$/, '') || parsed.slug,
    bio: og.description || '',
    avatar: og.image || null,
    profileUrl: normalizeLinkedInUrl(parsed),
  };
}

async function collectLinkedInPostsFromDom(page, maxPosts) {
  return page
    .evaluate((limit) => {
      const posts = [];
      const seen = new Set();
      const selectors = [
        '.feed-shared-update-v2',
        '[data-urn*="activity"]',
        '.update-components-text',
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          if (posts.length >= limit) return;
          const text = (el.innerText || '').trim();
          if (!text || text.length < 20 || seen.has(text.slice(0, 80))) return;
          seen.add(text.slice(0, 80));
          const link = el.closest('article')?.querySelector('a[href*="/posts/"], a[href*="/feed/update"]')?.href
            || el.querySelector('a[href*="/posts/"], a[href*="/feed/update"]')?.href
            || null;
          posts.push({ text, url: link });
        });
      }
      return posts.slice(0, limit);
    }, maxPosts)
    .catch(() => []);
}

async function scrapeLinkedInProfilePage(url, parsed, options = {}) {
  const start = Date.now();
  const canonical = normalizeLinkedInUrl(parsed) || url;
  const maxPosts = options.maxProfilePosts ?? 24;

  let html = (
    await fetchUrl(canonical, {
      userAgent: options.userAgent ?? DESKTOP_UA,
      timeout: options.timeout ?? 30000,
    })
  ).body;

  const og = extractOgProfile(html);
  let profile = profileFromJsonLd(html, og, parsed);
  let posts = [];

  if (options.browserPool) {
    const browser = await scrapeWithBrowser(options.browserPool, {
      url: canonical,
      userAgent: options.userAgent ?? DESKTOP_UA,
      bypassLogin: options.bypassLogin,
      scrollRounds: options.profileScrollRounds ?? 4,
      collectDom: (page) => collectLinkedInPostsFromDom(page, maxPosts),
    });
    html = browser.html;
    const browserOg = extractOgProfile(html);
    profile = { ...profileFromJsonLd(html, browserOg, parsed), ...profile };
    posts = (browser.domData ?? []).map((item, index) => ({
      kind: 'Update',
      id: `update-${index + 1}`,
      caption: item.text,
      url: item.url || canonical,
    }));
  }

  posts = posts.slice(0, maxPosts);
  if (!profile.bio && !posts.length) {
    throw new Error('ERR_LINKEDIN_EMPTY: No public LinkedIn profile data found');
  }

  const platform = parsed.kind === 'company' ? 'LinkedIn Company' : 'LinkedIn';
  const markdown = profileToMarkdown(platform, profile, posts, url);
  const title = `${profile.fullName} / LinkedIn`;
  const wordCount = countWords(markdown);

  if (options.frontMatter !== false) {
    const meta = {
      title,
      url,
      scraped_at: new Date().toISOString(),
      source: posts.length ? 'linkedin-browser' : 'linkedin-og',
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
      method: 'linkedin-public',
      html,
    };
  }

  return {
    markdown,
    wordCount,
    title,
    status: 200,
    navMs: Date.now() - start,
    method: 'linkedin-public',
    html,
  };
}

async function scrapeLinkedInPublic(url, options = {}) {
  const parsed = parseLinkedInUrl(url);
  if (parsed.kind === 'company' || parsed.kind === 'profile' || parsed.kind === 'school') {
    return scrapeLinkedInProfilePage(url, parsed, options);
  }
  throw new Error('ERR_LINKEDIN_UNSUPPORTED: LinkedIn URL type not supported for public scrape');
}

function needsBrowserPool(url) {
  const kind = parseLinkedInUrl(url).kind;
  return kind === 'company' || kind === 'profile' || kind === 'school';
}

module.exports = {
  isLinkedInUrl,
  parseLinkedInUrl,
  scrapeLinkedInPublic,
  needsBrowserPool,
};
