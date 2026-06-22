const https = require('node:https');
const http = require('node:http');
const zlib = require('node:zlib');
const { URL } = require('node:url');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function fetchOnce(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      reject(new Error(`ERR_NAV_INVALID: ${targetUrl}`));
      return;
    }

    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request(
      parsed,
      {
        method: 'GET',
        headers: {
          'User-Agent': options.userAgent || DEFAULT_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          Connection: 'close',
        },
        timeout: options.timeout || 30000,
      },
      (res) => {
        const { statusCode, headers } = res;

        if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
          res.resume();
          const nextUrl = new URL(headers.location, parsed).href;
          resolve({ redirect: nextUrl, statusCode, headers });
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const encoding = (headers['content-encoding'] || '').toLowerCase();

          const finish = (body) =>
            resolve({ statusCode, headers, body: body.toString('utf8') });

          try {
            if (encoding === 'gzip') {
              zlib.gunzip(buffer, (err, out) => (err ? reject(err) : finish(out)));
            } else if (encoding === 'deflate') {
              zlib.inflate(buffer, (err, out) => (err ? reject(err) : finish(out)));
            } else if (encoding === 'br') {
              zlib.brotliDecompress(buffer, (err, out) => (err ? reject(err) : finish(out)));
            } else {
              finish(buffer);
            }
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`ERR_NAV_TIMEOUT: ${targetUrl}`));
    });
    req.on('error', (err) => reject(new Error(`ERR_NET_${err.code || 'FAIL'}: ${err.message}`)));
    req.end();
  });
}

async function fetchUrl(targetUrl, options = {}) {
  let url = targetUrl;
  const maxRedirects = options.maxRedirects ?? 5;

  for (let i = 0; i <= maxRedirects; i += 1) {
    const result = await fetchOnce(url, options);
    if (result.redirect) {
      url = result.redirect;
      continue;
    }
    return { ...result, finalUrl: url };
  }

  throw new Error(`ERR_NAV_REDIRECT: too many redirects for ${targetUrl}`);
}

module.exports = { fetchUrl };
