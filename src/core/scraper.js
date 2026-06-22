const fs = require('fs');
const path = require('path');
const CacheManager = require('../cache');
const { htmlToMarkdown, htmlToMarkdownBuiltin } = require('./extractor');
const { fetchUrl } = require('./httpClient');
const Reporter = require('./reporter');
const createLogger = require('./logger');
const { loadConfig, resolvePath } = require('../shared/config');
const { slugify, isValidUrl } = require('../shared/utils');

let chromium = null;
function getChromium() {
  if (!chromium) {
    ({ chromium } = require('playwright'));
  }
  return chromium;
}

// Low-overhead Chromium launch flags: disable GPU, extensions, background work,
// and shared-memory usage so a single browser stays light.
const LOW_RESOURCE_ARGS = [
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-features=TranslateUI,site-per-process',
  '--no-first-run',
  '--mute-audio',
  '--no-sandbox',
];

const CAPTCHA_LAUNCH_ARGS = [
  ...LOW_RESOURCE_ARGS,
  '--disable-blink-features=AutomationControlled',
];

// Bounds how many pages render at once so memory stays predictable.
class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.waiters = [];
  }

  acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    if (this.waiters.length) {
      const next = this.waiters.shift();
      next();
    } else {
      this.active -= 1;
    }
  }
}

// Single shared browser + a context per scrape (contexts are cheap and isolated).
// Auto-closes the browser after an idle period to release memory.
class BrowserPool {
  constructor(concurrency = 3, launchOptions = {}, idleTimeout = 60000) {
    this.concurrency = concurrency;
    this.opts = launchOptions;
    this.idleTimeout = idleTimeout;
    this.browser = null;
    this.sem = new Semaphore(concurrency);
    this.inFlight = 0;
    this.idleTimer = null;
    this.launching = null;
  }

  async _ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (!this.launching) {
      const engine = getChromium();
      this.launching = engine.launch(this.opts).then((b) => {
        this.browser = b;
        this.launching = null;
        return b;
      });
    }
    return this.launching;
  }

  _cancelIdleClose() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _scheduleIdleClose() {
    this._cancelIdleClose();
    if (this.inFlight > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.inFlight === 0) this.close().catch(() => {});
    }, this.idleTimeout);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  async acquireContext(contextOptions = {}) {
    this._cancelIdleClose();
    await this.sem.acquire();
    this.inFlight += 1;
    try {
      const browser = await this._ensureBrowser();
      const context = await browser.newContext(contextOptions);
      return context;
    } catch (err) {
      this.inFlight -= 1;
      this.sem.release();
      throw err;
    }
  }

  async releaseContext(context) {
    if (context) await context.close().catch(() => {});
    this.inFlight -= 1;
    this.sem.release();
    if (this.inFlight === 0) this._scheduleIdleClose();
  }

  async close() {
    this._cancelIdleClose();
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => {});
  }
}

class ScraperEngine {
  constructor(configOverride = null) {
    this.config = configOverride ?? loadConfig();
    this.logger = createLogger(this.config.logging);
    this.cache = new CacheManager(this.config.cache);
    this.reporter = new Reporter(this.config.reports);
    this.pool = null;
    this.onProgress = null;
  }

  setProgressCallback(cb) {
    this.onProgress = cb;
  }

  _emitProgress(data) {
    if (this.onProgress) this.onProgress(data);
  }

  async _ensurePool(concurrency, options = {}) {
    const headless = this._resolveHeadless(options);
    const launchOpts = {
      headless,
      args: options.captcha ? CAPTCHA_LAUNCH_ARGS : LOW_RESOURCE_ARGS,
      ignoreDefaultArgs: options.captcha ? ['--enable-automation'] : undefined,
    };

    if (this.pool && this.pool.opts.headless !== headless) {
      await this.pool.close();
      this.pool = null;
    }

    if (!this.pool) {
      this.pool = new BrowserPool(
        concurrency,
        launchOpts,
        this.config.scraper.idleTimeout ?? 60000,
      );
    }
    await this.pool._ensureBrowser();
  }

  _resolveHeadless(options) {
    if (options.captcha && this.config.captcha?.headed !== false) {
      return false;
    }
    if (options.headless !== undefined) return options.headless;
    return this.config.scraper.headless ?? true;
  }

  _resolveBlockResources(options) {
    if (options.captcha) {
      return (
        options.blockResources ??
        this.config.captcha?.blockResources ??
        ['media', 'font']
      );
    }
    return (
      options.blockResources ??
      this.config.scraper.blockResources ??
      ['image', 'media', 'font', 'stylesheet']
    );
  }

