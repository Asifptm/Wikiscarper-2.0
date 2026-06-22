const fs = require('fs');
const path = require('path');
const { resolvePath } = require('../shared/config');

class Reporter {
  constructor(config = {}) {
    this.dir = resolvePath(config.dir ?? './reports');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _runId() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `run_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  createRun(meta = {}) {
    return {
      id: this._runId(),
      started_at: new Date().toISOString(),
      ended_at: null,
      duration_ms: 0,
      cli_args: meta.cliArgs ?? [],
      config_hash: meta.configHash ?? null,
      pages: [],
      errors: [],
      summary: { total: 0, success: 0, failed: 0, cache_hits: 0, captcha_solved: 0 },
      environment: {
        node_version: process.version,
        electron_version: process.versions.electron ?? null,
        playwright_version: null,
        platform: process.platform,
        arch: process.arch,
      },
    };
  }

  addPage(run, pageResult) {
    run.pages.push(pageResult);
    run.summary.total += 1;
    if (pageResult.error) run.summary.failed += 1;
    else run.summary.success += 1;
    if (pageResult.cache_hit) run.summary.cache_hits += 1;
    if (pageResult.captcha) run.summary.captcha_solved += 1;
  }

  finalize(run) {
    run.ended_at = new Date().toISOString();
    run.duration_ms = new Date(run.ended_at) - new Date(run.started_at);
    return run;
  }

  write(run, formats = ['json', 'html']) {
    const outputs = [];

    if (formats.includes('json') || formats.includes('both')) {
      const jsonPath = path.join(this.dir, `${run.id}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(run, null, 2));
      outputs.push(jsonPath);
    }

    if (formats.includes('html') || formats.includes('both')) {
      const htmlPath = path.join(this.dir, `${run.id}.html`);
      fs.writeFileSync(htmlPath, this._toHtml(run));
      outputs.push(htmlPath);
    }

    return outputs;
  }

  list() {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = path.join(this.dir, f);
        const data = JSON.parse(fs.readFileSync(full, 'utf8'));
        return {
          id: data.id ?? f.replace('.json', ''),
          started_at: data.started_at,
          summary: data.summary,
          path: full,
        };
      })
      .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  }

  get(id) {
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  _toHtml(run) {
    const rows = run.pages
      .map(
        (p) => `<tr>
          <td><a href="${p.url}">${p.url}</a></td>
          <td>${p.status ?? '—'}</td>
          <td>${p.cache_hit ? 'Yes' : 'No'}</td>
          <td>${p.word_count ?? 0}</td>
          <td>${p.total_ms ?? 0}ms</td>
          <td>${p.error ? `<span class="err">${p.error}</span>` : 'OK'}</td>
        </tr>`
      )
      .join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Scrape Report ${run.id}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background: #0f172a; color: #e2e8f0; }
  h1 { color: #38bdf8; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { border: 1px solid #334155; padding: 0.5rem; text-align: left; }
  th { background: #1e293b; }
  .stats { display: flex; gap: 1rem; flex-wrap: wrap; }
  .stat { background: #1e293b; padding: 1rem; border-radius: 8px; min-width: 120px; }
  .err { color: #f87171; }
</style></head><body>
  <h1>Scrape Report</h1>
  <p>Run ID: <strong>${run.id}</strong> | Duration: ${run.duration_ms}ms</p>
  <div class="stats">
    <div class="stat"><div>Total</div><strong>${run.summary.total}</strong></div>
    <div class="stat"><div>Success</div><strong>${run.summary.success}</strong></div>
    <div class="stat"><div>Failed</div><strong>${run.summary.failed}</strong></div>
    <div class="stat"><div>Cache Hits</div><strong>${run.summary.cache_hits}</strong></div>
  </div>
  <table>
    <thead><tr><th>URL</th><th>Status</th><th>Cache</th><th>Words</th><th>Time</th><th>Result</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body></html>`;
  }
}

module.exports = Reporter;
