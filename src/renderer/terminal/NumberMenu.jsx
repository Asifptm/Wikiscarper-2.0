import React, { useState, useEffect, useRef } from 'react';

export function NumberMenu({ title, items, activeKey = null }) {
  return (
    <pre className="number-menu">
      {title && <span className="menu-title">{title}{'\n'}</span>}
      {items.map((item) => {
        const isActive = activeKey === item.key;
        return (
          <span key={item.key} className={`menu-row ${isActive ? 'menu-active' : ''}`}>
            {isActive ? '>> ' : '   '}
            <span className="menu-num">{item.key}</span>
            <span className="menu-dot">.</span>
            <span className="menu-label">{item.label}</span>
            {item.state !== undefined && (
              <span className={item.state ? 'state-on' : 'state-off'}>
                {` [${item.state ? 'ON' : 'OFF'}]`}
              </span>
            )}
            {'\n'}
          </span>
        );
      })}
      <span className="menu-hint">{'\n'}TYPE OPTION NUMBER AND PRESS ENTER{'\n'}</span>
    </pre>
  );
}

export function OptionInput({
  label = 'OPTION',
  range,
  value,
  onChange,
  onSubmit,
  disabled = false,
  error = '',
  numericOnly = true,
  autoFocus = true,
}) {
  const inputRef = useRef(null);
  const hint = range ? ` (${range})` : '';

  useEffect(() => {
    if (!autoFocus || disabled || !inputRef.current) return undefined;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [disabled, label, autoFocus]);

  const handleKey = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (disabled || !onSubmit) return;
    onSubmit(String(value).trim());
  };

  const handleChange = (raw) => {
    onChange(numericOnly ? raw.replace(/\D/g, '') : raw);
  };

  return (
    <div className="option-input-block">
      <div
        className="option-input-row"
        onClick={() => !disabled && inputRef.current?.focus()}
        role="presentation"
      >
        <span className="option-label">{label}{hint}&gt;</span>
        <input
          ref={inputRef}
          type="text"
          inputMode={numericOnly ? 'numeric' : 'text'}
          className="option-input"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKey}
          disabled={disabled}
          maxLength={numericOnly ? 3 : 512}
          spellCheck={false}
          autoComplete="off"
          aria-label={label}
        />
        {!disabled && <span className="cursor-blink">█</span>}
      </div>
      {error && <pre className="option-error">{error}</pre>}
    </div>
  );
}

export function TextInput({ label, value, onChange, onSubmit, disabled, placeholder }) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (disabled || !inputRef.current) return undefined;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [disabled, label]);

  const handleKey = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!disabled) onSubmit?.();
  };

  return (
    <div className="option-input-block">
      <div
        className="option-input-row"
        onClick={() => !disabled && inputRef.current?.focus()}
        role="presentation"
      >
        <span className="option-label">{label}&gt;</span>
        <input
          ref={inputRef}
          type="text"
          className="option-input option-input-wide"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-label={label}
        />
        {!disabled && <span className="cursor-blink">█</span>}
      </div>
    </div>
  );
}
