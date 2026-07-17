const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

function paint(color, text) {
  return `${color}${text}${c.reset}`;
}

const SPINNER_FRAMES = ['/', '-', '\\', '|'];

function progressBar(percent, width = 24, spinFrame = 0) {
  const pct = Math.max(0, Math.min(100, percent));
  const inner = Math.max(8, width - 2);
  const filled = Math.round((pct / 100) * inner);
  const empty = inner - filled;

  if (pct >= 100) {
    return `[${'='.repeat(inner)}]`;
  }

  const spin = SPINNER_FRAMES[spinFrame % SPINNER_FRAMES.length];
  return `[${'='.repeat(filled)}${' '.repeat(empty)}] ${spin}`;
}

function truncate(str, max = 52) {
  const s = String(str ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function visibleLen(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padVisible(str, width) {
  const s = String(str);
  return s + ' '.repeat(Math.max(0, width - visibleLen(s)));
}

function table(headers, rows) {
  if (!rows.length) return paint(c.dim, '  (no rows)');

  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => visibleLen(r[i] ?? ''))),
  );

  const border = (left, join, right) =>
    `  ${left}${widths.map((w) => '─'.repeat(w + 2)).join(join)}${right}`;

  const row = (cells, paintCell = (_, v) => v) =>
    `  │${cells
      .map((cell, i) => {
        const text = paintCell(i, String(cell ?? ''));
        return ` ${padVisible(text, widths[i])} `;
      })
      .join('│')}│`;

  const lines = [
    paint(c.cyan, border('┌', '┬', '┐')),
    row(headers, (_, v) => paint(c.bold, v)),
    paint(c.cyan, border('├', '┼', '┤')),
    ...rows.flatMap((r, idx) => {
      const line = row(r);
      if (idx < rows.length - 1) {
        return [line, paint(c.dim, border('├', '┼', '┤'))];
      }
      return [line];
    }),
    paint(c.cyan, border('└', '┴', '┘')),
  ];

  return lines.join('\n');
}

function keyValueTable(pairs) {
  return table(
    ['FIELD', 'VALUE'],
    pairs.map(([k, v]) => [k, v]),
  );
}

class ScrapeTerminalUI {
  constructor(urls, options = {}) {
    this.urls = urls;
    this.total = urls.length;
    this.completed = 0;
    this.quiet = options.quiet ?? false;
    this.currentUrl = null;
    this.currentPhase = 'starting';
    this.currentPercent = 0;
    this.statusActive = false;
    this.spinFrame = 0;
  }

  printBanner() {
    if (this.quiet) return;
    console.log('');
    console.log(paint(c.cyan, '╔══════════════════════════════════════════════════════════════╗'));
    console.log(
      paint(c.cyan, '║') +
        paint(c.bold, '  WIKISCRAPER') +
        paint(c.dim, '  headless scrape session') +
        ' '.repeat(18) +
        paint(c.cyan, '║'),
    );
    console.log(
      paint(c.cyan, '║') +
        paint(c.dim, `  targets: ${this.total}`) +
        ' '.repeat(Math.max(1, 48 - String(this.total).length)) +
        paint(c.cyan, '║'),
    );
    console.log(paint(c.cyan, '╚══════════════════════════════════════════════════════════════╝'));
    console.log('');
  }

  printStartupConfig(opts) {
    if (this.quiet) return;
    const flags = [
      ['engine', opts.direct ? 'direct HTTP' : 'playwright'],
      ['scroll', opts.scroll ? 'on' : 'off'],
      ['cache', opts.cache !== false ? 'on' : 'off'],
      ['captcha', opts.captcha ? 'on' : 'off'],
      ['images', opts.includeImages !== false ? 'on' : 'off'],
      ['report', opts.report ? 'on' : 'off'],
      ['concurrency', String(opts.concurrency ?? 5)],
    ];
    console.log(paint(c.bold, 'CONFIG'));
    console.log(table(['OPTION', 'VALUE'], flags));
    console.log('');
    console.log(paint(c.bold, 'TARGET URLS'));
    this.urls.forEach((url, i) => {
      console.log(paint(c.dim, `  ${String(i + 1).padStart(2, '0')}.`) + ' ' + url);
    });
    console.log('');
    this.updateProgress();
  }

  clearStatusLine() {
    if (this.statusActive) {
      process.stdout.write('\x1b[2K\r');
      this.statusActive = false;
    }
  }

  overallPercent() {
    if (this.completed >= this.total) return 100;
    const base = (this.completed / this.total) * 100;
    const currentSlice = this.currentPercent / this.total;
    return Math.min(99, Math.round(base + currentSlice));
  }

  updateProgress() {
    if (this.quiet) return;
    const pct = this.overallPercent();
    const label = truncate(this.currentUrl ?? '—', 34);
    const bar = progressBar(pct, 24, this.spinFrame);
    this.spinFrame += 1;
    const line =
      paint(c.dim, 'PROGRESS ') +
      bar +
      paint(c.dim, ` ${String(pct).padStart(3)}%`) +
      paint(c.dim, `  ${this.completed}/${this.total}`) +
      paint(c.dim, `  ${label}`) +
      paint(c.dim, ` · ${this.currentPhase}`);
    process.stdout.write(`\x1b[2K\r${line}`);
    this.statusActive = true;
  }

