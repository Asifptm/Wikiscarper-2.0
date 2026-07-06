/**
 * CAPTCHA integration test — Google reCAPTCHA v2 demo page.
 * Run: node scripts/test-captcha.js
 *      node scripts/test-captcha.js --headed
 */
const { chromium } = require('playwright');
const { solve_captcha, detectCaptchaType } = require('../src/core/captcha');
const { loadConfig } = require('../src/shared/config');
const { table, keyValueTable, paint, c } = require('../src/cli/ui');

const DEMO_URL = 'https://www.google.com/recaptcha/api2/demo';

async function main() {
  const config = loadConfig();
  const captchaConfig = {
    ...config.captcha,
    mode: 'auto',
    autoTimeout: 60000,
    allowManualFallback: false,
  };

  const headed = process.argv.includes('--headed') || captchaConfig.headed === true;

  console.log('');
  console.log(paint(c.bold, 'CAPTCHA TEST'));
  console.log(
    keyValueTable([
      ['URL', DEMO_URL],
      ['Headed', headed ? 'yes' : 'no'],
      ['Mode', captchaConfig.mode],
    ]),
  );
  console.log('');

  const browser = await chromium.launch({
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  const steps = [];

  try {
    console.log(paint(c.dim, '[1/4] Navigating...'));
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    console.log(paint(c.dim, '[2/4] Detecting CAPTCHA...'));
    const detected = await detectCaptchaType(page);

    if (detected !== 'recaptcha-v2') {
      console.log('');
      console.log(paint(c.red, 'FAIL — expected recaptcha-v2, got: ' + (detected ?? 'none')));
      process.exitCode = 1;
      return;
    }

    console.log(paint(c.dim, '[3/4] Running solve_captcha...'));
    const result = await solve_captcha(page, captchaConfig, (data) => {
      steps.push(data);
    });

    const tokenLen = await page.evaluate(() => {
      const el = document.querySelector(
        '#g-recaptcha-response, textarea[name="g-recaptcha-response"]',
      );
      return el?.value?.length ?? 0;
    });

    let verdict;
    let verdictColor = c.red;
    if (result.solved && tokenLen > 10) {
      verdict = 'PASS';
      verdictColor = c.green;
      process.exitCode = 0;
    } else if (detected === 'recaptcha-v2' && steps.some((s) => s.step === 'clicked')) {
      verdict = headed ? 'FAIL (no token)' : 'PARTIAL (headless — use --headed)';
      verdictColor = c.yellow;
      process.exitCode = headed ? 1 : 2;
    } else {
      verdict = 'FAIL';
      process.exitCode = 1;
    }

    console.log('');
    console.log(paint(c.bold, 'TEST RESULT'));
    console.log(
      keyValueTable([
        ['Verdict', paint(verdictColor, verdict)],
        ['Detected', detected ?? '—'],
        ['Solved', result.solved ? paint(c.green, 'yes') : paint(c.red, 'no')],
        ['Type', result.type ?? '—'],
        ['Mode', result.mode ?? '—'],
        ['Token length', String(tokenLen)],
        ['Error', result.error ? paint(c.red, result.error) : paint(c.dim, '—')],
      ]),
    );

    console.log('');
    console.log(paint(c.bold, 'PROGRESS STEPS'));
    console.log(
      table(
        ['#', 'STEP', 'TYPE', 'DETAIL'],
        steps.map((s, i) => [
          String(i + 1),
          s.step,
          s.type ?? '—',
          s.error ? paint(c.red, s.error) : paint(c.dim, '—'),
        ]),
      ),
    );
    console.log('');
  } catch (err) {
    console.log('');
    console.log(paint(c.red, 'ERROR: ' + err.message));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
