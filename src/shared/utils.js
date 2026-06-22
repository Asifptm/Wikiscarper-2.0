const crypto = require('crypto');

function cacheKey(url) {
  return crypto.createHash('sha256').update(url.trim()).digest('hex');
}

function slugify(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const base = `${hostname}${pathname}`.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
    return base.slice(0, 120) || 'page';
  } catch {
    return 'page';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { cacheKey, slugify, sleep, isValidUrl };
