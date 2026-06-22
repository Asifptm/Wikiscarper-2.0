import React, { useState, useEffect } from 'react';
import { NumberMenu, OptionInput, TextInput } from '../terminal/NumberMenu';
import { TerminalOutput, TerminalProgress, TerminalSpinner } from '../terminal/Terminal';
import { timestamp, termTable } from '../terminal/constants';

const SCRAPE_MENU = (opts) => [
  { key: '1', label: 'SET TARGET URL + SCRAPE', state: opts.url ? 'ON' : 'OFF' },
  { key: '2', label: 'SET BATCH URLS + SCRAPE', state: opts.batch ? 'ON' : 'OFF' },
  { key: '0', label: 'BACK TO MAIN MENU' },
];

export default function ScrapePanel({ onBack }) {
  const [url, setUrl] = useState('');
  const [urls, setUrls] = useState('');
  const [useBatch, setUseBatch] = useState(false);
  const [scroll] = useState(true);
  const [captcha] = useState(true);
  const [useCache] = useState(true);
  const [report] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [lines, setLines] = useState([]);
  const [lastRun, setLastRun] = useState(null);
  const [option, setOption] = useState('');
  const [error, setError] = useState('');
  const [inputMode, setInputMode] = useState(null);
  const [progressDetail, setProgressDetail] = useState('scraping...');
  const [captchaStatus, setCaptchaStatus] = useState(null);

  const pushLine = (text, type = 'info') =>
    setLines((prev) => [...prev, { text: `[${timestamp()}] ${text}`, type }]);

  const handleCaptchaProgress = (data) => {
    const { status } = data;

    if (status === 'captcha-start') {
      setCaptchaStatus({ phase: 'active', label: 'CAPTCHA HANDLER ACTIVE' });
      setProgressDetail('captcha: starting...');
      pushLine('CAPTCHA :: handler started', 'info');
      if (data.headed) {
        pushLine('CAPTCHA :: visible browser opened — complete challenge if prompted', 'info');
      }
      return;
    }

    if (status === 'captcha-progress') {
      switch (data.step) {
        case 'scanning':
          setCaptchaStatus({ phase: 'scanning', label: 'SCANNING FOR CAPTCHA...' });
          setProgressDetail('captcha: scanning page');
          pushLine('CAPTCHA :: scanning page', 'dim');
          break;
        case 'detected':
          setCaptchaStatus({ phase: 'detected', label: `CAPTCHA DETECTED :: ${data.type}` });
          setProgressDetail(`captcha: ${data.type} detected`);
          pushLine(`CAPTCHA :: detected (${data.type})`, 'info');
          break;
        case 'clicking':
          setCaptchaStatus({ phase: 'clicking', label: `CLICKING WIDGET :: ${data.type}` });
          setProgressDetail('captcha: clicking widget');
          pushLine(`CAPTCHA :: clicking ${data.type} widget`, 'info');
          break;
        case 'clicked':
          setProgressDetail('captcha: widget clicked');
          pushLine('CAPTCHA :: widget clicked — waiting for token', 'dim');
          break;
        case 'click-failed':
          setProgressDetail('captcha: click failed — waiting for token');
          pushLine(`CAPTCHA :: click failed — ${data.error}`, 'error');
          break;
        case 'manual-wait':
          setCaptchaStatus({ phase: 'waiting', label: 'MANUAL SOLVE — complete CAPTCHA in browser' });
          setProgressDetail('captcha: waiting for manual solve');
          pushLine(`CAPTCHA :: manual mode — solve in browser (${Math.round(data.timeout / 1000)}s)`, 'info');
          break;
        case 'waiting':
          setCaptchaStatus({
            phase: 'waiting',
            label: `WAITING FOR TOKEN :: ${data.percent ?? 0}%`,
          });
          setProgressDetail(`captcha: token wait ${data.percent ?? 0}%`);
          setProgress((p) => Math.max(p, Math.min(85, 40 + (data.percent ?? 0) * 0.4)));
          break;
        case 'passed':
          setCaptchaStatus({ phase: 'passed', label: `CAPTCHA PASSED :: ${data.type}` });
          setProgressDetail('captcha: passed');
          pushLine(`CAPTCHA :: passed (${data.type})`, 'success');
          break;
        case 'failed':
          setCaptchaStatus({ phase: 'failed', label: 'CAPTCHA FAILED' });
          setProgressDetail('captcha: failed — continuing scrape');
          pushLine(`CAPTCHA :: failed — ${data.error}`, 'error');
          break;
        case 'error':
          setCaptchaStatus({ phase: 'failed', label: 'CAPTCHA ERROR' });
          setProgressDetail('captcha: error');
          pushLine(`CAPTCHA :: error — ${data.error}`, 'error');
          break;
        case 'none':
          setCaptchaStatus({ phase: 'none', label: 'NO CAPTCHA ON PAGE' });
          setProgressDetail('captcha: none found');
          pushLine('CAPTCHA :: none detected on page', 'dim');
          break;
        default:
          break;
      }
      return;
    }

    if (status === 'captcha-solved') {
      setCaptchaStatus({ phase: 'passed', label: `CAPTCHA PASSED :: ${data.type}` });
      setProgressDetail('captcha: passed');
      pushLine(`CAPTCHA :: solve complete (${data.type}, ${data.mode ?? 'auto'})`, 'success');
      return;
    }

    if (status === 'captcha-failed') {
      setCaptchaStatus({ phase: 'failed', label: `CAPTCHA NOT PASSED :: ${data.type}` });
      setProgressDetail('captcha failed — scrape continues');
      pushLine(`CAPTCHA :: not passed (${data.type}) — ${data.error}`, 'error');
      return;
    }

    if (status === 'captcha-error') {
      setCaptchaStatus({ phase: 'failed', label: 'CAPTCHA HANDLER ERROR' });
      pushLine(`CAPTCHA :: handler error — ${data.error}`, 'error');
      return;
    }

    if (status === 'captcha-none') {
      setCaptchaStatus({ phase: 'none', label: 'NO CAPTCHA ON PAGE' });
      pushLine('CAPTCHA :: none on page — continuing', 'dim');
    }
  };
  useEffect(() => {
    pushLine('scrape module ready. enter option number.', 'dim');
    const unsub = window.scraperAPI?.onProgress((data) => {
      if (data.status === 'cache-hit') {
        pushLine(`CACHE HIT (${data.layer}) :: ${data.url}`, 'success');
        setProgress(100);
        setProgressDetail('cache hit');
      } else if (data.status === 'login-wall-dismissed') {
        pushLine(`LOGIN WALL DISMISSED (${data.count}) :: ${data.url}`, 'success');
        setProgressDetail('login wall dismissed');
      } else if (data.status === 'fallback-direct') {
        pushLine(`BROWSER UNAVAILABLE — fallback to direct fetch`, 'dim');
        setProgressDetail('fallback: direct fetch');
      } else if (
        data.status === 'captcha-start'
        || data.status === 'captcha-progress'
        || data.status === 'captcha-solved'
        || data.status === 'captcha-failed'
        || data.status === 'captcha-error'
        || data.status === 'captcha-none'
      ) {
        handleCaptchaProgress(data);
      } else if (data.status === 'done') {
        pushLine(`DONE :: ${data.url}`, 'success');
        if (data.outputFile) pushLine(`  -> ${data.outputFile}`, 'dim');
        setProgress(100);
        setProgressDetail('complete');
        setCaptchaStatus(null);
      }
    });
    return () => unsub?.();
  }, []);

  const handleRun = async (overrideUrls) => {
    const targetUrls = overrideUrls ?? (useBatch
      ? urls.split('\n').map((u) => u.trim()).filter(Boolean)
      : [url.trim()].filter(Boolean));

    if (!targetUrls.length) {
      setError('NO URL ENTERED — type a valid link');
      pushLine('ERR: no valid URL provided', 'error');
      return;
    }

    setRunning(true);
    setProgress(5);
    setProgressDetail('scraping...');
    setCaptchaStatus(null);
    setError('');
    setLines([]);
    pushLine(`initiating scrape :: ${targetUrls.length} target(s)`, 'info');

    const progressTimer = setInterval(() => {
      setProgress((p) => (p >= 90 ? p : p + 2));
    }, 400);

    try {
      const result = await window.scraperAPI.run({
        urls: targetUrls,
        scroll,
        captcha,
        cache: useCache,
        report,
        reportFormat: 'both',
      });

      clearInterval(progressTimer);
      setProgress(100);

      if (result.success) {
        setLastRun(result.run);
        pushLine(`COMPLETE :: ${result.run.summary.success}/${result.run.summary.total} OK`, 'success');
        const rows = result.run.pages.map((p) => [
          p.status ?? 'ERR',
          (p.captcha_status ?? '-').toUpperCase(),
          String(p.word_count ?? 0),
          `${p.total_ms ?? 0}ms`,
          p.url.slice(0, 36),
        ]);
        pushLine(termTable(['STAT', 'CAPTCHA', 'WORDS', 'TIME', 'URL'], rows), 'table');
        for (const p of result.run.pages) {
          if (p.captcha_error) {
            pushLine(`CAPTCHA ERR :: ${p.url} — ${p.captcha_error}`, 'error');
          }
          if (p.error) pushLine(`ERR :: ${p.url} — ${p.error}`, 'error');
        }
      } else {
        setError(result.error || 'SCRAPE FAILED');
        pushLine(`FATAL :: ${result.error}`, 'error');
      }
    } catch (err) {
      clearInterval(progressTimer);
      setError(err.message || 'UNKNOWN ERROR');
      pushLine(`FATAL :: ${err.message}`, 'error');
    } finally {
      clearInterval(progressTimer);
      setRunning(false);
      setInputMode(null);
      setOption('');
      setProgressDetail('idle');
    }
  };

  const handleOption = (val) => {
    if (running) {
      setError('SCRAPE IN PROGRESS — wait for completion');
      return;
    }
    setError('');
    setOption('');
    pushLine(`option entered: ${val}`, 'dim');

    switch (val) {
      case '0':
        onBack();
        break;
      case '1':
        setUseBatch(false);
        setInputMode('url');
        break;
      case '2':
        setUseBatch(true);
        setInputMode('batch');
        break;
      default:
        setError(`INVALID — enter 0-2`);
    }
  };

  const menuItems = SCRAPE_MENU({
    url: !useBatch && url,
    batch: useBatch && urls.trim(),
  });

  return (
    <div className="term-panel">
      <NumberMenu title="=== SCRAPE MENU ===" items={menuItems} />

      <div className="term-input-dock">
        {inputMode === 'batch' && (
          <div className="term-section">
            <pre className="term-label-red">ENTER BATCH URLS (one per line, then type 9 to scrape):</pre>
            <textarea
              className="term-textarea"
              rows={5}
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              disabled={running}
              spellCheck={false}
            />
          </div>
        )}

        {inputMode === 'url' && (
          <TextInput
            label="ENTER URL TO SCRAPE"
            value={url}
            onChange={setUrl}
            onSubmit={() => {
              const u = url.trim();
              setInputMode(null);
              if (!u) {
                setError('NO URL ENTERED — type a valid link');
                pushLine('ERR: no valid URL provided', 'error');
                return;
              }
              pushLine(`url set: ${u}`, 'success');
              handleRun([u]);
            }}
            disabled={running}
            placeholder="https://example.com"
          />
        )}

        {inputMode === 'batch' && (
          <OptionInput
            label="TYPE 9 TO START BATCH SCRAPE"
            range="9"
            value={option}
            onChange={setOption}
            onSubmit={(v) => {
              if (v === '9') {
                setInputMode(null);
                setOption('');
                const list = urls.split('\n').map((u) => u.trim()).filter(Boolean);
                if (!list.length) {
                  setError('NO URLS ENTERED — type at least one link');
                  pushLine('ERR: no valid URL provided', 'error');
                  return;
                }
                pushLine(`batch set: ${list.length} urls`, 'success');
                handleRun(list);
              } else {
                setError('TYPE 9 TO START BATCH SCRAPE');
              }
            }}
            disabled={running}
            error={error}
          />
        )}

        {!inputMode && (
          <OptionInput
            label="ENTER OPTION"
            range="0-2"
            value={option}
            onChange={setOption}
            onSubmit={handleOption}
            disabled={running}
            error={error}
          />
        )}
      </div>

      {running && (
        <>
          {captchaStatus && (
            <pre className={`term-captcha-status term-captcha-${captchaStatus.phase}`}>
              {`CAPTCHA :: ${captchaStatus.label}`}
            </pre>
          )}
          <TerminalProgress label="PROGRESS" percent={progress} detail={progressDetail} />
          <TerminalSpinner active />
        </>
      )}

      {!running && captchaStatus && (
        <pre className={`term-captcha-status term-captcha-${captchaStatus.phase}`}>
          {`LAST CAPTCHA :: ${captchaStatus.label}`}
        </pre>
      )}

      {!useBatch && url && (
        <pre className="term-status-green">{`CURRENT URL: ${url}`}</pre>
      )}
      {useBatch && urls.trim() && (
        <pre className="term-status-green">{`BATCH MODE: ${urls.split('\n').filter(Boolean).length} URL(s)`}</pre>
      )}

      {lastRun && !running && (
        <pre className="term-summary">{`
┌─ LAST RUN ──────────────────
│ ID    : ${lastRun.id}
│ OK    : ${lastRun.summary.success}/${lastRun.summary.total}
│ CACHE : ${lastRun.summary.cache_hits} hits
└─────────────────────────────`}</pre>
      )}

      <div className="term-log-section">
        <pre className="term-label-green">OUTPUT LOG:</pre>
        <TerminalOutput lines={lines} />
      </div>
    </div>
  );
}
