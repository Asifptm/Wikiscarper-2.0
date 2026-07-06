const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.instagram.com/natgeo/embed/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log(await page.evaluate(() => document.body.innerText.slice(0, 400)));
  await browser.close();
}

main();
