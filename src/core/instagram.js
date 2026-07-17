const { URL } = require('node:url');
const { fetchUrl } = require('./httpClient');
const { dismissLoginWall } = require('./loginWall');

const INSTAGRAM_HOSTS = ['instagram.com', 'www.instagram.com'];
const IG_APP_ID = '936619743392459';

const IG_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

function formatCount(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function buildFrontMatter(meta) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    const formatted =
      typeof value === 'string' ? `"${value.replace(/"/g, '\\"')}"` : JSON.stringify(value);
    lines.push(`${key}: ${formatted}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function postSegment(node) {
  if (node?.product_type === 'clips') return 'reel';
  if (node?.is_video && !node?.edge_sidecar_to_children?.edges?.length) return 'reel';
  return 'p';
}

function normalizeProfileUser(user, fallbackUsername) {
  if (!user) {
    return {
      username: fallbackUsername,
      fullName: fallbackUsername,
      bio: '',
      website: null,
      followers: null,
      following: null,
      posts: null,
      avatar: null,
      verified: false,
    };
  }

  return {
    username: user.username || fallbackUsername,
    fullName: user.full_name || user.username || fallbackUsername,
    bio: user.biography || '',
    website: user.external_url || null,
    followers: user.edge_followed_by?.count ?? user.follower_count ?? null,
    following: user.edge_follow?.count ?? user.following_count ?? null,
    posts: user.edge_owner_to_timeline_media?.count ?? user.media_count ?? null,
    avatar: user.profile_pic_url_hd || user.profile_pic_url || null,
    verified: Boolean(user.is_verified || user.is_verified_business),
  };
}

function normalizeProfilePost(node, username) {
  if (!node?.shortcode) return null;

  const segment = postSegment(node);
  const caption =
    node.edge_media_to_caption?.edges?.[0]?.node?.text ??
    node.caption?.text ??
    '';

  return {
    shortcode: node.shortcode,
    kind: segment === 'reel' ? 'reel' : 'post',
    url: `https://www.instagram.com/${segment}/${node.shortcode}/`,
    caption: String(caption).trim(),
    thumbnailUrl:
      node.display_url ??
      node.thumbnail_src ??
      node.thumbnail_resources?.slice(-1)?.[0]?.src ??
      null,
    likes: node.edge_liked_by?.count ?? node.edge_media_preview_like?.count ?? node.like_count ?? null,
    comments: node.edge_media_to_comment?.count ?? node.comment_count ?? null,
    timestamp: node.taken_at_timestamp ?? null,
    isVideo: Boolean(node.is_video),
    username: node.owner?.username || username || null,
  };
}

function parseGraphqlPayload(json) {
  const data = json?.data;
  if (!data) return { user: null, posts: [] };

  const user = data.user ?? null;
  let edges = user?.edge_owner_to_timeline_media?.edges ?? [];

  if (!edges.length && data.xdt_api__v1__feed__user_timeline_graphql_connection) {
    edges = data.xdt_api__v1__feed__user_timeline_graphql_connection.edges ?? [];
  }

  const posts = edges
    .map((edge) => normalizeProfilePost(edge.node ?? edge, user?.username))
    .filter(Boolean);

  return { user, posts };
}

function profileFromOgMeta(title, description, username) {
  const fullName = title.replace(/\s*\(@[^)]+\)\s*/g, '').replace(/\s*•\s*Instagram photos and videos$/i, '').trim();
  return {
    username,
    fullName: fullName || username,
    bio: description || '',
    website: null,
    followers: null,
    following: null,
    posts: null,
    avatar: null,
    verified: false,
  };
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
    parts.push(`![Instagram ${label}](${data.thumbnail_url})`);
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

function profileToMarkdown(profile, posts, url) {
  const parts = [
    `# ${profile.fullName} (@${profile.username})`,
    '',
    '> **Source:** Instagram public profile (no login)',
    '',
    '---',
    '',
    '## Profile',
    '',
    `**Handle:** [@${profile.username}](https://www.instagram.com/${profile.username}/)`,
    `**Bio:** ${profile.bio || '_No bio._'}`,
  ];

  if (profile.website) parts.push(`**Website:** ${profile.website}`);
  parts.push(
    `**Followers:** ${formatCount(profile.followers)} · **Following:** ${formatCount(profile.following)} · **Posts:** ${formatCount(profile.posts)}`,
  );
  if (profile.verified) parts.push('**Verified:** Yes');

  parts.push('');

  if (profile.avatar) {
    parts.push(`![Profile avatar](${profile.avatar})`, '');
  }

  parts.push('---', '', '## Posts', '');

  if (!posts.length) {
    parts.push('_No public posts returned. The account may be private or rate-limited._', '');
  } else {
    parts.push(`**${posts.length}** recent public posts.`, '');
    for (const post of posts) {
      const label = post.kind === 'reel' ? 'Reel' : 'Post';
      parts.push(`### ${label} · ${post.shortcode}`);
      if (post.caption) {
        parts.push(post.caption);
        parts.push('');
      } else {
        parts.push('_No caption available._');
        parts.push('');
      }
      if (post.likes != null || post.comments != null) {
        parts.push(
          `**Likes:** ${post.likes ?? '—'} · **Comments:** ${post.comments ?? '—'}`,
        );
        parts.push('');
      }
      if (post.thumbnailUrl) {
        parts.push(`![Instagram ${label}](${post.thumbnailUrl})`);
        parts.push('');
      }
      parts.push(`[View on Instagram](${post.url})`);
      parts.push('');
    }
  }

  parts.push('---', '', '## Links', '');
  parts.push(`- [View profile on Instagram](https://www.instagram.com/${profile.username}/)`);
  parts.push(`- [Original URL](${url})`);
  parts.push('');

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
    userAgent: options.userAgent ?? DESKTOP_UA,
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

  return { title, description, html: res.body };
}

