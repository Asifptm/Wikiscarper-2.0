const { URL } = require('node:url');
const { fetchUrl } = require('./httpClient');
const { extractMetaContent } = require('./snapshot');

const X_HOSTS = ['x.com', 'twitter.com', 'mobile.twitter.com', 'www.twitter.com', 'www.x.com'];

const X_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const RESERVED = new Set([
  'home',
  'search',
  'explore',
  'notifications',
  'messages',
  'settings',
  'i',
  'intent',
  'share',
  'hashtag',
  'login',
  'signup',
]);

function isXUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return X_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function parseXUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (!parts.length) return { kind: 'unknown' };

    const first = parts[0].toLowerCase();
    if (RESERVED.has(first)) return { kind: 'unknown' };

    if (parts[1] === 'status' && parts[2]) {
      return {
        kind: 'tweet',
        screenName: parts[0],
        tweetId: parts[2].replace(/\D/g, ''),
      };
    }

    return { kind: 'profile', screenName: parts[0] };
  } catch {
    return { kind: 'unknown' };
  }
}

function syndicationProfileUrl(screenName, showReplies = false) {
  return `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(screenName)}?showReplies=${showReplies}&lang=en`;
}

function parseNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function decodeBasic(text) {
  return String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function expandUrls(text, entities = {}) {
  let out = decodeBasic(text);
  for (const item of entities.urls ?? []) {
    if (!item.url || !item.expanded_url) continue;
    out = out.split(item.url).join(item.expanded_url);
  }
  return out.trim();
}

function extractCardImages(card) {
  if (!card?.binding_values) return [];
  const values = card.binding_values;
  const preferred = [
    'photo_image_full_size_original',
    'summary_photo_image_original',
    'photo_image_full_size',
    'summary_photo_image_large',
    'thumbnail_image_original',
    'thumbnail_image_large',
  ];
  for (const key of preferred) {
    const url = values[key]?.image_value?.url;
    if (url) return [url];
  }
  for (const value of Object.values(values)) {
    const url = value?.image_value?.url;
    if (url) return [url];
  }
  return [];
}

function extractTweetMedia(tweet) {
  const images = [];
  const seen = new Set();
  const add = (url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    images.push(url);
  };

  for (const media of tweet.extended_entities?.media ?? tweet.entities?.media ?? []) {
    add(media.media_url_https || media.media_url);
  }
  for (const url of extractCardImages(tweet.card)) add(url);
  return images;
}

function normalizeTweet(raw) {
  if (!raw?.id_str) return null;

  const user = raw.user ?? {};
  const screenName = user.screen_name || 'unknown';
  const isRetweet = Boolean(raw.retweeted_status);
  const source = isRetweet ? raw.retweeted_status : raw;
  const sourceUser = source.user ?? user;

  const images = extractTweetMedia(source);
  const cardTitle = source.card?.binding_values?.title?.string_value ?? null;
  const cardDescription = source.card?.binding_values?.description?.string_value ?? null;
  const cardUrl = source.card?.url ?? null;

  return {
    id: raw.id_str,
    text: expandUrls(source.full_text || source.text || '', source.entities),
    created_at: source.created_at || raw.created_at,
    likes: source.favorite_count ?? 0,
    retweets: source.retweet_count ?? 0,
    replies: source.reply_count ?? 0,
    quotes: source.quote_count ?? 0,
    url: `https://x.com/${screenName}/status/${raw.id_str}`,
    images,
    cardTitle,
    cardDescription,
    cardUrl,
    isRetweet,
    retweetOf: isRetweet
      ? `@${sourceUser.screen_name || 'unknown'}`
      : null,
    author: {
      name: user.name || screenName,
      screenName,
      avatar: user.profile_image_url_https || null,
    },
  };
}

function normalizeProfile(user, screenName) {
  if (!user) {
    return {
      name: screenName,
      screenName,
      bio: '',
      website: null,
      followers: null,
      following: null,
      posts: null,
      joined: null,
      avatar: null,
      banner: null,
      verified: false,
    };
  }

  const website = user.entities?.url?.urls?.[0]?.expanded_url ?? user.url ?? null;

  return {
    name: user.name || screenName,
    screenName: user.screen_name || screenName,
    bio: decodeBasic(user.description || ''),
    website,
    followers: user.followers_count ?? null,
    following: user.friends_count ?? null,
    posts: user.statuses_count ?? null,
    joined: user.created_at ?? null,
    avatar: user.profile_image_url_https?.replace('_normal', '_400x400') ?? null,
    banner: user.profile_banner_url ?? null,
    verified: Boolean(user.verified || user.is_blue_verified),
  };
}

function formatCount(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function profileToMarkdown(profile, tweets, url) {
  const parts = [
    `# ${profile.name} (@${profile.screenName})`,
    '',
    '> **Source:** X public profile (no login)',
    '',
    '---',
    '',
    '## Profile',
    '',
    `**Handle:** [@${profile.screenName}](https://x.com/${profile.screenName})`,
    `**Bio:** ${profile.bio || '_No bio._'}`,
  ];

  if (profile.website) parts.push(`**Website:** ${profile.website}`);
  parts.push(
    `**Followers:** ${formatCount(profile.followers)} · **Following:** ${formatCount(profile.following)} · **Posts:** ${formatCount(profile.posts)}`,
  );
  if (profile.joined) parts.push(`**Joined:** ${profile.joined}`);
  if (profile.verified) parts.push('**Verified:** Yes');

  parts.push('');

  if (profile.banner) {
    parts.push(`![Profile banner](${profile.banner})`, '');
  }
  if (profile.avatar) {
    parts.push(`![Profile avatar](${profile.avatar})`, '');
  }

  parts.push('---', '', '## Posts', '');

  if (!tweets.length) {
    parts.push('_No public posts returned._', '');
  } else {
    parts.push(`**${tweets.length}** recent public posts (via X syndication feed).`, '');
    for (const tweet of tweets) {
      parts.push(`### Post · ${tweet.created_at || tweet.id}`);
      if (tweet.isRetweet && tweet.retweetOf) {
        parts.push(`**Repost of** ${tweet.retweetOf}`);
        parts.push('');
      }
      parts.push(tweet.text || '_Empty post_');
      parts.push('');
      parts.push(
        `**Likes:** ${tweet.likes} · **Reposts:** ${tweet.retweets} · **Replies:** ${tweet.replies} · **Quotes:** ${tweet.quotes}`,
      );
      parts.push('');
      if (tweet.cardTitle) {
        parts.push(`**Link preview:** ${tweet.cardTitle}`);
        if (tweet.cardDescription) parts.push(tweet.cardDescription);
        if (tweet.cardUrl) parts.push(`[${tweet.cardUrl}](${tweet.cardUrl})`);
        parts.push('');
      }
      for (const img of tweet.images) {
        parts.push(`![Post media](${img})`);
      }
      if (tweet.images.length) parts.push('');
      parts.push(`[View on X](${tweet.url})`);
      parts.push('');
    }
  }

  parts.push('---', '', '## Links', '');
  parts.push(`- [Profile on X](https://x.com/${profile.screenName})`);
  parts.push(`- [Original URL](${url})`);
  parts.push('');

  return parts.join('\n').trim();
}

function tweetToMarkdown(tweet, url) {
  const parts = [
    `# Post by @${tweet.author.screenName}`,
    '',
    '> **Source:** X public post (no login)',
    '',
    '---',
    '',
    '## Content',
    '',
    tweet.text || '_Empty post_',
    '',
    `**Posted:** ${tweet.created_at || '—'}`,
    `**Likes:** ${tweet.likes} · **Reposts:** ${tweet.retweets} · **Replies:** ${tweet.replies}`,
    '',
  ];

  for (const img of tweet.images) {
    parts.push(`![Post media](${img})`);
  }
  if (tweet.images.length) parts.push('');

  parts.push('---', '', '## Links', '');
  parts.push(`- [View on X](${tweet.url})`);
  parts.push(`- [Author profile](https://x.com/${tweet.author.screenName})`);
  parts.push('');

  return parts.join('\n').trim();
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
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

async function fetchSyndicationTimeline(screenName, options = {}) {
  const syndicationUrl = syndicationProfileUrl(screenName, options.showReplies === true);
  const res = await fetchUrl(syndicationUrl, {
    userAgent: options.userAgent ?? X_UA,
    timeout: options.timeout ?? 30000,
  });

  if (res.statusCode >= 400) {
    throw new Error(`ERR_X_SYNDICATION_${res.statusCode}: X syndication returned ${res.statusCode}`);
  }

  const nextData = parseNextData(res.body);
  if (!nextData?.props?.pageProps?.timeline) {
    throw new Error('ERR_X_SYNDICATION_PARSE: No timeline data in X syndication response');
  }

  return {
    pageProps: nextData.props.pageProps,
    html: res.body,
    status: res.statusCode,
  };
}

async function fetchTweetOEmbed(url, options = {}) {
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;
  const res = await fetchUrl(oembedUrl, {
    userAgent: options.userAgent ?? X_UA,
    timeout: options.timeout ?? 30000,
  });
  if (res.statusCode >= 400) {
    throw new Error(`ERR_X_OEMBED_${res.statusCode}: X oEmbed returned ${res.statusCode}`);
  }
  return JSON.parse(res.body);
}

async function scrapeXProfile(screenName, url, options = {}) {
  const start = Date.now();
  const { pageProps, html, status } = await fetchSyndicationTimeline(screenName, options);

  const entries = pageProps.timeline?.entries ?? [];
  const tweets = entries
    .map((entry) => normalizeTweet(entry.content?.tweet))
    .filter(Boolean);

  const profileUser =
    entries.find((entry) => entry.content?.tweet?.user)?.content?.tweet?.user ?? null;
  const profile = normalizeProfile(profileUser, screenName);

  if (!profile.bio && html) {
    const ogDesc = extractMetaContent(html, 'og:description');
    if (ogDesc) profile.bio = ogDesc;
  }

  let markdown = profileToMarkdown(profile, tweets, url);
  const wordCount = countWords(markdown);
  const title = `${profile.name} (@${profile.screenName}) / X`;

  if (options.frontMatter !== false) {
    const imageUrls = [
      ...(profile.banner ? [profile.banner] : []),
      ...(profile.avatar ? [profile.avatar] : []),
      ...tweets.flatMap((t) => t.images),
    ];
    const meta = {
      title,
      url,
      scraped_at: new Date().toISOString(),
      source: 'x-syndication',
      login_required: false,
      word_count: wordCount,
      post_count: tweets.length,
      scrape_duration_ms: Date.now() - start,
      profile: {
        handle: profile.screenName,
        followers: profile.followers,
        following: profile.following,
        posts: profile.posts,
      },
      images: [...new Set(imageUrls)],
    };
    markdown = buildFrontMatter(meta) + markdown + '\n';
  }

  return {
    markdown,
    wordCount,
    title,
    status,
    navMs: Date.now() - start,
    method: 'x-public',
    html,
    tweets,
    profile,
  };
}

async function scrapeXTweet(url, options = {}) {
  const start = Date.now();
  const parsed = parseXUrl(url);
  const canonical = `https://x.com/${parsed.screenName}/status/${parsed.tweetId}`;

  let tweet = null;
  try {
    const { pageProps } = await fetchSyndicationTimeline(parsed.screenName, options);
    const match = (pageProps.timeline?.entries ?? [])
      .map((entry) => normalizeTweet(entry.content?.tweet))
      .find((t) => t?.id === parsed.tweetId);
    if (match) tweet = match;
  } catch {
    /* fall through to oEmbed */
  }

  if (!tweet) {
    const oembed = await fetchTweetOEmbed(canonical, options);
    tweet = {
      id: parsed.tweetId,
      text: decodeBasic(oembed.html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? ''),
      created_at: null,
      likes: 0,
      retweets: 0,
      replies: 0,
      quotes: 0,
      url: canonical,
      images: [],
      cardTitle: null,
      cardDescription: null,
      cardUrl: null,
      isRetweet: false,
      retweetOf: null,
      author: {
        name: oembed.author_name || parsed.screenName,
        screenName: parsed.screenName,
        avatar: null,
      },
    };
  }

  let markdown = tweetToMarkdown(tweet, canonical);
  const wordCount = countWords(markdown);
  const title = `Post by @${tweet.author.screenName} / X`;

  if (options.frontMatter !== false) {
    const meta = {
      title,
      url: canonical,
      scraped_at: new Date().toISOString(),
      source: tweet.images.length ? 'x-syndication' : 'x-oembed',
      login_required: false,
      word_count: wordCount,
      scrape_duration_ms: Date.now() - start,
      images: tweet.images,
    };
    markdown = buildFrontMatter(meta) + markdown + '\n';
  }

  return {
    markdown,
    wordCount,
    title,
    status: 200,
    navMs: Date.now() - start,
    method: 'x-public',
    html: '',
    tweet,
  };
}

async function scrapeXPublic(url, options = {}) {
  const parsed = parseXUrl(url);
  if (parsed.kind === 'tweet') {
    return scrapeXTweet(url, options);
  }
  if (parsed.kind === 'profile') {
    return scrapeXProfile(parsed.screenName, url, options);
  }
  throw new Error('ERR_X_UNSUPPORTED: X URL type not supported for public scrape');
}

function needsBrowserPool() {
  return false;
}

module.exports = {
  isXUrl,
  parseXUrl,
  scrapeXPublic,
  syndicationProfileUrl,
  needsBrowserPool,
};
