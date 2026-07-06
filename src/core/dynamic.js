const { sleep } = require('../shared/utils');

async function handleInfiniteScroll(page, options = {}) {
  const fast = options.fast === true;
  const {
    maxScrolls = fast ? 5 : 20,
    scrollDelay = fast ? 600 : 1500,
    itemSelector = null,
  } = options;

  let previousCount = 0;
  let scrollCount = 0;

  while (scrollCount < maxScrolls) {
    const currentCount = itemSelector
      ? await page.$$(itemSelector).then((els) => els.length)
      : await page.evaluate(() => document.body.scrollHeight);

    if (currentCount === previousCount && scrollCount > 0) break;

    previousCount = currentCount;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(scrollDelay);
    if (!fast) {
      await page.waitForLoadState('networkidle').catch(() => {});
    }
    scrollCount += 1;
  }

  return scrollCount;
}

async function handleLazyImages(page) {
  await page.evaluate(async () => {
    const images = Array.from(document.querySelectorAll('img[loading="lazy"], img[data-src]'));
    for (const img of images) {
      img.scrollIntoView({ behavior: 'instant', block: 'center' });
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  await page.waitForTimeout(500);
}

async function waitForDynamicContent(page, options = {}) {
  const waitFor = options.waitFor ?? 'networkidle';
  const timeout = options.timeout ?? 30000;

  if (options.selector) {
    await page.waitForSelector(options.selector, { timeout });
    return;
  }

  if (waitFor === 'networkidle') {
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  } else if (waitFor === 'domcontentloaded') {
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
  } else if (typeof waitFor === 'number') {
    await sleep(waitFor);
  }
}

module.exports = {
  handleInfiniteScroll,
  handleLazyImages,
  waitForDynamicContent,
};