async function fetchProfileApi(username, options = {}) {
  const apiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const res = await fetchUrl(apiUrl, {
    userAgent: options.userAgent ?? DESKTOP_UA,
    timeout: options.timeout ?? 30000,
    headers: {
      'X-IG-App-ID': IG_APP_ID,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (res.statusCode >= 400) {
    throw new Error(`ERR_INSTAGRAM_API_${res.statusCode}: Profile API returned ${res.statusCode}`);
  }

  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error('ERR_INSTAGRAM_API_PARSE: Invalid profile API response');
  }

  const user = json?.data?.user;
  if (!user) {
    throw new Error('ERR_INSTAGRAM_API_EMPTY: Profile API returned no user');
  }

  const profile = normalizeProfileUser(user, username);
  const posts = (user.edge_owner_to_timeline_media?.edges ?? [])
    .map((edge) => normalizeProfilePost(edge.node, username))
    .filter(Boolean);

  return { profile, posts };
}

async function collectPostsFromDom(page, username, maxPosts) {
  const hrefs = await page
    .$$eval('a[href*="/p/"], a[href*="/reel/"]', (els) => [
      ...new Set(els.map((a) => a.getAttribute('href')).filter(Boolean)),
    ])
    .catch(() => []);

  const posts = [];
  const seen = new Set();

  for (const href of hrefs) {
    if (posts.length >= maxPosts) break;
    const match = href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/i);
    if (!match || seen.has(match[2])) continue;
    seen.add(match[2]);
    const segment = match[1].toLowerCase();
    posts.push({
      shortcode: match[2],
      kind: segment === 'reel' ? 'reel' : 'post',
      url: `https://www.instagram.com/${segment}/${match[2]}/`,
      caption: '',
      thumbnailUrl: null,
      likes: null,
      comments: null,
      timestamp: null,
      isVideo: segment === 'reel',
      username,
    });
  }

  return posts;
}

async function enrichPostsWithOembed(posts, options = {}) {
  const concurrency = options.oembedConcurrency ?? 3;
  const need = posts.filter((post) => !post.caption || !post.thumbnailUrl);
  if (!need.length) return;

  for (let i = 0; i < need.length; i += concurrency) {
    const batch = need.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (post) => {
        try {
          const data = await fetchOEmbed(post.url, options);
          if (!post.caption && data.title) post.caption = data.title;
          if (!post.thumbnailUrl && data.thumbnail_url) post.thumbnailUrl = data.thumbnail_url;
        } catch {
          /* oEmbed may rate-limit individual posts */
        }
      }),
    );
  }
}

