const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const posts = [];
  page.on('response', async (res) => {
    const u = res.url();
    if (!u.includes('graphql') && !u.includes('web_profile_info') && !u.includes('feed/user')) return;
    try {
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const j = await res.json();
      const edges =
        j.data?.user?.edge_owner_to_timeline_media?.edges ??
        j.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges ??
        [];
      for (const e of edges) {
        const n = e.node ?? e;
        if (n?.shortcode) posts.push(n.shortcode);
      }
    } catch {
      /* ignore */
    }
  });

  await page.goto('https://www.instagram.com/microsoft/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 5; i += 1) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(1500);
  }

  const links = await page.$$eval('a[href*="/p/"], a[href*="/reel/"]', (els) =>
    [...new Set(els.map((a) => a.getAttribute('href')))].slice(0, 20),
  );
  console.log('network shortcodes', [...new Set(posts)].slice(0, 15));
  console.log('dom links', links.slice(0, 15));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
