#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const { loadConfig, resolvePath } = require('../shared/config');
const CacheManager = require('../cache');
const Reporter = require('../core/reporter');
const { runScrape } = require('./runScrape');
const { paint, c, table } = require('./ui');

const program = new Command();

function readUrlFile(filePath) {
  return fs
    .readFileSync(path.resolve(filePath), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function resolveUrls(urlArgs, filePath, linksOption) {
  const urls = [...urlArgs];
  if (filePath) urls.push(...readUrlFile(filePath));
  if (linksOption) {
    urls.push(
      ...linksOption
        .split(/[,;\n]+/)
        .map((l) => l.trim())
        .filter(Boolean),
    );
  }
  return [...new Set(urls)];
}

function buildScrapeOptions(options, urls, config) {
  const multi = urls.length > 1;
  const batchMax = config?.scraper?.batchMax ?? 5;
  const defaultConcurrency = multi
    ? Math.min(batchMax, urls.length)
    : config?.scraper?.concurrency ?? 1;

  return {
    output: options.output,
    outputMode: options.llm ? 'llm' : options.full ? 'full' : undefined,
    outputFormat: options.format,
    format: options.format,
    timeout: options.timeout,
    waitFor: options.wait,
    scroll: options.scroll,
    captcha: options.noCaptcha ? false : options.captcha !== false,
    headless: options.headless,
    fast: !options.noFast,
    bypassLogin: options.bypassLogin,
    concurrency: options.concurrency ?? defaultConcurrency,
    cache: options.cache,
    browserOnly: options.browserOnly,
    directOnly: options.directOnly,
    publicFirst: options.publicFirst,
    llmStrict: options.llmStrict,
    proxy: options.proxy,
    report: options.report ?? multi,
    reportFormat: options.reportFormat,
    stdout: options.stdout && urls.length === 1,
    includeImages: options.images !== false,
  };
}

function attachScrapeOptions(cmd) {
  return cmd
    .option('-o, --output <dir>', 'Output directory')
    .option('-f, --format <fmt>', 'Output format: md|json', 'md')
    .option('--stdout', 'Print result to stdout (single URL only)')
    .option('--full', 'Full page mode — nav, footer, sidebar, all links (default)')
    .option('--llm', 'Main content only — strip nav/footer for LLM use')
    .option('--no-llm-strict', 'Disable aggressive LLM cleanup (keep site chrome)')
    .option('-H, --headless', 'Run headless', true)
    .option('-t, --timeout <ms>', 'Navigation timeout', (v) => parseInt(v, 10))
    .option('-w, --wait <strategy>', 'Wait strategy')
    .option('-s, --scroll', 'Infinite scroll to load lazy content', true)
    .option('--no-scroll', 'Disable infinite scroll handler')
    .option('-c, --captcha', 'CAPTCHA solver (reCAPTCHA, hCaptcha, Turnstile)', true)
    .option('--no-captcha', 'Disable CAPTCHA handler')
    .option('--fast', 'Fast low-RAM mode (default)', true)
    .option('--no-fast', 'Disable fast mode (thorough browser path)')
    .option('--no-bypass-login', 'Keep login/sign-up walls (do not dismiss them)')
    .option('-C, --concurrency <n>', 'Parallel workers (batch default: up to 5)', (v) => parseInt(v, 10))
    .option('--links <urls>', 'Comma-separated batch URLs (max 5)')
    .option('--cache', 'Use cache', true)
    .option('--no-cache', 'Bypass cache')
    .option('--browser-only', 'Force browser rendering (skip public HTTP fetch)')
    .option('--direct-only', 'HTTP fetch only (no browser fallback)')
    .option('--no-public-first', 'Skip automatic public HTTP attempt')
    .option('--file <path>', 'Read URLs from file (one per line)')
    .option('--proxy <url>', 'Proxy URL')
    .option('--report', 'Write scrape report')
    .option('--no-report', 'Skip scrape report')
    .option('--report-format <fmt>', 'Report format: json|html|both', 'both')
    .option('--images', 'Extract image URLs from page content', true)
    .option('--no-images', 'Skip extracting image URLs from page content')
    .option('-v, --verbose', 'Verbose logging')
    .option('-q, --quiet', 'Suppress progress UI');
}

async function runScrapeCommand(urlArgs, options) {
  if (options.verbose) process.env.LOG_LEVEL = 'debug';

  const config = loadConfig();
  const batchMax = config.scraper?.batchMax ?? 5;
  const urls = resolveUrls(urlArgs, options.file, options.links);

  if (!urls.length) {
    console.error(paint(c.red, '✗ Provide at least one URL, --links, or --file'));
    process.exit(1);
  }

  if (urls.length > batchMax) {
    console.error(
      paint(c.red, `✗ Batch limit is ${batchMax} URLs (got ${urls.length}). Remove extras or scrape in smaller batches.`),
    );
    process.exit(1);
  }

  const scrapeOpts = buildScrapeOptions(options, urls, config);
  const quiet = options.quiet || scrapeOpts.stdout;

  try {
    const { exitCode } = await runScrape(urls, scrapeOpts, {
      quiet,
      cliArgs: process.argv.slice(2),
    });
    process.exit(exitCode);
  } catch {
    process.exit(2);
  }
}

program
  .name('wikiscraper')
  .description('Convert public web pages to clean LLM-ready markdown (no login required)')
  .version('2.0.0');

const scrapeCmd = attachScrapeOptions(
  program
    .command('scrape')
    .description('Scrape one or more public URLs to clean markdown (batch up to 5)')
    .argument('[urls...]', 'URLs to scrape'),
);

scrapeCmd.action(runScrapeCommand);

// Backward-compatible alias
attachScrapeOptions(
  program
    .command('crawl', { hidden: true })
    .argument('[urls...]', 'URLs to scrape'),
).action(runScrapeCommand);

const cacheCmd = program.command('cache').description('Inspect and manage cache');

cacheCmd
  .command('list')
  .description('List cache entries')
  .action(() => {
    const config = loadConfig();
    const cache = new CacheManager(config.cache);
    const entries = cache.list();
    if (!entries.length) {
      console.log(paint(c.yellow, 'Cache is empty.'));
    } else {
      console.log(paint(c.bold, '\nCACHED URLS\n'));
      console.log(
        table(
          ['HASH', 'URL'],
          entries.slice(0, 50).map((e) => [e.key.slice(0, 10), e.url.slice(0, 60)]),
        ),
      );
      if (entries.length > 50) console.log(paint(c.dim, `\n  … and ${entries.length - 50} more`));
    }
    cache.close();
  });

cacheCmd
  .command('stats')
  .description('Show cache statistics')
  .action(() => {
    const config = loadConfig();
    const cache = new CacheManager(config.cache);
    const s = cache.getStats();
    console.log(paint(c.bold, '\nCACHE STATS\n'));
    console.log(
      table(
        ['LAYER', 'METRIC', 'VALUE'],
        [
          ['memory', 'hits', String(s.hits.memoryHits)],
          ['memory', 'size', `${s.memory.size}/${s.memory.max}`],
          ['sqlite', 'hits', String(s.hits.sqliteHits)],
          ['sqlite', 'entries', String(s.sqlite.entries)],
          ['disk', 'hits', String(s.hits.diskHits)],
          ['disk', 'files', `${s.disk.files} (${s.disk.sizeMB} MB)`],
          ['total', 'misses', String(s.hits.misses)],
        ],
      ),
    );
    cache.close();
  });

cacheCmd
  .command('clear')
  .description('Clear cache layers')
  .option('--url <url>', 'Clear specific URL')
  .option('--layer <layer>', 'memory|sqlite|disk')
  .option('--all', 'Clear all layers')
  .action((options) => {
    const config = loadConfig();
    const cache = new CacheManager(config.cache);
    if (options.url) cache.delete(options.url);
    else cache.clear(options.all ? undefined : options.layer);
    console.log(paint(c.green, '✓ Cache cleared.'));
    cache.close();
  });

program
  .command('export')
  .description('Re-export cached content')
  .requiredOption('--url <url>', 'URL to export')
  .option('--format <fmt>', 'Output format', 'md')
  .action((options) => {
    const config = loadConfig();
    const cache = new CacheManager(config.cache);
    const entry = cache.get(options.url);
    if (!entry?.markdown) {
      console.error(paint(c.red, '✗ No cached markdown for URL'));
      cache.close();
      process.exit(1);
    }
    const outDir = resolvePath(config.output.dir);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'export.md');
    fs.writeFileSync(outFile, entry.markdown);
    console.log(paint(c.green, `✓ Exported to ${outFile}`));
    cache.close();
  });

const reportCmd = program.command('report').description('Generate / view reports');

reportCmd
  .command('list')
  .description('List all reports')
  .action(() => {
    const config = loadConfig();
    const reporter = new Reporter(config.reports);
    const reports = reporter.list();
    if (!reports.length) {
      console.log(paint(c.yellow, 'No reports found.'));
      return;
    }
    console.log(paint(c.bold, '\nREPORTS\n'));
    console.log(
      table(
        ['RUN ID', 'OK/TOTAL'],
        reports.map((r) => [r.id.slice(0, 28), `${r.summary?.success ?? 0}/${r.summary?.total ?? 0}`]),
      ),
    );
  });

reportCmd
  .command('show <id>')
  .description('Show report JSON')
  .action((id) => {
    const config = loadConfig();
    const reporter = new Reporter(config.reports);
    const report = reporter.get(id);
    if (!report) {
      console.error(paint(c.red, '✗ Report not found'));
      process.exit(1);
    }
    console.log(JSON.stringify(report, null, 2));
  });

program.parse();