  async scrapeUrl(url, options = {}) {
    if (!isValidUrl(url)) {
      throw new Error(`ERR_NAV_INVALID: Invalid URL — ${url}`);
    }

    const useCache = options.cache !== false;
    const start = Date.now();

    if (useCache) {
      const cached = this.cache.get(url);
      if (cached?.markdown) {
        this._emitProgress({ url, status: 'cache-hit', layer: cached.cacheLayer });
        return {
          url,
          status: cached.status ?? 200,
          cache_hit: true,
          cache_layer: cached.cacheLayer,
          markdown: cached.markdown,
          word_count: cached.wordCount ?? 0,
          output_file: cached.outputFile ?? null,
          nav_ms: 0,
          render_ms: 0,
          extract_ms: 0,
          total_ms: Date.now() - start,
          scrolls: 0,
          captcha: false,
          error: null,
        };
      }
    }

    // Primary engine: Playwright (Chromium) + Turndown.
    // Optional lightweight path: only when explicitly requested via options.direct.
    if (options.direct === true) {
      return this.scrapeDirect(url, options, start, useCache);
    }

    return this.scrapeWithBrowser(url, options, start, useCache);
  }

  async scrapeDirect(url, options, start, useCache) {
    const navStart = Date.now();
    try {
      const res = await fetchUrl(url, {
        userAgent: options.userAgent ?? this.config.scraper.userAgent,
        timeout: options.timeout ?? this.config.scraper.timeout ?? 30000,
      });

      const navMs = Date.now() - navStart;
      const extractStart = Date.now();
      const status = res.statusCode ?? 200;

      if (status >= 400) {
        throw new Error(`ERR_NAV_HTTP_${status}: server returned ${status}`);
      }

      const { markdown, wordCount } = htmlToMarkdownBuiltin(res.body, {
        url,
        frontMatter: this.config.output.frontMatter !== false,
        stats: {
          status,
          contentType: res.headers['content-type'],
          etag: res.headers.etag,
          durationMs: Date.now() - start,
        },
      });

      const extractMs = Date.now() - extractStart;

      const outputDir = resolvePath(options.output ?? this.config.output.dir);
      fs.mkdirSync(outputDir, { recursive: true });
      const outputFile = path.join(outputDir, `${slugify(url)}.md`);
      fs.writeFileSync(outputFile, markdown);

      if (useCache) {
        this.cache.set(url, {
          html: res.body,
          markdown,
          wordCount,
          status,
          headers: res.headers,
          etag: res.headers.etag,
          outputFile,
        });
      }

      this._emitProgress({ url, status: 'done', outputFile, method: 'direct' });

      return {
        url,
        status,
        cache_hit: false,
        cache_layer: null,
        markdown,
        word_count: wordCount,
        output_file: outputFile,
        method: 'direct',
        nav_ms: navMs,
        render_ms: 0,
        extract_ms: extractMs,
        total_ms: Date.now() - start,
        scrolls: 0,
        captcha: false,
        error: null,
      };
    } catch (err) {
      this.logger.error('Direct scrape failed', { url, error: err.message });
      return {
        url,
        status: null,
        cache_hit: false,
        cache_layer: null,
        markdown: null,
        word_count: 0,
        output_file: null,
        method: 'direct',
        nav_ms: Date.now() - navStart,
        render_ms: 0,
        extract_ms: 0,
        total_ms: Date.now() - start,
        scrolls: 0,
        captcha: false,
        error: err.message,
      };
    }
  }

  async scrapeWithBrowser(url, options, start, useCache) {
    const { handleInfiniteScroll, handleLazyImages, waitForDynamicContent } = require('./dynamic');
    const { solve_captcha } = require('./captcha');
    const { dismissLoginWall } = require('./loginWall');

    const concurrency = options.concurrency ?? this.config.scraper.concurrency ?? 3;

    try {
      await this._ensurePool(concurrency, options);
    } catch (err) {
      const missingBrowser = /Executable doesn't exist|playwright install|Failed to launch/i.test(
        err.message || '',
      );
      if (missingBrowser) {
        this.logger.warn(
          'Playwright browser unavailable — falling back to direct HTTP fetch. ' +
            'Run "npx playwright install chromium" to enable full browser rendering.',
          { url, error: err.message },
        );
        this._emitProgress({ url, status: 'fallback-direct', error: err.message });
        return this.scrapeDirect(url, options, start, useCache);
      }
      throw err;
    }

    let context;
    let page;
    const navStart = Date.now();
    let navMs = 0;
    let renderMs = 0;
    let extractMs = 0;
    let scrolls = 0;
    let captchaResult = { solved: false };