async function scrapeInstagramProfileBrowser(pool, url, options = {}) {
  const parsed = parseInstagramUrl(url);
  const username = parsed.username;
  const canonical = normalizeCanonicalUrl(url);
  const maxPosts = options.maxProfilePosts ?? 24;
  const scrollRounds = options.profileScrollRounds ?? 5;
  const userAgent = options.userAgent ?? DESKTOP_UA;
  const timeout = options.timeout ?? 45000;

  const postMap = new Map();
  let profile = null;

  const context = await pool.acquireContext({
    userAgent,
    viewport: options.viewport ?? { width: 1280, height: 900 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  try {
    const page = await context.newPage();

    page.on('response', async (res) => {
      const endpoint = res.url();
      if (
        !endpoint.includes('graphql') &&
        !endpoint.includes('web_profile_info') &&
        !endpoint.includes('feed/user')
      ) {
        return;
      }
      try {
        const contentType = (res.headers()['content-type'] || '').toLowerCase();
        if (!contentType.includes('json')) return;
        const json = await res.json();
        const { user, posts } = parseGraphqlPayload(json);
        if (user && !profile) profile = normalizeProfileUser(user, username);
        for (const post of posts) {
          if (!post.shortcode) continue;
          const existing = postMap.get(post.shortcode);
          if (!existing || (!existing.caption && post.caption)) {
            postMap.set(post.shortcode, post);
          }
        }
      } catch {
        /* ignore malformed responses */
      }
    });

    await page.goto(canonical, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);

    if (options.bypassLogin !== false) {
      await dismissLoginWall(page, options).catch(() => 0);
    }

    for (let i = 0; i < scrollRounds && postMap.size < maxPosts; i += 1) {
      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(1200);
    }

    const domPosts = await collectPostsFromDom(page, username, maxPosts);
    for (const post of domPosts) {
      if (postMap.size >= maxPosts) break;
      if (!postMap.has(post.shortcode)) postMap.set(post.shortcode, post);
    }

    if (!profile) {
      const html = await page.content();
      const title = extractMeta(html, 'og:title');
      const description = extractMeta(html, 'og:description');
      profile = profileFromOgMeta(title, description, username);
    }
  } finally {
    await pool.releaseContext(context);
  }

  const posts = [...postMap.values()].slice(0, maxPosts);
  await enrichPostsWithOembed(posts, options);

  return { profile, posts };
}

async function scrapeInstagramProfile(url, options = {}) {
  const parsed = parseInstagramUrl(url);
  const username = parsed.username;
  const canonical = normalizeCanonicalUrl(url);
  const maxPosts = options.maxProfilePosts ?? 24;

  let profile = null;
  let posts = [];
  let source = 'instagram-profile';

  const ogMeta = await fetchProfileMeta(url, options).catch(() => null);

  try {
    const api = await fetchProfileApi(username, options);
    profile = api.profile;
    posts = api.posts.slice(0, maxPosts);
    source = 'instagram-profile-api';
  } catch {
    /* API often rate-limits; browser fallback below */
  }

  const needsBrowser =
    options.forceBrowserProfile ||
    !posts.length ||
    (posts.length < Math.min(maxPosts, 6) && options.browserPool);

  if (needsBrowser && options.browserPool) {
    const browserData = await scrapeInstagramProfileBrowser(options.browserPool, url, options);
    if (!profile || !profile.bio) {
      profile = browserData.profile ?? profile;
    } else if (browserData.profile) {
      profile = { ...profile, ...pickDefined(browserData.profile) };
    }

    const merged = new Map(posts.map((post) => [post.shortcode, post]));
    for (const post of browserData.posts) {
      const existing = merged.get(post.shortcode);
      if (!existing || (!existing.caption && post.caption)) merged.set(post.shortcode, post);
    }
    posts = [...merged.values()].slice(0, maxPosts);
    source = posts.length ? 'instagram-profile-browser' : source;
  }

  if (!profile && ogMeta) {
    profile = profileFromOgMeta(ogMeta.title, ogMeta.description, username);
  }

  if (!profile) {
    throw new Error('ERR_INSTAGRAM_PROFILE_EMPTY: Could not load public profile data');
  }

  return {
    profile,
    posts,
    title: ogMeta?.title || `${profile.fullName} (@${profile.username})`,
    source,
    thumbnailUrl: profile.avatar,
    previewUrl: profile.avatar,
  };
}

function pickDefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value != null && value !== ''));
}

async function scrapeInstagramPublic(url, options = {}) {
  const start = Date.now();
  const parsed = parseInstagramUrl(url);
  let markdown;
  let title;
  let status = 200;
  let source = 'instagram.com';
  let thumbnailUrl = null;
  let postCount = 0;

  if (parsed.kind === 'profile' && parsed.username) {
    const result = await scrapeInstagramProfile(url, options);
    title = result.title;
    thumbnailUrl = result.thumbnailUrl;
    source = result.source;
    postCount = result.posts.length;
    markdown = profileToMarkdown(result.profile, result.posts, normalizeCanonicalUrl(url));
  } else if (parsed.shortcode) {
    const data = await fetchOEmbed(url, options);
    title = data.title || `${data.author_name} on Instagram`;
    thumbnailUrl = data.thumbnail_url || null;
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
    if (postCount) meta.post_count = postCount;
    markdown = buildFrontMatter(meta) + markdown + '\n';
  }

  return {
    markdown,
    wordCount,
    title,
    status,
    navMs: Date.now() - start,
    method: 'instagram-public',
    thumbnailUrl,
    previewUrl: thumbnailUrl,
  };
}

function needsBrowserPool(url) {
  return parseInstagramUrl(url).kind === 'profile';
}

module.exports = {
  isInstagramUrl,
  parseInstagramUrl,
  normalizeCanonicalUrl,
  toInstagramEmbedUrl,
  scrapeInstagramPublic,
  scrapeInstagramProfileBrowser,
  needsBrowserPool,
};
