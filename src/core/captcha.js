const { sleep } = require('../shared/utils');

const CAPTCHA_PROFILES = {
  'recaptcha-v2': {
    iframe:
      'iframe[src*="google.com/recaptcha"][src*="anchor"], iframe[src*="recaptcha/api2/anchor"]',
    checkbox: '#recaptcha-anchor, .recaptcha-checkbox-border',
    token: '#g-recaptcha-response, textarea[name="g-recaptcha-response"]',
  },
  hcaptcha: {
    iframe: 'iframe[src*="hcaptcha.com"][src*="checkbox"]',
    checkbox: '#checkbox, div#checkbox',
    token: '[name="h-captcha-response"], textarea[name="h-captcha-response"]',
  },
  turnstile: {
    widget: '.cf-turnstile iframe, iframe[src*="challenges.cloudflare.com"]',
    checkbox: 'input[type="checkbox"], label',
    token: 'input[name="cf-turnstile-response"]',
  },
  image: {
    input: 'input[name*="captcha" i], input[id*="captcha" i]',
    image: 'img[alt*="captcha" i], canvas',
  },
};

async function detectCaptchaType(page) {
  return page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      const src = iframe.src || '';
      if (src.includes('recaptcha') && src.includes('anchor')) return 'recaptcha-v2';
      if (src.includes('hcaptcha') && src.includes('checkbox')) return 'hcaptcha';
    }
    if (document.querySelector('.cf-turnstile, input[name="cf-turnstile-response"]')) {
      return 'turnstile';
    }
    if (document.querySelector('img[alt*="captcha" i], canvas')) return 'image';
    return null;
  });
}

async function waitForCaptchaWidget(page, timeout = 15000) {
  await page
    .waitForSelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .cf-turnstile, [data-sitekey]',
      { timeout, state: 'attached' },
    )
    .catch(() => {});
  await page.waitForTimeout(1500);
}

async function readCaptchaToken(page, tokenSelector, type) {
  if (type === 'recaptcha-v2') {
    const token = await page.evaluate(() => {
      const fields = document.querySelectorAll(
        '#g-recaptcha-response, textarea[name="g-recaptcha-response"]',
      );
      for (const el of fields) {
        if (el.value && el.value.length > 10) return el.value.trim();
      }
      return '';
    });
    if (token) return token;
  }

  return page.evaluate((sel) => {
    const nodes = sel.split(',').map((s) => s.trim());
    for (const part of nodes) {
      const el = document.querySelector(part);
      const value = el?.value ?? el?.textContent ?? '';
      if (typeof value === 'string' && value.trim().length > 10) return value.trim();
    }
    return '';
  }, tokenSelector);
}

async function waitForCaptchaToken(page, tokenSelector, timeout, pollInterval, onStep, type) {
  const start = Date.now();
  const deadline = start + timeout;

  while (Date.now() < deadline) {
    const token = await readCaptchaToken(page, tokenSelector, type);
    if (token.length > 10) return token;

    const elapsed = Date.now() - start;
    const percent = Math.min(99, Math.round((elapsed / timeout) * 100));
    if (onStep) onStep({ step: 'waiting', percent, elapsed, timeout });

    await sleep(pollInterval);
  }
  return null;
}

async function clickCaptchaInFrame(page, iframeSelector, checkboxSelector) {
  const iframe = page.locator(iframeSelector).first();
  await iframe.waitFor({ state: 'attached', timeout: 15000 });
  if ((await iframe.count()) === 0) {
    throw new Error('ERR_CAP_IFRAME: CAPTCHA iframe not found');
  }

  await iframe.scrollIntoViewIfNeeded().catch(() => {});

  const frame = page.frameLocator(iframeSelector).first();
  const checkbox = frame.locator(checkboxSelector).first();
  await checkbox.waitFor({ state: 'visible', timeout: 15000 });
  if ((await checkbox.count()) === 0) {
    throw new Error('ERR_CAP_WIDGET: CAPTCHA checkbox not found inside iframe');
  }

  await checkbox.click({ delay: 120, timeout: 15000 });

  // Wait until Google marks the checkbox solved or a challenge iframe appears.
  await frame
    .locator('#recaptcha-anchor[aria-checked="true"]')
    .waitFor({ state: 'attached', timeout: 8000 })
    .catch(() => {});

  return true;
}

