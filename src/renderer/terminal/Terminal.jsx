import React, { useEffect, useRef } from 'react';
import { asciiBar } from './constants';

export function TerminalOutput({ lines = [], className = '' }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

  return (
    <pre ref={ref} className={`term-output ${className}`}>
      {lines.map((line, i) => (
        <span key={i} className={`term-line term-${line.type ?? 'info'}`}>
          {line.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

export function TerminalProgress({ label, percent, detail = '' }) {
  return (
    <pre className="term-progress">
      {`${label.padEnd(10)} ${asciiBar(percent)}${detail ? `  ${detail}` : ''}`}
    </pre>
  );
}

export function TerminalPrompt({ prefix = '$', value, onChange, placeholder, disabled, onSubmit }) {
  const handleKey = (e) => {
    if (e.key === 'Enter' && onSubmit) onSubmit();
  };

  return (
    <div className="term-prompt-row">
      <span className="term-prompt-prefix">{prefix}</span>
      <input
        type="text"
        className="term-prompt-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
      />
      {!disabled && <span className="cursor-blink">█</span>}
    </div>
  );
}

export function TerminalToggle({ label, checked, onChange, disabled }) {
  return (
    <button
      type="button"
      className="term-toggle"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
    >
      {`[${checked ? 'X' : ' '}] ${label}`}
    </button>
  );
}

export function TerminalButton({ children, onClick, disabled, variant = 'default' }) {
  return (
    <button
      type="button"
      className={`term-btn term-btn-${variant}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function TerminalHeader({ title, subtitle }) {
  return (
    <pre className="term-header">{`╔══ ${title}${' '.repeat(Math.max(0, 42 - title.length))}══╗
║ ${subtitle.padEnd(44)} ║
╚${'═'.repeat(46)}╝`}</pre>
  );
}

export function TerminalSpinner({ active }) {
  const frames = ['|', '/', '-', '\\'];
  const [frame, setFrame] = React.useState(0);

  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setFrame((f) => (f + 1) % frames.length), 120);
    return () => clearInterval(id);
  }, [active, frames.length]);

  if (!active) return null;
  return <span className="term-spinner"> {frames[frame]} PROCESSING...</span>;
}
