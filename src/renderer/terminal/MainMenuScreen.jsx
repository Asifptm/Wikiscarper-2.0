import React, { useState } from 'react';
import { NumberMenu, OptionInput } from './NumberMenu';

export default function MainMenuScreen({ onSelect }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (val) => {
    const choice = val.trim();
    if (!choice) return;
    setInput('');
    const err = onSelect(choice);
    setError(err || '');
  };

  return (
    <div className="term-panel">
      <NumberMenu
        title="=== MAIN MENU ==="
        items={[
          { key: '1', label: 'SCRAPE MODULE' },
          { key: '2', label: 'CACHE MODULE' },
          { key: '3', label: 'REPORTS MODULE' },
          { key: '0', label: 'EXIT APPLICATION' },
        ]}
      />

      <div className="term-input-dock">
        <OptionInput
          label="ENTER OPTION"
          range="0-3"
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          error={error}
        />
      </div>
    </div>
  );
}
