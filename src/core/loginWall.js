const { sleep } = require('../shared/utils');

// Site-specific overlay/dialog selectors that gate otherwise-public content.
const SITE_SELECTORS = {
  'instagram.com': [
    'div[role="presentation"]',
    'div[role="dialog"]',
    'div._a9-z',
    'div.x1n2onr6.xzkaem6',
  ],
  'facebook.com': [
    '#login_popup_cta_form',
    'div[role="dialog"]',
    'div[data-nosnippet]',
    'div.__fb-light-mode [role="dialog"]',
  ],
  'twitter.com': ['div[role="dialog"]', 'div[data-testid="sheetDialog"]'],
  'x.com': ['div[role="dialog"]', 'div[data-testid="sheetDialog"]'],
};

function matchSiteSelectors(url) {
  const selectors = [];
  for (const [host, list] of Object.entries(SITE_SELECTORS)) {
    if (url.includes(host)) selectors.push(...list);
  }
  return selectors;
}

/**
 * Removes login / sign-up modal overlays and re-enables page scrolling so that
 * the already-public page content can be extracted. This does NOT authenticate
 * or unlock private/login-required content.
 */
async function dismissLoginWall(page, options = {}) {
  const url = page.url();
  const siteSelectors = matchSiteSelectors(url);
  const attempts = options.loginWallAttempts ?? 3;
  let totalRemoved = 0;

  for (let i = 0; i < attempts; i += 1) {
    // Login modals on social sites often appear after a short delay.
    await page.waitForTimeout(options.loginWallDelay ?? 1200).catch(() => {});

    const removed = await page.evaluate((selectors) => {
      let count = 0;

      const killScrollLock = () => {
        for (const el of [document.documentElement, document.body]) {
          if (!el) continue;
          el.style.setProperty('overflow', 'auto', 'important');
          el.style.setProperty('position', 'static', 'important');
          el.style.removeProperty('height');
          el.classList.remove('modal-open', 'no-scroll', 'overflow-hidden');
        }
      };

      // 1. Remove explicitly known site-specific overlays.
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const text = (el.innerText || '').toLowerCase();
          if (/log in|sign up|log into|continue with|create new account/.test(text)) {
            el.remove();
            count += 1;
          }
        });
      }

      // 2. Heuristic: remove fixed/absolute high z-index overlays whose text is a
      //    short login/sign-up CTA (avoids deleting real article content).
      const nodes = Array.from(
        document.querySelectorAll('div, section, [role="dialog"], [role="presentation"]'),
      );
      for (const el of nodes) {
        const style = window.getComputedStyle(el);
        const overlay =
          (style.position === 'fixed' || style.position === 'absolute') &&
          parseInt(style.zIndex || '0', 10) >= 50;
        if (!overlay) continue;
        const text = (el.innerText || '').toLowerCase();
        const isLoginCta =
          /log in|sign up|log into|continue with|create new account|see more on/.test(text) &&
          text.length < 600;
        if (isLoginCta) {
          el.remove();
          count += 1;
        }
      }

      // 3. Remove dimming backdrops left behind.
      document
        .querySelectorAll('[class*="backdrop" i], [class*="overlay" i], [class*="modal" i]')
        .forEach((el) => {
          const s = window.getComputedStyle(el);
          if (s.position === 'fixed' && parseFloat(s.opacity || '1') > 0) {
            el.remove();
            count += 1;
          }
        });

      killScrollLock();
      return count;
    }, siteSelectors);

    totalRemoved += removed;
    if (removed === 0 && i > 0) break;
  }

  return totalRemoved;
}

module.exports = { dismissLoginWall };
