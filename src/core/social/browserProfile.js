const { dismissLoginWall } = require('../loginWall');

async function scrapeWithBrowser(pool, options) {
  const {
    url,
    userAgent,
    timeout = 45000,
    viewport = { width: 1280, height: 900 },
    bypassLogin = true,
    scrollRounds = 5,
    scrollDelay = 1200,
    onResponse,
    collectDom,
    blockResources = [],
  } = options;

  const context = await pool.acquireContext({
    userAgent,
    viewport,
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  try {
    const page = await context.newPage();

    if (blockResources.length) {
      await page.route('**/*', (route) => {
        if (blockResources.includes(route.request().resourceType())) route.abort();
        else route.continue();
      });
    }

    if (onResponse) {
      page.on('response', (res) => {
        onResponse(res).catch(() => {});
      });
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);

    if (bypassLogin !== false) {
      await dismissLoginWall(page, options).catch(() => 0);
    }

    for (let i = 0; i < scrollRounds; i += 1) {
      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(scrollDelay);
    }

    const html = await page.content();
    const domData = collectDom ? await collectDom(page).catch(() => null) : null;

    return { html, domData, page };
  } finally {
    await pool.releaseContext(context);
  }
}

module.exports = { scrapeWithBrowser };
