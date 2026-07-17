const { URL } = require('node:url');
const { fetchUrl } = require('./httpClient');
const { scrapeWithBrowser } = require('./social/browserProfile');
const {
  DESKTOP_UA,
  buildFrontMatter,
  countWords,
  extractOgProfile,
  profileToMarkdown,
  mergePosts,
} = require('./social/common');

const TIKTOK_HOSTS = ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com'];

function isTikTokUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return TIKTOK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function parseTikTokUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (!parts.length) return { kind: 'unknown' };
    if (parts[0].startsWith('@')) return { kind: 'profile', username: parts[0].slice(1) };
    if (parts[0] === 'video' && parts[1]) return { kind: 'video', videoId: parts[1] };
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

function extractEmbeddedJson(html) {
  const patterns = [
    /<script id="SIGI_STATE" type="application\/json">([\s\S]*?)<\/script>/,
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">([\s\S]*?)<\/script>/,
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (!match) continue;
    try {
      return JSON.parse(match[1]);
    } catch {
      /* try next */
    }
  }
  return null;
}

function parseTikTokProfileFromJson(data, username) {
  const scope = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo;
  if (scope?.user && scope?.stats) {
    const user = scope.user;
    const stats = scope.stats;
    const profile = {
      fullName: user.nickname || username,
      username: user.uniqueId || username,
      bio: user.signature || '',
      avatar: user.avatarLarger || user.avatarMedium || null,
      followers: stats.followerCount ?? user.followerCount,
      following: stats.followingCount ?? user.followingCount,
      likes: stats.heartCount ?? stats.heart,
      posts: stats.videoCount ?? user.videoCount,
      verified: Boolean(user.verified),
      profileUrl: `https://www.tiktok.com/@${user.uniqueId || username}`,
    };
    const posts = (scope.itemList ?? []).slice(0, 50).map((item) => ({
      kind: 'Video',
      id: item.id,
      caption: item.desc || '',
      likes: item.stats?.diggCount ?? null,
      comments: item.stats?.commentCount ?? null,
      views: item.stats?.playCount ?? null,
      thumbnailUrl: item.video?.cover || item.video?.dynamicCover || null,
      url: `https://www.tiktok.com/@${profile.username}/video/${item.id}`,
    }));
    return { profile, posts };
  }

  const users = data?.UserModule?.users ?? {};
  const statsMap = data?.UserModule?.stats ?? {};
  const itemModule = data?.ItemModule ?? {};
  let user = Object.values(users).find((u) => u.uniqueId?.toLowerCase() === username.toLowerCase());
  if (!user) user = Object.values(users)[0];
  if (!user) return { profile: null, posts: [] };

  const stats = statsMap[user.id] ?? {};
  const profile = {
    fullName: user.nickname || username,
    username: user.uniqueId || username,
    bio: user.signature || '',
    avatar: user.avatarLarger || user.avatarMedium || null,
    followers: stats.followerCount ?? user.followerCount,
    following: stats.followingCount ?? user.followingCount,
    likes: stats.heartCount ?? stats.heart,
    posts: stats.videoCount ?? user.videoCount,
    verified: Boolean(user.verified),
    profileUrl: `https://www.tiktok.com/@${user.uniqueId || username}`,
  };

  const posts = Object.values(itemModule)
    .filter((item) => item.author === user.id || item.authorId === user.id)
    .slice(0, 50)
    .map((item) => ({
      kind: 'Video',
      id: item.id,
      caption: item.desc || '',
      likes: item.stats?.diggCount ?? null,
      comments: item.stats?.commentCount ?? null,
      views: item.stats?.playCount ?? null,
      thumbnailUrl: item.video?.cover || item.video?.dynamicCover || null,
      url: `https://www.tiktok.com/@${profile.username}/video/${item.id}`,
    }));

  return { profile, posts };
}

async function fetchTikTokOEmbed(url, options) {
  const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const res = await fetchUrl(oembedUrl, {
    userAgent: options.userAgent ?? DESKTOP_UA,
    timeout: options.timeout ?? 30000,
  });
  if (res.statusCode >= 400) throw new Error(`TikTok oEmbed ${res.statusCode}`);
  return JSON.parse(res.body);
}

