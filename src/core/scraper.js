const fs = require('fs');
const path = require('path');
const CacheManager = require('../cache');
const { htmlToMarkdown, htmlToMarkdownBuiltin, extractPageContent, resolveTitle, slimHtmlForExtraction, extractHtmlTitle } = require('./extractor');
const { fetchUrl } = require('./httpClient');
const Reporter = require('./reporter');
const createLogger = require('./logger');
const { loadConfig, resolvePath } = require('../shared/config');
const { slugify, isValidUrl } = require('../shared/utils');
const { isRedditUrl, scrapeRedditPublic } = require('./reddit');
const { isInstagramUrl, scrapeInstagramPublic, toInstagramEmbedUrl } = require('./instagram');
const { buildScrapeResponse, extractDescription } = require('./llmOutput');
const { isUsableScrapeResult, isCaptchaWallContent, toPublicUrl } = require('./publicScrape');

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
    const captcha = this._resolveCaptcha(options);
    const headless = this._resolveHeadless(options);
    const launchOpts = {
      headless,
      args: captcha ? CAPTCHA_LAUNCH_ARGS : LOW_RESOURCE_ARGS,
      ignoreDefaultArgs: captcha ? ['--enable-automation'] : undefined,
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
    if (this._resolveCaptcha(options) && this.config.captcha?.headed !== false) {
      return false;
    }
    if (options.headless !== undefined) return options.headless;
    return this.config.scraper.headless ?? true;
  }

  _resolveCaptcha(options) {
    if (options.captcha === false) return false;
    if (options.captcha === true) return true;
    return this.config.captcha?.enabled !== false;
  }

  _resolveBlockResources(options) {
    if (this._resolveCaptcha(options)) {
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

  _resolveOutputOptions(options = {}) {
    const mode = options.outputMode ?? this.config.output?.mode ?? 'llm';
    return {
      outputMode: mode,
      fullPage: options.fullPage ?? (mode === 'full' ? this.config.output.fullPage !== false : false),
      frontMatter:
        options.frontMatter ??
        (mode === 'full' ? this.config.output.frontMatter !== false : this.config.output.frontMatter === true),
      llmStrict:
        options.llmStrict ??
        (mode === 'llm' ? this.config.output.llmStrict !== false : false),
      outputFormat: options.outputFormat ?? options.format ?? 'md',
    };
  }

  _writeScrapeOutput(url, data, options = {}) {
    const outOpts = this._resolveOutputOptions(options);
    const outputDir = resolvePath(options.output ?? this.config.output.dir);
    fs.mkdirSync(outputDir, { recursive: true });
    const base = slugify(url);

    const pageResult = {
      url,
      markdown: data.markdown,
      word_count: data.wordCount ?? 0,
      status: data.status ?? null,
      total_ms: data.totalMs ?? 0,
      cache_hit: data.cacheHit ?? false,
      error: data.error ?? null,
    };

    const meta = {
      title: data.title ?? null,
      description: data.description ?? null,
    };

    if (outOpts.outputFormat === 'json') {
      const payload = buildScrapeResponse(pageResult, meta);
      const outputFile = path.join(outputDir, `${base}.json`);
      fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2));
      return { outputFile, payload, jsonPayload: payload };
    }

    const outputFile = path.join(outputDir, `${base}.md`);
    fs.writeFileSync(outputFile, data.markdown);
    return { outputFile, payload: null, jsonPayload: null };
  }

  _markdownOptions(options = {}, stats = {}) {
    const out = this._resolveOutputOptions(options);
    return {
      outputMode: out.outputMode,
      fullPage: out.fullPage,
      frontMatter: out.frontMatter,
      llmStrict: out.llmStrict,
      stats,
    };
  }

  _resolvePublicOptions(options = {}) {
    return {
      publicFirst:
        options.publicFirst !== false && this.config.scraper?.publicFirst !== false,
      browserOnly: options.browserOnly === true,
      directOnly: options.directOnly === true || options.direct === true,
      bypassLogin:
        options.bypassLogin !== false && this.config.scraper?.bypassLogin !== false,
    };
  }

  _resolveRuntimeOptions(options = {}) {
    const fast = options.fast !== false && this.config.scraper?.fastMode !== false;
    const captcha =
      options.captcha === false ? false : options.captcha === true ? true : this._resolveCaptcha(options);

    return {
      fast,
      scroll: options.scroll !== false && this.config.scraper?.scroll !== false,
      captcha,
      storeHtml: fast ? options.storeHtml === true : options.storeHtml !== false,
      loginWallAttempts: fast ? 1 : 3,
      loginWallDelay: fast ? 400 : 1200,
      skipLazyImages: fast,
      captchaQuickScan: fast && !captcha,
    };
  }

  async _tryDirectFetch(url, options, start) {
    const navStart = Date.now();
    const fetchUrl_public = toPublicUrl(url);
    try {
      const res = await fetchUrl(fetchUrl_public, {
        userAgent: options.userAgent ?? this.config.scraper.userAgent,
        timeout: options.timeout ?? this.config.scraper.timeout ?? 30000,
      });

      const status = res.statusCode ?? 200;
      if (status >= 400) {
        throw new Error(`ERR_NAV_HTTP_${status}: server returned ${status}`);
      }

      const extractStart = Date.now();
      const pageTitle = extractHtmlTitle(res.body);
      const out = this._resolveOutputOptions(options);
      const mdOpts = {
        url,
        title: pageTitle ?? undefined,
        fullHtml: res.body,
        description: extractDescription(res.body),
        mainContent: true,
        fullPage: out.fullPage,
        ...this._markdownOptions(options, {
          status,
          contentType: res.headers['content-type'],
          etag: res.headers.etag,
          durationMs: Date.now() - start,
        }),
      };

      const htmlInput = slimHtmlForExtraction(res.body);

      const { markdown, wordCount, meta } = htmlToMarkdown(htmlInput, mdOpts);

      return {
        markdown,
        wordCount,
        meta,
        status,
        body: options.storeHtml ? res.body : null,
        slimHtml: htmlInput,
        headers: res.headers,
        navMs: Date.now() - navStart,
        extractMs: Date.now() - extractStart,
        method: 'direct',
      };
    } catch (err) {
      return { error: err.message, navMs: Date.now() - navStart, extractMs: 0 };
    }
  }

  _buildDirectResult(url, data, options, start, useCache) {
    const { outputFile } = this._writeScrapeOutput(
      url,
      {
        markdown: data.markdown,
        wordCount: data.wordCount,
        status: data.status,
        totalMs: Date.now() - start,
        title: data.meta?.title ?? resolveTitle(data.body ?? data.slimHtml ?? '', url),
        description: extractDescription(data.body ?? data.slimHtml ?? ''),
      },
      options,
    );

    if (useCache) {
      this.cache.set(url, {
        html: data.body,
        markdown: data.markdown,
        wordCount: data.wordCount,
        status: data.status,
        headers: data.headers,
        etag: data.headers?.etag,
        outputFile,
      });
    }

    return {
      url,
      status: data.status,
      cache_hit: false,
      cache_layer: null,
      markdown: data.markdown,
      word_count: data.wordCount,
      output_file: outputFile,
      method: data.method ?? 'direct',
      nav_ms: data.navMs,
      render_ms: 0,
      extract_ms: data.extractMs,
      total_ms: Date.now() - start,
      scrolls: 0,
      captcha: false,
      error: null,
    };
  }

  async scrapeUrl(url, options = {}) {
    const runtime = this._resolveRuntimeOptions(options);
    options = { ...options, ...runtime };

    if (!isValidUrl(url)) {
      throw new Error(`ERR_NAV_INVALID: Invalid URL — ${url}`);
    }

    const useCache = options.cache !== false;
    const start = Date.now();

    if (useCache) {
      const cached = this.cache.get(url);
      if (cached?.markdown) {
        this._emitProgress({ url, status: 'cache-hit', layer: cached.cacheLayer });
        const { outputFile } = this._writeScrapeOutput(
          url,
          {
            markdown: cached.markdown,
            wordCount: cached.wordCount,
            status: cached.status ?? 200,
            totalMs: Date.now() - start,
            cacheHit: true,
          },
          options,
        );
        return {
          url,
          status: cached.status ?? 200,
          cache_hit: true,
          cache_layer: cached.cacheLayer,
          markdown: cached.markdown,
          word_count: cached.wordCount ?? 0,
          output_file: outputFile,
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

    // Site-specific public endpoints (Reddit, Instagram) — automatic, no CLI flags.
    if (isRedditUrl(url) && this.config.reddit?.enabled !== false) {
      this._emitProgress({ url, status: 'started', method: 'reddit-public' });
      return this.scrapeReddit(url, options, start, useCache);
    }

    if (isInstagramUrl(url) && this.config.instagram?.enabled !== false) {
      this._emitProgress({ url, status: 'started', method: 'instagram-public' });
      return this.scrapeInstagram(url, options, start, useCache);
    }

    const pub = this._resolvePublicOptions(options);

    // Direct-only mode: HTTP fetch, no browser fallback.
    if (pub.directOnly) {
      this._emitProgress({ url, status: 'started', method: 'direct' });
      return this.scrapeDirect(url, options, start, useCache);
    }

    // Browser-only mode: skip public HTTP attempt.
    if (pub.browserOnly) {
      this._emitProgress({ url, status: 'started', method: 'browser' });
      return this.scrapeWithBrowser(url, options, start, useCache);
    }

    // Global public-first: try direct HTTP (no login), then browser with login-wall dismissal.
    if (pub.publicFirst) {
      this._emitProgress({ url, status: 'started', method: 'public-first' });
      const attempt = await this._tryDirectFetch(url, options, start);
      if (!attempt.error) {
        const preview = {
          markdown: attempt.markdown,
          word_count: attempt.wordCount,
          error: null,
        };
        if (isUsableScrapeResult(preview)) {
          this._emitProgress({ url, status: 'done', method: 'direct' });
          return this._buildDirectResult(url, attempt, options, start, useCache);
        }
        this._emitProgress({
          url,
          status: 'fallback-browser',
          reason: isCaptchaWallContent(preview.markdown)
            ? 'captcha wall'
            : 'login wall or thin content',
        });
      } else {
        this._emitProgress({ url, status: 'fallback-browser', error: attempt.error });
      }
    }

    this._emitProgress({ url, status: 'started', method: 'browser' });
    return this.scrapeWithBrowser(
      url,
      { ...options, bypassLogin: pub.bypassLogin },
      start,
      useCache,
    );
  }

  async scrapeReddit(url, options, start, useCache) {
    this._emitProgress({ url, status: 'navigating' });
    try {
      const extractStart = Date.now();
      const out = this._resolveOutputOptions(options);
      const result = await scrapeRedditPublic(url, {
        userAgent: options.userAgent ?? this.config.scraper.userAgent ?? undefined,
        timeout: options.timeout ?? this.config.scraper.timeout ?? 30000,
        frontMatter: out.frontMatter,
      });

      const extractMs = Date.now() - extractStart;
      const { outputFile } = this._writeScrapeOutput(
        url,
        {
          markdown: result.markdown,
          wordCount: result.wordCount,
          status: result.status,
          totalMs: Date.now() - start,
          title: result.meta?.title ?? null,
        },
        options,
      );

      if (useCache) {
        this.cache.set(url, {
          html: null,
          markdown: result.markdown,
          wordCount: result.wordCount,
          status: result.status,
          headers: {},
          outputFile,
        });
      }

      this._emitProgress({ url, status: 'done', outputFile, method: 'reddit' });

      return {
        url,
        status: result.status,
        cache_hit: false,
        cache_layer: null,
        markdown: result.markdown,
        word_count: result.wordCount,
        output_file: outputFile,
        method: 'reddit-public',
        nav_ms: result.navMs,
        render_ms: 0,
        extract_ms: extractMs,
        total_ms: Date.now() - start,
        scrolls: 0,
        captcha: false,
        captcha_status: 'skipped',
        error: null,
      };
    } catch (err) {
      this.logger.warn('Reddit public scrape failed, falling back to browser', {
        url,
        error: err.message,
      });
      this._emitProgress({ url, status: 'fallback-reddit', error: err.message });
      return this.scrapeRedditWithBrowser(url, options, start, useCache);
    }
  }

  async scrapeRedditWithBrowser(url, options, start, useCache) {
    const { toOldRedditUrl } = require('./reddit');
    const oldUrl = toOldRedditUrl(url);
    return this.scrapeWithBrowser(oldUrl, { ...options, reddit: false }, start, useCache);
  }

  async scrapeInstagram(url, options, start, useCache) {
    this._emitProgress({ url, status: 'navigating' });
    try {
      const extractStart = Date.now();
      const out = this._resolveOutputOptions(options);
      const result = await scrapeInstagramPublic(url, {
        userAgent: options.userAgent ?? this.config.scraper.userAgent ?? undefined,
        timeout: options.timeout ?? this.config.scraper.timeout ?? 30000,
        frontMatter: out.frontMatter,
      });

      const extractMs = Date.now() - extractStart;
      const { outputFile } = this._writeScrapeOutput(
        url,
        {
          markdown: result.markdown,
          wordCount: result.wordCount,
          status: result.status,
          totalMs: Date.now() - start,
          title: result.meta?.title ?? null,
          description: result.meta?.description ?? null,
        },
        options,
      );

      if (useCache) {
        this.cache.set(url, {
          html: null,
          markdown: result.markdown,
          wordCount: result.wordCount,
          status: result.status,
          headers: {},
          outputFile,
        });
      }

      this._emitProgress({ url, status: 'done', outputFile, method: 'instagram' });

      return {
        url,
        status: result.status,
        cache_hit: false,
        cache_layer: null,
        markdown: result.markdown,
        word_count: result.wordCount,
        output_file: outputFile,
        method: result.method,
        nav_ms: result.navMs,
        render_ms: 0,
        extract_ms: extractMs,
        total_ms: Date.now() - start,
        scrolls: 0,
        captcha: false,
        captcha_status: 'skipped',
        error: null,
      };
    } catch (err) {
      this.logger.warn('Instagram public scrape failed, falling back to embed browser', {
        url,
        error: err.message,
      });
      this._emitProgress({ url, status: 'fallback-instagram', error: err.message });
      return this.scrapeInstagramWithBrowser(url, options, start, useCache);
    }
  }

  async scrapeInstagramWithBrowser(url, options, start, useCache) {
    const embedUrl = toInstagramEmbedUrl(url);
    return this.scrapeWithBrowser(embedUrl, { ...options, instagram: false }, start, useCache);
  }

  async scrapeDirect(url, options, start, useCache) {
    this._emitProgress({ url, status: 'navigating' });
    const attempt = await this._tryDirectFetch(url, options, start);
    if (attempt.error) {
      this.logger.error('Direct scrape failed', { url, error: attempt.error });
      this._emitProgress({ url, status: 'failed', error: attempt.error });
      return {
        url,
        status: null,
        cache_hit: false,
        cache_layer: null,
        markdown: null,
        word_count: 0,
        output_file: null,
        method: 'direct',
        nav_ms: attempt.navMs,
        render_ms: 0,
        extract_ms: attempt.extractMs,
        total_ms: Date.now() - start,
        scrolls: 0,
        captcha: false,
        error: attempt.error,
      };
    }

    this._emitProgress({ url, status: 'done', method: 'direct' });
    return this._buildDirectResult(url, attempt, options, start, useCache);
  }

  async scrapeWithBrowser(url, options, start, useCache) {
    const { handleInfiniteScroll, handleLazyImages, waitForDynamicContent } = require('./dynamic');
    const { solve_captcha } = require('./captcha');
    const { dismissLoginWall } = require('./loginWall');

    options = { ...options, captcha: this._resolveCaptcha(options) };
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

      this._emitProgress({ url, status: 'navigating' });

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

      if (options.captcha) {
        this._emitProgress({ url, status: 'captcha-start', headed: !this._resolveHeadless(options) });
        captchaResult = await solve_captcha(page, {
          ...this.config.captcha,
          quickScan: options.captchaQuickScan,
        }, (data) => {
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

      if (options.scroll) {
        scrolls = await handleInfiniteScroll(page, { ...options, fast: options.fast });
      }

      if (!options.skipLazyImages) {
        await handleLazyImages(page);
      }

      if (!options.fast && options.bypassLogin !== false) {
        await dismissLoginWall(page, { ...options, loginWallAttempts: 1 }).catch(() => 0);
      }

      renderMs = Date.now() - renderStart;
      const extractStart = Date.now();

      const out = this._resolveOutputOptions(options);
      const pageContent = await extractPageContent(page, { llmMode: out.outputMode === 'llm' });
      const fullHtml = await page.content();
      const status = response?.status() ?? 200;
      const headers = response?.headers() ?? {};

      const { markdown, wordCount, meta } = htmlToMarkdown(pageContent.bodyHtml, {
        url,
        fullHtml,
        description: extractDescription(fullHtml),
        mainContent: out.outputMode === 'llm',
        navLinks: pageContent.navLinks,
        headerLinks: pageContent.headerLinks,
        footerLinks: pageContent.footerLinks,
        asideLinks: pageContent.asideLinks,
        breadcrumbLinks: pageContent.breadcrumbLinks,
        ...this._markdownOptions(options, {
          status,
          contentType: headers['content-type'],
          etag: headers.etag,
          durationMs: Date.now() - start,
          scrolls,
          captcha: captchaResult.solved,
        }),
      });

      extractMs = Date.now() - extractStart;

      const { outputFile } = this._writeScrapeOutput(
        url,
        {
          markdown,
          wordCount,
          status,
          totalMs: Date.now() - start,
          title: meta?.title ?? resolveTitle(fullHtml, url),
          description: extractDescription(fullHtml),
        },
        options,
      );

      if (useCache) {
        this.cache.set(url, {
          html: options.storeHtml ? fullHtml : null,
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
      this._emitProgress({ url, status: 'failed', error: err.message });
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
    const concurrency = opts.concurrency ?? this.config.scraper.concurrency ?? 5;

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
