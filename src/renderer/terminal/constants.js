export const APP_NAME = 'ELECTRONSCRAPER PRO';
export const APP_VERSION = '2.0.0';
export const APP_TAGLINE = 'Web Scraping to Markdown';

export function asciiBar(percent, width = 28) {
  const filled = Math.round((percent / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${String(percent).padStart(3)}%`;
}

export function timestamp() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

export function termTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length))
  );
  const line = (cells) =>
    `│ ${cells.map((c, i) => String(c).padEnd(widths[i])).join(' │ ')} │`;
  const sep = `├${widths.map((w) => '─'.repeat(w + 2)).join('┼')}┤`;
  const top = `┌${widths.map((w) => '─'.repeat(w + 2)).join('┬')}┐`;
  const bottom = `└${widths.map((w) => '─'.repeat(w + 2)).join('┴')}┘`;
  return [top, line(headers), sep, ...rows.map(line), bottom].join('\n');
}

export function renderMenu(title, items, activeKey = null) {
  const lines = [
    `╔══ ${title} ${'═'.repeat(Math.max(0, 40 - title.length))}╗`,
    ...items.map((item) => {
      const marker = activeKey === item.key ? '>>' : '  ';
      const state = item.state ? `  [${item.state}]` : '';
      return `║ ${marker} ${item.key.padStart(1)}. ${item.label.padEnd(28)}${state.padEnd(8)} ║`;
    }),
    `╚${'═'.repeat(46)}╝`,
    '',
    '  TYPE OPTION NUMBER AND PRESS ENTER',
  ];
  return lines.join('\n');
}
