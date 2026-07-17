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

const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];

function isYouTubeUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, '');
    return YT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function parseYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '');

    if (host === 'youtu.be') {
      const id = parsed.pathname.replace(/^\//, '').split('/')[0];
      return id ? { kind: 'video', videoId: id } : { kind: 'unknown' };
    }

    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (!parts.length) return { kind: 'unknown' };

    if (parts[0] === 'watch' && parsed.searchParams.get('v')) {
      return { kind: 'video', videoId: parsed.searchParams.get('v') };
    }
    if (parts[0] === 'shorts' && parts[1]) {
      return { kind: 'video', videoId: parts[1] };
    }
    if (parts[0].startsWith('@')) {
      return { kind: 'channel', handle: parts[0].slice(1), tab: parts[1] || 'videos' };
    }
    if (parts[0] === 'channel' && parts[1]) {
      return { kind: 'channel', channelId: parts[1], tab: parts[2] || 'videos' };
    }
    if (parts[0] === 'c' && parts[1]) {
      return { kind: 'channel', customUrl: parts[1], tab: parts[2] || 'videos' };
    }
    if (parts[0] === 'user' && parts[1]) {
      return { kind: 'channel', legacyUser: parts[1], tab: parts[2] || 'videos' };
    }

    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

function normalizeChannelUrl(parsed) {
  if (parsed.handle) return `https://www.youtube.com/@${parsed.handle}/${parsed.tab || 'videos'}`;
  if (parsed.channelId) return `https://www.youtube.com/channel/${parsed.channelId}/${parsed.tab || 'videos'}`;
  if (parsed.customUrl) return `https://www.youtube.com/c/${parsed.customUrl}/${parsed.tab || 'videos'}`;
  if (parsed.legacyUser) return `https://www.youtube.com/user/${parsed.legacyUser}/${parsed.tab || 'videos'}`;
  return null;
}

function extractYtInitialData(html) {
  const patterns = [
    /var ytInitialData = (\{[\s\S]+?\});<\/script>/,
    /ytInitialData\s*=\s*(\{[\s\S]+?\})\s*;/,
    /window\["ytInitialData"\]\s*=\s*(\{[\s\S]+?\});/,
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (!match) continue;
    try {
      return JSON.parse(match[1]);
    } catch {
      /* try next pattern */
    }
  }
  return null;
}

function walkObject(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node)) {
    for (const item of node) walkObject(item, visit);
    return;
  }
  for (const value of Object.values(node)) walkObject(value, visit);
}

function collectVideosFromHtml(html, maxPosts) {
  const videos = [];
  const seen = new Set();

  for (const match of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    videos.push({
      kind: 'Video',
      id: match[1],
      title: match[1],
      caption: '',
      url: `https://www.youtube.com/watch?v=${match[1]}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`,
    });
    if (videos.length >= maxPosts) break;
  }

  if (videos.length >= maxPosts) return videos;

  for (const match of html.matchAll(/\/watch\?v=([A-Za-z0-9_-]{11})/g)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    videos.push({
      kind: 'Video',
      id: match[1],
      title: match[1],
      caption: '',
      url: `https://www.youtube.com/watch?v=${match[1]}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`,
    });
    if (videos.length >= maxPosts) break;
  }

  return videos;
}

async function collectVideosFromDom(page, maxPosts) {
  return page
    .evaluate((limit) => {
      const out = [];
      const seen = new Set();
      for (const anchor of document.querySelectorAll('a[href*="watch?v="]')) {
        if (out.length >= limit) break;
        let id;
        try {
          id = new URL(anchor.href, location.href).searchParams.get('v');
        } catch {
          continue;
        }
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const titleEl = anchor.querySelector('#video-title, yt-formatted-string, span');
        out.push({
          id,
          title: titleEl?.textContent?.trim() || id,
          url: `https://www.youtube.com/watch?v=${id}`,
          thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        });
      }
      return out;
    }, maxPosts)
    .catch(() => []);
}

