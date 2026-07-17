const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeHtml(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function formatCount(n) {
  if (n == null || n === '') return '—';
  const num = typeof n === 'string' ? parseFloat(n.replace(/,/g, '')) : n;
  if (Number.isNaN(num)) return String(n);
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(num);
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

function extractMetaTag(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`property="${escaped}" content="([^"]+)"`, 'i'),
    new RegExp(`content="([^"]+)" property="${escaped}"`, 'i'),
    new RegExp(`name="${escaped}" content="([^"]+)"`, 'i'),
    new RegExp(`content="([^"]+)" name="${escaped}"`, 'i'),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match?.[1]) return decodeHtml(match[1].trim());
  }
  return '';
}

function extractOgProfile(html) {
  return {
    title: extractMetaTag(html, 'og:title') || extractMetaTag(html, 'twitter:title'),
    description: extractMetaTag(html, 'og:description') || extractMetaTag(html, 'twitter:description'),
    image: extractMetaTag(html, 'og:image') || extractMetaTag(html, 'twitter:image'),
  };
}

function parseJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed);
    } catch {
      /* ignore malformed blocks */
    }
  }
  return blocks;
}

function extractJsonLdByType(html, type) {
  return parseJsonLdBlocks(html).find(
    (block) => block['@type'] === type || (Array.isArray(block['@type']) && block['@type'].includes(type)),
  );
}

function profileToMarkdown(platform, profile, posts, url) {
  const handle = profile.handle || profile.username || profile.screenName || profile.name;
  const parts = [
    `# ${profile.fullName || profile.name || handle}`,
    '',
    `> **Source:** ${platform} public profile (no login)`,
    '',
    '---',
    '',
    '## Profile',
    '',
  ];

  if (profile.handle || profile.username || profile.screenName) {
    const label = profile.username
      ? `@${profile.username}`
      : profile.screenName
        ? `@${profile.screenName}`
        : profile.handle;
    parts.push(`**Handle:** ${label}`);
  }

  if (profile.bio) parts.push(`**Bio:** ${profile.bio}`);
  if (profile.website) parts.push(`**Website:** ${profile.website}`);

  const stats = [];
  if (profile.followers != null) stats.push(`**Followers:** ${formatCount(profile.followers)}`);
  if (profile.following != null) stats.push(`**Following:** ${formatCount(profile.following)}`);
  if (profile.posts != null) stats.push(`**Posts:** ${formatCount(profile.posts)}`);
  if (profile.subscribers != null) stats.push(`**Subscribers:** ${formatCount(profile.subscribers)}`);
  if (profile.karma != null) stats.push(`**Karma:** ${formatCount(profile.karma)}`);
  if (profile.likes != null) stats.push(`**Likes:** ${formatCount(profile.likes)}`);
  if (stats.length) parts.push(stats.join(' · '));

  if (profile.location) parts.push(`**Location:** ${profile.location}`);
  if (profile.industry) parts.push(`**Industry:** ${profile.industry}`);
  if (profile.verified) parts.push('**Verified:** Yes');

  parts.push('');

  if (profile.avatar) {
    parts.push(`![Profile avatar](${profile.avatar})`, '');
  }

  parts.push('---', '', '## Posts', '');

  if (!posts.length) {
    parts.push('_No public posts returned. The profile may be private or rate-limited._', '');
  } else {
    parts.push(`**${posts.length}** recent public posts.`, '');
    for (const post of posts) {
      const label = post.kind || post.type || 'Post';
      const heading = post.shortcode || post.id || post.title?.slice(0, 40) || label;
      parts.push(`### ${label} · ${heading}`);

      if (post.title && post.title !== post.caption) {
        parts.push(`**${post.title}**`);
        parts.push('');
      }

      if (post.caption || post.text || post.body) {
        parts.push(post.caption || post.text || post.body);
        parts.push('');
      }

      const metrics = [];
      if (post.likes != null) metrics.push(`**Likes:** ${formatCount(post.likes)}`);
      if (post.comments != null) metrics.push(`**Comments:** ${formatCount(post.comments)}`);
      if (post.views != null) metrics.push(`**Views:** ${formatCount(post.views)}`);
      if (post.score != null) metrics.push(`**Score:** ${formatCount(post.score)}`);
      if (post.retweets != null) metrics.push(`**Reposts:** ${formatCount(post.retweets)}`);
      if (metrics.length) {
        parts.push(metrics.join(' · '));
        parts.push('');
      }

      if (post.thumbnailUrl) {
        parts.push(`![${label}](${post.thumbnailUrl})`);
        parts.push('');
      }

      if (post.url) {
        parts.push(`[View on ${platform}](${post.url})`);
        parts.push('');
      }
    }
  }

  parts.push('---', '', '## Links', '');
  if (profile.profileUrl) parts.push(`- [View profile](${profile.profileUrl})`);
  parts.push(`- [Original URL](${url})`);
  parts.push('');

  return parts.join('\n').trim();
}

function mergePosts(existing, incoming, maxPosts) {
  const map = new Map(existing.map((post) => [post.id || post.shortcode || post.url, post]));
  for (const post of incoming) {
    const key = post.id || post.shortcode || post.url;
    if (!key) continue;
    const prev = map.get(key);
    if (!prev || (!prev.caption && post.caption) || (!prev.thumbnailUrl && post.thumbnailUrl)) {
      map.set(key, { ...prev, ...post });
    }
  }
  return [...map.values()].slice(0, maxPosts);
}

module.exports = {
  DESKTOP_UA,
  decodeHtml,
  formatCount,
  countWords,
  buildFrontMatter,
  extractMetaTag,
  extractOgProfile,
  parseJsonLdBlocks,
  extractJsonLdByType,
  profileToMarkdown,
  mergePosts,
};