  setPhase(url, phase, percent) {
    this.currentUrl = url;
    this.currentPhase = phase;
    this.currentPercent = percent;
    this.updateProgress();
  }

  handleProgress(data) {
    const { url, status } = data;

    switch (status) {
      case 'started':
        this.setPhase(url, 'initializing', 5);
        break;
      case 'navigating':
        this.setPhase(url, 'loading', 25);
        break;
      case 'cache-hit':
        this.completed += 1;
        this.setPhase(url, 'cache hit', 100);
        break;
      case 'fallback-direct':
        this.setPhase(url, 'direct fetch', 40);
        break;
      case 'fallback-browser':
        this.setPhase(url, 'browser fallback', 35);
        break;
      case 'fallback-reddit':
        this.setPhase(url, 'reddit fallback', 30);
        break;
      case 'fallback-instagram':
        this.setPhase(url, 'instagram fallback', 30);
        break;
      case 'fallback-x':
        this.setPhase(url, 'x fallback', 30);
        break;
      case 'login-wall-dismissed':
        this.setPhase(url, 'login wall', 35);
        break;
      case 'captcha-start':
        this.setPhase(url, 'captcha', 45);
        break;
      case 'captcha-progress':
        this.handleCaptchaProgress(url, data);
        break;
      case 'captcha-solved':
        this.setPhase(url, 'captcha passed', 75);
        break;
      case 'captcha-failed':
        this.setPhase(url, 'captcha failed', 70);
        break;
      case 'captcha-none':
        this.setPhase(url, 'extracting', 60);
        break;
      case 'failed':
        this.completed += 1;
        this.setPhase(url, 'failed', 100);
        break;
      case 'done':
        this.completed += 1;
        this.setPhase(url, 'done', 100);
        break;
      default:
        break;
    }
  }

  handleCaptchaProgress(url, data) {
    const step = data.step;
    const labels = {
      scanning: ['scanning captcha', 48],
      detected: [`captcha: ${data.type}`, 50],
      clicking: [`clicking ${data.type}`, 55],
      clicked: ['waiting token', 58],
      'click-failed': ['click failed', 58],
      'manual-wait': ['manual solve', 60],
      waiting: [`token ${data.percent ?? 0}%`, 55 + Math.round((data.percent ?? 0) * 0.2)],
      passed: ['captcha passed', 75],
      failed: ['captcha failed', 70],
      error: ['captcha error', 65],
      none: ['extracting', 52],
    };
    const [phase, pct] = labels[step] ?? ['captcha', 50];
    this.setPhase(url, phase, pct);
  }

  finish(run) {
    if (this.quiet) return;
    this.clearStatusLine();
    console.log('');

    const summaryRows = [
      ['Total URLs', String(run.summary.total)],
      ['Succeeded', paint(c.green, String(run.summary.success))],
      [
        'Failed',
        run.summary.failed > 0
          ? paint(c.red, String(run.summary.failed))
          : paint(c.dim, '0'),
      ],
      ['Cache hits', String(run.summary.cache_hits ?? 0)],
      ['CAPTCHA solved', String(run.summary.captcha_solved ?? 0)],
    ];
    if (run.id) summaryRows.push(['Run ID', run.id]);

    console.log(paint(c.bold, 'SUMMARY'));
    console.log(keyValueTable(summaryRows));
    console.log('');

    const rows = run.pages.map((p, i) => [
      String(i + 1),
      p.error ? paint(c.red, 'FAIL') : paint(c.green, ' OK '),
      String(p.status ?? '—'),
      (p.captcha_status ?? '—').toUpperCase(),
      String(p.word_count ?? 0),
      `${p.total_ms ?? 0}ms`,
      truncate(p.url, 36),
      p.output_file ? truncate(p.output_file, 30) : paint(c.dim, '—'),
      p.error ? paint(c.red, truncate(p.error, 28)) : paint(c.dim, '—'),
    ]);

    console.log(paint(c.bold, 'RESULTS'));
    console.log(
      table(
        ['#', 'STAT', 'HTTP', 'CAPTCHA', 'WORDS', 'TIME', 'URL', 'OUTPUT', 'ERROR'],
        rows,
      ),
    );

    console.log('');
    if (run.summary.failed === 0) {
      console.log(
        paint(c.green, `✓ Scrape complete — ${run.summary.success}/${run.summary.total} succeeded`),
      );
    } else {
      console.log(
        paint(
          c.yellow,
          `⚠ Scrape complete — ${run.summary.success}/${run.summary.total} succeeded, ${run.summary.failed} failed`,
        ),
      );
    }
    console.log('');
  }
}

module.exports = { ScrapeTerminalUI, table, keyValueTable, progressBar, paint, c };
