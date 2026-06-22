import React, { useState, useEffect } from 'react';
import BootScreen from './terminal/BootScreen';
import MainMenuScreen from './terminal/MainMenuScreen';
import ScrapePanel from './components/ScrapePanel';
import CachePanel from './components/CachePanel';
import ReportsPanel from './components/ReportsPanel';
import { APP_NAME, APP_VERSION } from './terminal/constants';

const APP_LOGO = `
 ███████╗███████╗ ██████╗██████╗  █████╗ ██████╗ ███████╗██████╗
 ██╔════╝██╔════╝██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗
 █████╗  ███████╗██║     ██████╔╝███████║██████╔╝█████╗  ██████╔╝
 ██╔══╝  ╚════██║██║     ██╔══██╗██╔══██║██╔═══╝ ██╔══╝  ██╔══██╗
 ███████╗███████║╚██████╗██║  ██║██║  ██║██║     ███████╗██║  ██║
 ╚══════╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝`;

export default function App() {
  const [booted, setBooted] = useState(false);
  const [view, setView] = useState('main');
  const [config, setConfig] = useState(null);

  useEffect(() => {
    window.scraperAPI?.getConfig().then(setConfig).catch(() => {});
  }, []);

  const goMain = () => setView('main');

  const handleMainSelect = (choice) => {
    switch (choice) {
      case '1':
        setView('scrape');
        break;
      case '2':
        setView('cache');
        break;
      case '3':
        setView('reports');
        break;
      case '0':
        window.scraperAPI?.quit();
        break;
      default:
        return `INVALID OPTION "${choice}" — enter 0, 1, 2, or 3`;
    }
    return '';
  };

  if (!booted) {
    return <BootScreen onComplete={() => setBooted(true)} />;
  }

  return (
    <div className="terminal-app">
      <header className="app-header">
        <pre className="app-logo">{APP_LOGO}</pre>
        <div className="app-version">v{APP_VERSION}</div>
      </header>

      <div className="terminal-body">
        <div className="terminal-main">
          <div className="terminal-content">
            {view === 'main' && <MainMenuScreen onSelect={handleMainSelect} />}
            {view === 'scrape' && <ScrapePanel config={config} onBack={goMain} />}
            {view === 'cache' && <CachePanel onBack={goMain} />}
            {view === 'reports' && <ReportsPanel onBack={goMain} />}
          </div>
        </div>
      </div>
    </div>
  );
}