function parseChannelFromInitialData(data, fallbackTitle) {
  let meta = null;
  const videos = [];
  const seen = new Set();

  walkObject(data, (node) => {
    if (!meta && node.channelMetadataRenderer) {
      const m = node.channelMetadataRenderer;
      meta = {
        fullName: m.title || fallbackTitle,
        handle: m.vanityChannelUrl?.replace(/^.*\/@/, '@') || null,
        bio: m.description || '',
        avatar: m.avatar?.thumbnails?.slice(-1)?.[0]?.url || null,
        banner: m.banner?.thumbnails?.slice(-1)?.[0]?.url || null,
        subscribers: m.subscriberCountText?.simpleText || m.subscriberCountText?.runs?.[0]?.text || null,
        profileUrl: m.channelUrl || null,
      };
    }

    if (node.videoRenderer?.videoId && !seen.has(node.videoRenderer.videoId)) {
      const v = node.videoRenderer;
      seen.add(v.videoId);
      videos.push({
        kind: 'Video',
        id: v.videoId,
        title: v.title?.simpleText || v.title?.runs?.map((r) => r.text).join('') || 'Video',
        caption: v.descriptionSnippet?.runs?.map((r) => r.text).join('') || v.title?.simpleText || '',
        views: v.viewCountText?.simpleText || v.shortViewCountText?.simpleText || null,
        thumbnailUrl: v.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || null,
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
      });
    }
  });

  return { profile: meta, videos };
}

function videoToMarkdown(video, url) {
  const parts = [
    `# ${video.title}`,
    '',
    '> **Source:** YouTube public video (no login)',
    '',
    '---',
    '',
    '## Content',
    '',
    video.description || '_No description._',
    '',
  ];
  if (video.views) parts.push(`**Views:** ${video.views}`, '');
  if (video.thumbnailUrl) {
    parts.push(`![Video thumbnail](${video.thumbnailUrl})`, '');
  }
  parts.push('---', '', '## Links', '', `- [Watch on YouTube](${url})`, '');
  return parts.join('\n').trim();
}

function parseVideoFromInitialData(data, videoId) {
  let video = null;
  walkObject(data, (node) => {
    if (video) return;
    if (node.videoPrimaryInfoRenderer || node.contents?.twoColumnWatchNextResults) {
      /* skip */
    }
    if (node.videoDetails?.videoId === videoId) {
      video = {
        title: node.videoDetails.title,
        description: node.videoDetails.shortDescription,
        views: node.videoDetails.viewCount,
        thumbnailUrl: node.videoDetails.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || null,
      };
    }
  });
  return video;
}

async function fetchPage(url, options) {
  const res = await fetchUrl(url, {
    userAgent: options.userAgent ?? DESKTOP_UA,
    timeout: options.timeout ?? 30000,
  });
  if (res.statusCode >= 400) {
    throw new Error(`ERR_YOUTUBE_HTTP_${res.statusCode}: YouTube returned ${res.statusCode}`);
  }
  return res.body;
}

