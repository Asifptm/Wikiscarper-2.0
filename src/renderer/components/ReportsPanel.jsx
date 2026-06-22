import React, { useState, useEffect, useCallback } from 'react';
import { NumberMenu, OptionInput } from '../terminal/NumberMenu';
import { TerminalOutput, TerminalProgress } from '../terminal/Terminal';
import { timestamp, termTable } from '../terminal/constants';

export default function ReportsPanel({ onBack }) {
  const [reports, setReports] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState([]);
  const [option, setOption] = useState('');
  const [error, setError] = useState('');
  const [viewMode, setViewMode] = useState(false);

  const pushLine = (text, type = 'info') =>
    setLines((prev) => [...prev, { text: `[${timestamp()}] ${text}`, type }]);

  const refresh = useCallback(async () => {
    setLoading(true);
    pushLine('scanning reports...', 'dim');
    try {
      const list = await window.scraperAPI.reportList();
      setReports(list);
      pushLine(`found ${list.length} report(s).`, 'success');
    } catch (err) {
      pushLine(`ERR :: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const menuItems = [
    { key: '1', label: 'LIST ALL REPORTS' },
    { key: '2', label: 'VIEW REPORT BY NUMBER' },
    { key: '3', label: 'REFRESH LIST' },
    { key: '0', label: 'BACK TO MAIN MENU' },
  ];

  const listReports = () => {
    if (!reports.length) {
      setSelected({ list: '(no reports found — run scrape with report ON)' });
      return;
    }
    const rows = reports.map((r, i) => [
      String(i + 1),
      r.id.slice(0, 22),
      `${r.summary?.success ?? 0}/${r.summary?.total ?? 0}`,
    ]);
    setSelected({ list: termTable(['#', 'RUN ID', 'OK/TOT'], rows) });
    pushLine('report index displayed.', 'success');
  };

  const viewReport = async (num) => {
    const idx = parseInt(num, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= reports.length) {
      setError(`INVALID REPORT # — enter 1-${reports.length}`);
      return;
    }
    const report = await window.scraperAPI.reportGet(reports[idx].id);
    const pageRows = (report.pages ?? []).map((p) => [
      String(p.status ?? 'ERR'),
      String(p.word_count ?? 0),
      p.url.slice(0, 36),
    ]);
    setSelected({
      header: `RUN: ${report.id} | ${report.summary.success}/${report.summary.total} OK`,
      list: termTable(['STAT', 'WORDS', 'URL'], pageRows),
    });
    pushLine(`report #${num} loaded.`, 'success');
    setViewMode(false);
  };

  const handleOption = async (val) => {
    setError('');
    setOption('');

    if (viewMode) {
      await viewReport(val);
      setOption('');
      return;
    }

    pushLine(`option entered: ${val}`, 'dim');

    switch (val) {
      case '0':
        onBack();
        break;
      case '1':
        listReports();
        break;
      case '2':
        if (!reports.length) {
          setError('NO REPORTS — use option 3 to refresh');
        } else {
          setViewMode(true);
          pushLine(`enter report number 1-${reports.length}`, 'dim');
        }
        break;
      case '3':
        setSelected(null);
        refresh();
        break;
      default:
        setError('INVALID — enter 0, 1, 2, or 3');
    }
  };

  return (
    <div className="term-panel">
      <NumberMenu title="=== REPORTS MENU ===" items={menuItems} />

      <div className="term-input-dock">
        {viewMode ? (
          <OptionInput
            label="ENTER REPORT #"
            range={`1-${reports.length}`}
            value={option}
            onChange={setOption}
            onSubmit={handleOption}
            disabled={loading}
            error={error}
          />
        ) : (
          <OptionInput
            label="ENTER OPTION"
            range="0-3"
            value={option}
            onChange={setOption}
            onSubmit={handleOption}
            disabled={loading}
            error={error}
          />
        )}
      </div>

      {loading && <TerminalProgress label="LOADING" percent={40} detail="indexing..." />}

      {selected && (
        <div className="term-section">
          {selected.header && <pre className="term-status-green">{selected.header}</pre>}
          <pre className="term-block">{selected.list}</pre>
        </div>
      )}

      <div className="term-log-section">
        <pre className="term-label-green">OUTPUT LOG:</pre>
        <TerminalOutput lines={lines} />
      </div>
    </div>
  );
}