async function scrapeTikTokProfile(url, username, options = {}) {
  const start = Date.now();
  const canonical = `https://www.tiktok.com/@${username}`;
  const maxPosts = options.maxProfilePosts ?? 24;

  let html = '';
  try {
    html = (
      await fetchUrl(canonical, {
        userAgent: options.userAgent ?? DESKTOP_UA,
        timeout: options.timeout ?? 30000,
      })
    ).body;
  } catch {
    /* browser fallback below */
  }

  let { profile, posts } = parseTikTokProfileFromJson(extractEmbeddedJson(html), username);

  if ((!profile || posts.length < 3) && options.browserPool) {
    const browser = await scrapeWithBrowser(options.browserPool, {
      url: canonical,
      userAgent: options.userAgent ?? DESKTOP_UA,
      bypassLogin: options.bypassLogin,
      scrollRounds: options.profileScrollRounds ?? 5,
    });
    const browserData = parseTikTokProfileFromJson(extractEmbeddedJson(browser.html), username);
    profile = profile ? { ...browserData.profile, ...profile } : browserData.profile;
    posts = mergePosts(posts, browserData.posts, maxPosts);
    html = browser.html;
  }

  const og = extractOgProfile(html || '');
  if (!profile) {
    profile = {
      fullName: og.title?.replace(/ \| TikTok$/, '') || username,
      username,
      bio: og.description || '',
      avatar: og.image || null,
      profileUrl: canonical,
    };
  }

  posts = posts.slice(0, maxPosts);
  if (!posts.length && !profile.bio) {
    throw new Error('ERR_TIKTOK_EMPTY: No public TikTok profile data found');
  }

  const markdown = profileToMarkdown('TikTok', profile, posts, url);
  const title = `${profile.fullName} (@${profile.username}) / TikTok`;
  const wordCount = countWords(markdown);

  if (options.frontMatter !== false) {
    const meta = {
      title,
      url,
      scraped_at: new Date().toISOString(),
      source: posts.length ? 'tiktok-profile' : 'tiktok-og',
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
      method: 'tiktok-public',
      html,
    };
  }

  return {
    markdown,
    wordCount,
    title,
    status: 200,
    navMs: Date.now() - start,
    method: 'tiktok-public',
    html,
  };
}

async function scrapeTikTokVideo(url, parsed, options = {}) {
  const start = Date.now();
  const videoUrl = url.includes('/video/') ? url : `https://www.tiktok.com/video/${parsed.videoId}`;
  const oembed = await fetchTikTokOEmbed(videoUrl, options);
  const markdownBody = [
    `# ${oembed.title || 'TikTok Video'}`,
    '',
    '> **Source:** TikTok public oEmbed (no login)',
    '',
    '---',
    '',
    '## Content',
    '',
    `**Author:** ${oembed.author_name || 'Unknown'}`,
    '',
    oembed.title || '_No caption._',
    '',
    oembed.thumbnail_url ? `![TikTok video](${oembed.thumbnail_url})` : '',
    '',
    '---',
    '',
    '## Links',
    '',
    `- [Watch on TikTok](${videoUrl})`,
    '',
  ]
    .filter(Boolean)
    .join('\n');

  const title = oembed.title || 'TikTok Video';
  const wordCount = countWords(markdownBody);
  let markdown = markdownBody;

  if (options.frontMatter !== false) {
    markdown =
      buildFrontMatter({
        title,
        url: videoUrl,
        scraped_at: new Date().toISOString(),
        source: 'tiktok-oembed',
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
    method: 'tiktok-public',
    thumbnailUrl: oembed.thumbnail_url,
    previewUrl: oembed.thumbnail_url,
  };
}

async function scrapeTikTokPublic(url, options = {}) {
  const parsed = parseTikTokUrl(url);
  if (parsed.kind === 'profile') return scrapeTikTokProfile(url, parsed.username, options);
  if (parsed.kind === 'video') return scrapeTikTokVideo(url, parsed, options);
  throw new Error('ERR_TIKTOK_UNSUPPORTED: TikTok URL type not supported for public scrape');
}

function needsBrowserPool(url) {
  return parseTikTokUrl(url).kind === 'profile';
}

module.exports = {
  isTikTokUrl,
  parseTikTokUrl,
  scrapeTikTokPublic,
  needsBrowserPool,
};
