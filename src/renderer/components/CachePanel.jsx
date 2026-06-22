import React, { useState, useEffect, useCallback } from 'react';
import { NumberMenu, OptionInput } from '../terminal/NumberMenu';
import { TerminalOutput, TerminalProgress } from '../terminal/Terminal';
import { timestamp, termTable } from '../terminal/constants';

const CACHE_MENU = [
  { key: '1', label: 'VIEW STATISTICS' },
  { key: '2', label: 'VIEW CACHED URLS' },
  { key: '3', label: 'CLEAR MEMORY LAYER' },
  { key: '4', label: 'CLEAR SQLITE LAYER' },
  { key: '5', label: 'CLEAR ALL LAYERS' },
  { key: '6', label: 'REFRESH DATA' },
  { key: '0', label: 'BACK TO MAIN MENU' },
];

export default function CachePanel({ onBack }) {
  const [stats, setStats] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState([]);
  const [option, setOption] = useState('');
  const [error, setError] = useState('');
  const [display, setDisplay] = useState(null);

  const pushLine = (text, type = 'info') =>
    setLines((prev) => [...prev, { text: `[${timestamp()}] ${text}`, type }]);

  const refresh = useCallback(async () => {
    setLoading(true);
    pushLine('fetching cache data...', 'dim');
    try {
      const [s, list] = await Promise.all([
        window.scraperAPI.cacheStats(),
        window.scraperAPI.cacheList(),
      ]);
      setStats(s);
      setEntries(list);
      pushLine('cache data loaded.', 'success');
    } catch (err) {
      pushLine(`ERR :: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const showStats = () => {
    if (!stats) return;
    const text = termTable(
      ['LAYER', 'METRIC', 'VALUE'],
      [
        ['MEMORY', 'hits', String(stats.hits.memoryHits)],
        ['MEMORY', 'size', `${stats.memory.size}/${stats.memory.max}`],
        ['SQLITE', 'hits', String(stats.hits.sqliteHits)],
        ['SQLITE', 'entries', String(stats.sqlite.entries)],
        ['DISK', 'hits', String(stats.hits.diskHits)],
        ['DISK', 'files', `${stats.disk.files} (${stats.disk.sizeMB} MB)`],
        ['TOTAL', 'misses', String(stats.hits.misses)],
      ]
    );
    setDisplay(text);
    pushLine('statistics displayed.', 'success');
  };

  const showEntries = () => {
    if (!entries.length) {
      setDisplay('(empty — no cached URLs)');
      return;
    }
    const rows = entries.slice(0, 25).map((e) => [e.key.slice(0, 8), e.url.slice(0, 48)]);
    setDisplay(termTable(['HASH', 'URL'], rows));
    pushLine(`${entries.length} entries displayed.`, 'success');
  };

  const handleOption = async (val) => {
    setError('');
    setOption('');
    pushLine(`option entered: ${val}`, 'dim');

    switch (val) {
      case '0':
        onBack();
        break;
      case '1':
        showStats();
        break;
      case '2':
        showEntries();
        break;
      case '3':
        pushLine('clearing memory layer...', 'warn');
        await window.scraperAPI.cacheClear({ layer: 'memory' });
        pushLine('memory cleared.', 'success');
        refresh();
        break;
      case '4':
        pushLine('clearing sqlite layer...', 'warn');
        await window.scraperAPI.cacheClear({ layer: 'sqlite' });
        pushLine('sqlite cleared.', 'success');
        refresh();
        break;
      case '5':
        pushLine('clearing ALL layers...', 'warn');
        await window.scraperAPI.cacheClear({ all: true });
        pushLine('all cache cleared.', 'success');
        setDisplay(null);
        refresh();
        break;
      case '6':
        setDisplay(null);
        refresh();
        break;
      default:
        setError('INVALID — enter 0-6');
    }
  };

  return (
    <div className="term-panel">
      <NumberMenu title="=== CACHE MENU ===" items={CACHE_MENU} />

      <div className="term-input-dock">
        <OptionInput
          label="ENTER OPTION"
          range="0-6"
          value={option}
          onChange={setOption}
          onSubmit={handleOption}
          disabled={loading}
          error={error}
        />
      </div>

      {loading && <TerminalProgress label="LOADING" percent={55} detail="reading cache..." />}

      {display && <pre className="term-block">{display}</pre>}

      <div className="term-log-section">
        <pre className="term-label-green">OUTPUT LOG:</pre>
        <TerminalOutput lines={lines} />
      </div>
    </div>
  );
}
