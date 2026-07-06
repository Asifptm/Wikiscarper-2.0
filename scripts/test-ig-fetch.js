const { fetchUrl } = require('../src/core/httpClient');

async function main() {
  for (const url of [
    'https://www.instagram.com/natgeo/embed/',
    'https://www.instagram.com/natgeo/',
  ]) {
    const r = await fetchUrl(url, {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    });
    const ogTitle = r.body.match(/property="og:title" content="([^"]+)"/)?.[1];
    const ogDesc = r.body.match(/property="og:description" content="([^"]+)"/)?.[1];
    console.log(url, r.statusCode, ogTitle, ogDesc?.slice(0, 80));
  }
}

main();