    try {
      context = await this.pool.acquireContext({
        userAgent: options.userAgent ?? this.config.scraper.userAgent,
        viewport: options.viewport ?? this.config.scraper.viewport,
        extraHTTPHeaders: options.headers ?? { 'Accept-Language': 'en-US,en;q=0.9' },
        proxy: options.proxy ? { server: options.proxy } : undefined,
        locale: 'en-US',
      });

      page = await context.newPage();

      if (options.captcha) {
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
      }

      const blocked = this._resolveBlockResources(options);
      if (blocked.length) {
        await page.route('**/*', (route) => {
          if (blocked.includes(route.request().resourceType())) route.abort();
          else route.continue();
        });
      }

      const response = await page.goto(url, {
        waitUntil: options.waitFor ?? this.config.scraper.waitFor ?? 'domcontentloaded',
        timeout: options.timeout ?? this.config.scraper.timeout ?? 30000,
      });

      navMs = Date.now() - navStart;
      const renderStart = Date.now();

      await waitForDynamicContent(page, options);

      // Dismiss login/sign-up walls (e.g. Instagram/Facebook) so public content
      // is reachable. Enabled by default; pass bypassLogin:false to disable.
      if (options.bypassLogin !== false) {
        const removed = await dismissLoginWall(page, options).catch(() => 0);
        if (removed > 0) {
          this._emitProgress({ url, status: 'login-wall-dismissed', count: removed });
        }
      }

      if (options.scroll) {
        scrolls = await handleInfiniteScroll(page, options);
      }

      await handleLazyImages(page);

      if (options.captcha) {
        this._emitProgress({ url, status: 'captcha-start', headed: !this._resolveHeadless(options) });
        captchaResult = await solve_captcha(page, this.config.captcha, (data) => {
          this._emitProgress({ url, status: 'captcha-progress', ...data });
        });

        if (captchaResult.solved) {
          this._emitProgress({
            url,
            status: 'captcha-solved',
            type: captchaResult.type,
            mode: captchaResult.mode,
          });
        } else if (captchaResult.type) {
          this._emitProgress({
            url,
            status: 'captcha-failed',
            type: captchaResult.type,
            error: captchaResult.error,
          });
          this.logger.warn('CAPTCHA not passed — continuing scrape', {
            url,
            type: captchaResult.type,
            error: captchaResult.error,
          });
        } else if (captchaResult.error) {
          this._emitProgress({
            url,
            status: 'captcha-error',
            error: captchaResult.error,
          });
        } else {
          this._emitProgress({ url, status: 'captcha-none' });
        }
      }

      if (options.bypassLogin !== false) {
        await dismissLoginWall(page, { ...options, loginWallAttempts: 1 }).catch(() => 0);
      }

      renderMs = Date.now() - renderStart;
      const extractStart = Date.now();

      const html = await page.content();
      const status = response?.status() ?? 200;
      const headers = response?.headers() ?? {};

      const { markdown, wordCount } = htmlToMarkdown(html, {
        url,
        frontMatter: this.config.output.frontMatter !== false,
        stats: {
          status,
          contentType: headers['content-type'],
          etag: headers.etag,
          durationMs: Date.now() - start,
          scrolls,
          captcha: captchaResult.solved,
        },
      });

      extractMs = Date.now() - extractStart;

      const outputDir = resolvePath(options.output ?? this.config.output.dir);
      fs.mkdirSync(outputDir, { recursive: true });
      const outputFile = path.join(outputDir, `${slugify(url)}.md`);
      fs.writeFileSync(outputFile, markdown);

      if (useCache) {
        this.cache.set(url, {
          html,
          markdown,
          wordCount,
          status,
          headers,
          etag: headers.etag,
          outputFile,
        });
      }

      this._emitProgress({ url, status: 'done', outputFile });

      return {
        url,
        status,
        cache_hit: false,
        cache_layer: null,
        markdown,
        word_count: wordCount,
        output_file: outputFile,
        nav_ms: navMs,
        render_ms: renderMs,
        extract_ms: extractMs,
        total_ms: Date.now() - start,
        scrolls,
        captcha: captchaResult.solved,
        captcha_type: captchaResult.type ?? null,
        captcha_error: captchaResult.error ?? null,
        captcha_status: !options.captcha
          ? 'skipped'
          : captchaResult.solved
            ? 'passed'
            : captchaResult.type
              ? 'failed'
              : 'none',
        error: null,
      };
    } catch (err) {
      this.logger.error('Scrape failed', { url, error: err.message });
      return {
        url,
        status: null,
        cache_hit: false,
        cache_layer: null,
        markdown: null,
        word_count: 0,
        output_file: null,
        nav_ms: navMs,
        render_ms: renderMs,
        extract_ms: extractMs,
        total_ms: Date.now() - start,
        scrolls,
        captcha: false,
        error: err.message,
      };
    } finally {
      if (page) await page.close().catch(() => {});
      await this.pool.releaseContext(context);
    }
  }

  async run(opts = {}) {
    const urls = Array.isArray(opts.urls) ? opts.urls : [opts.url].filter(Boolean);
    const run = this.reporter.createRun({ cliArgs: opts.cliArgs ?? [] });
    const concurrency = opts.concurrency ?? this.config.scraper.concurrency ?? 3;

    const queue = [...urls];
    const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
      while (queue.length) {
        const url = queue.shift();
        const result = await this.scrapeUrl(url, opts);
        this.reporter.addPage(run, result);
        if (result.error) run.errors.push({ url, message: result.error });
      }
    });

    await Promise.all(workers);
    this.reporter.finalize(run);

    if (opts.report) {
      const formats = opts.reportFormat ?? 'both';
      this.reporter.write(run, formats === 'both' ? ['json', 'html'] : [formats]);
    }

    return run;
  }

  async close() {
    if (this.pool) await this.pool.close();
    this.cache.close();
  }
}

module.exports = { ScraperEngine, BrowserPool };
