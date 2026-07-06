const { ScraperEngine } = require('../core/scraper');
const { ScrapeTerminalUI } = require('./ui');

const { buildScrapeResponse } = require('../core/llmOutput');

async function runScrape(urls, opts, cliOptions = {}) {
  const engine = new ScraperEngine();
  const quiet = cliOptions.quiet || opts.stdout;
  const ui = new ScrapeTerminalUI(urls, { quiet });

  if (!quiet) {
    ui.printBanner();
    ui.printStartupConfig(opts);
  }

  engine.setProgressCallback((data) => ui.handleProgress(data));

  try {
    const run = await engine.run({ ...opts, urls, cliArgs: cliOptions.cliArgs ?? [] });
    if (!quiet) {
      ui.finish(run);
    }

    if (opts.stdout && run.pages?.length) {
      const page = run.pages.find((p) => p.url === urls[0]) ?? run.pages[0];
      const fmt = opts.outputFormat ?? opts.format ?? 'md';
      if (fmt === 'json') {
        process.stdout.write(`${JSON.stringify(buildScrapeResponse(page), null, 2)}\n`);
      } else {
        const text = page.markdown ?? '';
        process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
      }
    }

    await engine.close();
    return { run, exitCode: run.summary.failed > 0 ? 1 : 0 };
  } catch (err) {
    if (!quiet) {
      const { paint, c } = require('./ui');
      console.error(paint(c.red, `\n✗ Fatal: ${err.message}\n`));
    }
    await engine.close();
    throw err;
  }
}

module.exports = { runScrape };
