import React, { useEffect } from 'react';
import { APP_NAME, APP_VERSION } from './constants';

const SPLASH_MS = 1000;

const LOGO_FULL = `
 ███████╗██╗     ███████╗ ██████╗████████╗██████╗  ██████╗ ███╗   ██╗
 ██╔════╝██║     ██╔════╝██╔════╝╚══██╔══╝██╔══██╗██╔═══██╗████╗  ██║
 █████╗  ██║     █████╗  ██║        ██║   ██████╔╝██║   ██║██╔██╗ ██║
 ██╔══╝  ██║     ██╔══╝  ██║        ██║   ██╔══██╗██║   ██║██║╚██╗██║
 ███████╗███████╗███████╗╚██████╗   ██║   ██║  ██║╚██████╔╝██║ ╚████║
 ╚══════╝╚══════╝╚══════╝ ╚═════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝
 ███████╗ ██████╗██████╗  █████╗ ██████╗ ███████╗██████╗
 ██╔════╝██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗
 ███████╗██║     ██████╔╝███████║██████╔╝█████╗  ██████╔╝
 ╚════██║██║     ██╔══██╗██╔══██║██╔═══╝ ██╔══╝  ██╔══██╗
 ███████║╚██████╗██║  ██║██║  ██║██║     ███████╗██║  ██║
 ╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝
                    ██████╗ ██████╗  ██████╗
                    ██╔══██╗██╔══██╗██╔═══██╗
                    ██████╔╝██████╔╝██║   ██║
                    ██╔═══╝ ██╔══██╗██║   ██║
                    ██║     ██║  ██║╚██████╔╝
                    ╚═╝     ╚═╝  ╚═╝ ╚═════╝`;

const LOGO_COMPACT = `
    ╔════════════════════════════════╗
    ║                                ║
    ║     ELECTRONSCRAPER PRO v2     ║
    ║                                ║
    ╚════════════════════════════════╝`;

export default function BootScreen({ onComplete }) {
  useEffect(() => {
    const timer = setTimeout(onComplete, SPLASH_MS);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <div className="boot-screen">
      <div className="boot-inner">
        <div className="boot-logo-wrap">
          <pre className="boot-logo boot-logo-full">{LOGO_FULL}</pre>
          <pre className="boot-logo boot-logo-compact">{LOGO_COMPACT}</pre>
        </div>
        <div className="boot-brand">
          <span className="boot-title">{APP_NAME}</span>
          <span className="boot-version">{APP_VERSION}</span>
        </div>
      </div>
    </div>
  );
}
