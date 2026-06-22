#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const { ScraperEngine } = require('../core/scraper');
const { loadConfig, resolvePath } = require('../shared/config');
const CacheManager = require('../cache');
const Reporter = require('../core/reporter');

const program = new Command();

program
  .name('electronscraper')
  .description('ElectronScraper Pro CLI — headless web scraping to Markdown')
  .version('2.0.0');

program
  .command('crawl')
  .description('Scrape one or more URLs')
  .argument('<urls...>', 'URLs to scrape')
  .option('-o, --output <dir>', 'Output directory')
  .option('-f, --format <fmt>', 'Output format: md|json|html', 'md')
  .option('-b, --browser <type>', 'Browser engine', 'chromium')
  .option('-H, --headless', 'Run headless', true)
  .option('-t, --timeout <ms>', 'Navigation timeout', (v) => parseInt(v, 10))
  .option('-w, --wait <strategy>', 'Wait strategy')
  .option('-s, --scroll', 'Enable infinite scroll handler')
  .option('-c, --captcha', 'Enable browser-native CAPTCHA solve (iframe click + token wait)')
  .option('--no-bypass-login', 'Keep login/sign-up walls (do not dismiss them)')
  .option('-C, --concurrency <n>', 'Parallel contexts', (v) => parseInt(v, 10))
  .option('--cache', 'Use cache', true)
  .option('--no-cache', 'Bypass cache')
  .option('--direct', 'Use built-in HTTP fetch instead of Playwright')
  .option('--proxy <url>', 'Proxy URL')
  .option('--report', 'Write scrape report')
  .option('--report-format <fmt>', 'Report format: json|html|both', 'both')
  .option('-v, --verbose', 'Verbose logging')
  .option('-q, --quiet', 'Suppress output')
  .action(async (urls, options) => {
    const engine = new ScraperEngine();
    if (options.verbose) process.env.LOG_LEVEL = 'debug';

    try {
      const run = await engine.run({
        urls,
        output: options.output,
        timeout: options.timeout,
        waitFor: options.wait,
        scroll: options.scroll,
        captcha: options.captcha,
        bypassLogin: options.bypassLogin,
        concurrency: options.concurrency,
        cache: options.cache,
        direct: options.direct,
        proxy: options.proxy,
        report: options.report,
        reportFormat: options.reportFormat,
        cliArgs: process.argv.slice(2),
      });

      if (!options.quiet) {
        for (const page of run.pages) {
          if (page.error) console.error(`FAIL ${page.url}: ${page.error}`);
          else console.log(`OK   ${page.url} -> ${page.output_file}`);
        }
        console.log(`Done: ${run.summary.success}/${run.summary.total} succeeded`);
      }

      const exitCode = run.summary.failed > 0 ? 1 : 0;
      await engine.close();
      process.exit(exitCode);
    } catch (err) {
      console.error('Fatal:', err.message);
      await engine.close();
      process.exit(2);
    }
  });

program
  .command('batch')
  .description('Process a URL list file')
  .requiredOption('-f, --file <path>', 'Path to urls.txt')
  .option('-C, --concurrency <n>', 'Parallel workers', (v) => parseInt(v, 10))
  .option('-o, --output <dir>', 'Output directory')
  .option('--report', 'Write scrape report')
  .option('-s, --scroll', 'Enable scroll handler')
  .action(async (options) => {
    const filePath = path.resolve(options.file);
    const lines = fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const engine = new ScraperEngine();
    const run = await engine.run({
      urls: lines,
      output: options.output,
      concurrency: options.concurrency,
      scroll: options.scroll,
      report: options.report,
      cliArgs: process.argv.slice(2),
    });

    console.log(`Batch complete: ${run.summary.success}/${run.summary.total}`);
    await engine.close();
    process.exit(run.summary.failed > 0 ? 1 : 0);
  });

const cacheCmd = program.command('cache').description('Inspect and manage cache');

cacheCmd
  .command('list')
  .description('List cache entries')
  .action(() => {
    const config = loadConfig();
    const cache = new CacheManager(config.cache);
    const entries = cache.list();
    if (!entries.length) console.log('Cache is empty.');
    else entries.forEach((e) => console.log(`${e.key.slice(0, 12)}… ${e.url}`));
    cache.close();
  });

cacheCmd
  .command('stats')
  .description('Show cache statistics')
  .action(() => {
    const config = loadConfig();
    const cache = new CacheManager(config.cache);
    console.log(JSON.stringify(cache.getStats(), null, 2));
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
    console.log('Cache cleared.');
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
      console.error('No cached markdown for URL');
      cache.close();
      process.exit(1);
    }
    const outDir = resolvePath(config.output.dir);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'export.md');
    fs.writeFileSync(outFile, entry.markdown);
    console.log(`Exported to ${outFile}`);
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
    reports.forEach((r) => console.log(`${r.id}  success=${r.summary?.success ?? 0}/${r.summary?.total ?? 0}`));
  });

reportCmd
  .command('show <id>')
  .description('Show report JSON')
  .action((id) => {
    const config = loadConfig();
    const reporter = new Reporter(config.reports);
    const report = reporter.get(id);
    if (!report) {
      console.error('Report not found');
      process.exit(1);
    }
    console.log(JSON.stringify(report, null, 2));
  });

program.parse();