async function clickTurnstileWidget(page, profile) {
  const widgetFrame = page.frameLocator(profile.widget).first();
  const checkbox = widgetFrame.locator(profile.checkbox).first();
  if ((await checkbox.count()) > 0) {
    await checkbox.click({ timeout: 10000 });
    return true;
  }

  const widget = page.locator('.cf-turnstile, [data-sitekey]').first();
  if ((await widget.count()) > 0) {
    await widget.click({ timeout: 10000 });
    return true;
  }

  throw new Error('ERR_CAP_WIDGET: Turnstile widget not found');
}

/**
 * Browser-native CAPTCHA solver (Selenium WebDriver pattern).
 * Emits progress steps via onStep for GUI/CLI feedback.
 */
async function solve_captcha(page, config = {}, onStep = null) {
  const timeout = config.timeout ?? 180000;
  const pollInterval = config.pollInterval ?? 500;
  const mode = config.mode ?? 'auto';
  const autoTimeout = config.autoTimeout ?? 45000;
  const allowManualFallback = config.allowManualFallback !== false;

  const emit = (payload) => {
    if (typeof onStep === 'function') onStep(payload);
  };

  try {
    emit({ step: 'scanning' });
    await waitForCaptchaWidget(page);

    const type = await detectCaptchaType(page);
    if (!type) {
      emit({ step: 'none' });
      return { solved: false, type: null, error: null };
    }

    emit({ step: 'detected', type });

    const profile = CAPTCHA_PROFILES[type];
    if (!profile) {
      const err = `ERR_CAP_UNSUPPORTED: Unsupported CAPTCHA type (${type})`;
      emit({ step: 'error', type, error: err });
      return { solved: false, type, error: err };
    }

    const tokenSelector = profile.token || profile.input;
    if (!tokenSelector) {
      const err = `ERR_CAP_NO_TOKEN_SEL: No token field for ${type}`;
      emit({ step: 'error', type, error: err });
      return { solved: false, type, error: err };
    }

    const waitToken = (ms, stepHandler) =>
      waitForCaptchaToken(page, tokenSelector, ms, pollInterval, stepHandler, type);

    if (mode === 'manual') {
      emit({ step: 'manual-wait', type, timeout });
      const token = await waitToken(timeout, emit);
      if (token) {
        emit({ step: 'passed', type, mode: 'manual' });
        return { solved: true, type, mode: 'manual', error: null };
      }
      const err = 'ERR_CAP_MANUAL_TIMEOUT: Manual CAPTCHA solve timed out';
      emit({ step: 'failed', type, error: err });
      return { solved: false, type, mode: 'manual', manual: true, error: err };
    }

    emit({ step: 'clicking', type });

    try {
      if (type === 'recaptcha-v2' || type === 'hcaptcha') {
        await clickCaptchaInFrame(page, profile.iframe, profile.checkbox);
      } else if (type === 'turnstile') {
        await clickTurnstileWidget(page, profile);
      }
      emit({ step: 'clicked', type });
    } catch (clickErr) {
      emit({ step: 'click-failed', type, error: clickErr.message });
    }

    let token = await waitToken(autoTimeout, emit);

    if (!token && allowManualFallback) {
      const remaining = Math.max(timeout - autoTimeout, 30000);
      emit({ step: 'manual-wait', type, timeout: remaining });
      token = await waitToken(remaining, emit);
      if (token) {
        emit({ step: 'passed', type, mode: 'manual-fallback' });
        return { solved: true, type, mode: 'manual-fallback', error: null };
      }
    }

    if (token) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      emit({ step: 'passed', type, mode: 'auto' });
      return { solved: true, type, mode: 'auto', error: null };
    }

    const err =
      'ERR_CAP_TOKEN_TIMEOUT: CAPTCHA token not received — try config/local.json with "headless": false and solve manually in the browser window';
    emit({ step: 'failed', type, error: err });
    return { solved: false, type, mode: 'auto', error: err };
  } catch (err) {
    const message = err.message || 'ERR_CAP_UNKNOWN: CAPTCHA handler failed';
    emit({ step: 'error', error: message });
    return { solved: false, type: null, error: message };
  }
}

async function detectAndSolve(page, config, onStep) {
  return solve_captcha(page, config, onStep);
}

module.exports = {
  solve_captcha,
  detectAndSolve,
  detectCaptchaType,
};
