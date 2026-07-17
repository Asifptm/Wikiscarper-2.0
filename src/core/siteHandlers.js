const { isRedditUrl, scrapeRedditPublic, needsBrowserPool: redditNeedsBrowserPool } = require('./reddit');
const {
  isInstagramUrl,
  scrapeInstagramPublic,
  needsBrowserPool: instagramNeedsBrowserPool,
} = require('./instagram');
const { isXUrl, scrapeXPublic, needsBrowserPool: xNeedsBrowserPool } = require('./x');
const { isYouTubeUrl, scrapeYouTubePublic, needsBrowserPool: youtubeNeedsBrowserPool } = require('./youtube');
const { isTikTokUrl, scrapeTikTokPublic, needsBrowserPool: tiktokNeedsBrowserPool } = require('./tiktok');
const { isLinkedInUrl, scrapeLinkedInPublic, needsBrowserPool: linkedinNeedsBrowserPool } = require('./linkedin');
const { isPinterestUrl, scrapePinterestPublic, needsBrowserPool: pinterestNeedsBrowserPool } = require('./pinterest');
const { isFacebookUrl, scrapeFacebookPublic, needsBrowserPool: facebookNeedsBrowserPool } = require('./facebook');

const SITE_HANDLERS = [
  {
    id: 'reddit',
    configKey: 'reddit',
    isMatch: isRedditUrl,
    scrape: scrapeRedditPublic,
    needsBrowserPool: redditNeedsBrowserPool,
  },
  {
    id: 'instagram',
    configKey: 'instagram',
    isMatch: isInstagramUrl,
    scrape: scrapeInstagramPublic,
    needsBrowserPool: instagramNeedsBrowserPool,
  },
  {
    id: 'x',
    configKey: 'x',
    isMatch: isXUrl,
    scrape: scrapeXPublic,
    needsBrowserPool: xNeedsBrowserPool,
  },
  {
    id: 'youtube',
    configKey: 'youtube',
    isMatch: isYouTubeUrl,
    scrape: scrapeYouTubePublic,
    needsBrowserPool: youtubeNeedsBrowserPool,
  },
  {
    id: 'tiktok',
    configKey: 'tiktok',
    isMatch: isTikTokUrl,
    scrape: scrapeTikTokPublic,
    needsBrowserPool: tiktokNeedsBrowserPool,
  },
  {
    id: 'linkedin',
    configKey: 'linkedin',
    isMatch: isLinkedInUrl,
    scrape: scrapeLinkedInPublic,
    needsBrowserPool: linkedinNeedsBrowserPool,
  },
  {
    id: 'pinterest',
    configKey: 'pinterest',
    isMatch: isPinterestUrl,
    scrape: scrapePinterestPublic,
    needsBrowserPool: pinterestNeedsBrowserPool,
  },
  {
    id: 'facebook',
    configKey: 'facebook',
    isMatch: isFacebookUrl,
    scrape: scrapeFacebookPublic,
    needsBrowserPool: facebookNeedsBrowserPool,
  },
];

function matchSiteHandler(url, config = {}) {
  for (const handler of SITE_HANDLERS) {
    if (config[handler.configKey]?.enabled === false) continue;
    if (handler.isMatch(url)) return handler;
  }
  return null;
}

function listSiteHandlers(config = {}) {
  return SITE_HANDLERS.filter((h) => config[h.configKey]?.enabled !== false).map((h) => h.id);
}

function handlerNeedsBrowserPool(handler, url) {
  return typeof handler.needsBrowserPool === 'function' && handler.needsBrowserPool(url);
}

module.exports = {
  SITE_HANDLERS,
  matchSiteHandler,
  listSiteHandlers,
  handlerNeedsBrowserPool,
};
