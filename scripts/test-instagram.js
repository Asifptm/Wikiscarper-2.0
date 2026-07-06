const { fetchUrl } = require('../src/core/httpClient');
const { chromium } = require('playwright');

const postUrl = process.argv[2] || 'https://www.instagram.com/p/DAbCdEfGhIj/';
const shortcode = postUrl.match(/\/(?:p|reel|tv)\/([^/?#]+)/)?.[1];

async function fetchEmbed() {
  if (!shortcode) return;
  const url = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
  const r = await fetchUrl(url, {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  console.log('embed len', r.body.length);
  const markers = ['Caption', 'caption', 'edge_media', 'shortcode', 'username', 'graphql'];
  for (const m of markers) console.log(m, r.body.includes(m));
  const idx = r.body.indexOf('Caption');
  console.log('sample', r.body.slice(Math.max(0, idx - 50), idx + 400));
}

async function browserEmbed() {
  if (!shortcode) return;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const url = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500));
  const html = await page.content();
  console.log('browser text:', text);
  console.log('has login', /log in/i.test(html));
  await browser.close();
}

async function browserPost() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  });
  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const meta = await page.evaluate(() => ({
    title: document.title,
    ogDesc: document.querySelector('meta[property="og:description"]')?.content,
    ogTitle: document.querySelector('meta[property="og:title"]')?.content,
    ogImage: document.querySelector('meta[property="og:image"]')?.content,
    text: document.body?.innerText?.slice(0, 300),
  }));
  console.log('post meta', meta);
  await browser.close();
}

(async () => {
  console.log('URL', postUrl);
  await fetchEmbed();
  await browserEmbed();
  await browserPost();
})();