async function scrapeYouTubeChannel(url, parsed, options = {}) {
  const start = Date.now();
  const canonical = normalizeChannelUrl(parsed) || url;
  const maxPosts = options.maxProfilePosts ?? 24;
  let html = await fetchPage(canonical, options);
  const ogTitle = extractOgProfile(html).title;
  let data = extractYtInitialData(html);
  let { profile, videos } = data
    ? parseChannelFromInitialData(data, ogTitle)
    : { profile: null, videos: [] };
  videos = mergePosts(videos, collectVideosFromHtml(html, maxPosts), maxPosts);

  if ((!profile || videos.length < 3) && options.browserPool) {
    const browser = await scrapeWithBrowser(options.browserPool, {
      url: canonical,
      userAgent: options.userAgent ?? DESKTOP_UA,
      timeout: options.timeout ?? 45000,
      bypassLogin: options.bypassLogin,
      scrollRounds: options.profileScrollRounds ?? 4,
      collectDom: (page) => collectVideosFromDom(page, maxPosts),
    });
    html = browser.html;
    data = extractYtInitialData(html);
    const browserData = data
      ? parseChannelFromInitialData(data, extractOgProfile(html).title)
      : { profile: null, videos: [] };
    profile = profile ? { ...browserData.profile, ...profile } : browserData.profile;
    videos = mergePosts(videos, browserData.videos, maxPosts);
    videos = mergePosts(
      videos,
      (browser.domData ?? []).map((item) => ({
        kind: 'Video',
        id: item.id,
        title: item.title,
        caption: item.title,
        url: item.url,
        thumbnailUrl: item.thumbnailUrl,
      })),
      maxPosts,
    );
    videos = mergePosts(videos, collectVideosFromHtml(html, maxPosts), maxPosts);
  }

  const og = extractOgProfile(html);
  if (!profile) {
    profile = {
      fullName: og.title?.replace(/ - YouTube$/, '') || parsed.handle || 'YouTube Channel',
      bio: og.description || '',
      avatar: og.image || null,
      profileUrl: canonical,
    };
  }

  videos = videos.slice(0, maxPosts);
  if (!videos.length && !profile?.bio) {
    throw new Error('ERR_YOUTUBE_EMPTY: No public channel data found');
  }

  const markdown = profileToMarkdown('YouTube', profile, videos, url);
  const title = `${profile.fullName} / YouTube`;
  const wordCount = countWords(markdown);

  if (options.frontMatter !== false) {
    const meta = {
      title,
      url,
      scraped_at: new Date().toISOString(),
      source: videos.length ? 'youtube-initial-data' : 'youtube-og',
      login_required: false,
      word_count: wordCount,
      post_count: videos.length,
      scrape_duration_ms: Date.now() - start,
    };
    return {
      markdown: buildFrontMatter(meta) + markdown + '\n',
      wordCount,
      title,
      status: 200,
      navMs: Date.now() - start,
      method: 'youtube-public',
      html,
    };
  }

  return {
    markdown,
    wordCount,
    title,
    status: 200,
    navMs: Date.now() - start,
    method: 'youtube-public',
    html,
  };
}

async function scrapeYouTubeVideo(url, parsed, options = {}) {
  const start = Date.now();
  const videoId = parsed.videoId;
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;
  const html = await fetchPage(canonical, options);
  const data = extractYtInitialData(html);
  const og = extractOgProfile(html);
  let video = data ? parseVideoFromInitialData(data, videoId) : null;

  if (!video) {
    video = {
      title: og.title || 'YouTube Video',
      description: og.description || '',
      views: null,
      thumbnailUrl: og.image || null,
    };
  }

  let markdown = videoToMarkdown(video, canonical);
  const title = video.title;
  const wordCount = countWords(markdown);

  if (options.frontMatter !== false) {
    const meta = {
      title,
      url: canonical,
      scraped_at: new Date().toISOString(),
      source: 'youtube-video',
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
    status: 200,
    navMs: Date.now() - start,
    method: 'youtube-public',
    html,
    thumbnailUrl: video.thumbnailUrl,
    previewUrl: video.thumbnailUrl,
  };
}

async function scrapeYouTubePublic(url, options = {}) {
  const parsed = parseYouTubeUrl(url);
  if (parsed.kind === 'channel') return scrapeYouTubeChannel(url, parsed, options);
  if (parsed.kind === 'video') return scrapeYouTubeVideo(url, parsed, options);
  throw new Error('ERR_YOUTUBE_UNSUPPORTED: YouTube URL type not supported for public scrape');
}

function needsBrowserPool(url) {
  return parseYouTubeUrl(url).kind === 'channel';
}

module.exports = {
  isYouTubeUrl,
  parseYouTubeUrl,
  scrapeYouTubePublic,
  needsBrowserPool,
};
