/**
 * Aggressive post-processing for LLM/RAG pipelines.
 * Strips site chrome, resolves links, and removes broken structures.
 */

const WIKI_BOILERPLATE = [
  /^From Wikipedia, the free encyclopedia$/i,
  /^\[\[?edit\]?\]/i,
  /^\[edit\]\([^)]*action=edit/i,
  /^\]\(\/wiki\/File:/,
  /^!\[Edit this on Wikidata\]/i,
  /^!\[Wikimedia Commons logo\]/i,
  /^!\[Wikibooks logo\]/i,
  /^!\[Wikiquote-logo/i,
  /^-\s*\[\s*$/,
  /^\]\(\/wiki\/File:/,
  /^!\[Image\]\(\/\/upload\.wikimedia[^)]+\)\s*$/,
  /^move to sidebar hide$/i,
  /^Toggle .+ subsection$/i,
  /^## Contents$/,
  /^Categoryvte/i,
  /^\[System properties\]/i,
  /^\[Material properties\]/i,
  /^Equations Carnot/i,
  /^HistoryCulture$/i,
  /^Scientists /i,
  /^Other Nucleation/i,
  /^[\wα-ωΑ-Ω]+\s*=\s*[−\-+]?\s*$/,
  /^\[Potentials\]/i,
  /^Thermal expansion$/i,
  /^Maxwell relations/i,
  /^- \[Free /i,
  /^- \[Property databases\]/i,
  /^- \[Maxwell relations\]/i,
  /^- \[Onsager/i,
  /^- \[Bridgman/i,
  /^- \*Table of thermodynamic/i,
  /^"Perpetual motion"/i,
  /^Philosophy$/,
  /^Entropy and time/i,
  /^Theories$/,
  /^Caloric theory$/i,
  /^Vis viva/i,
  /^Key publications/i,
  /^Timelines$/,
  /^ArtEducation/i,
  /^Loading chart\.\.\.$/i,
  /^CPM: USD per 1000/i,
  /^Benchmark comparison/i,
  /^HumanMachine$/,
  /^Run$/,
  /^TAB$/,
  /^ModeBasic$/,
  /^from$/,
  /^ScanDaily$/,
  /^Fetch$/,
  /^SthenP$/,
  /^DthenP$/,
  /^FthenP$/,
  /^MthenP$/,
  /^TthenP$/,
  /^L$/,
  /^P$/,
  /^A$/,
  /^B$/,
  /^C$/,
  /^ID$/,
  /^Entities$/,
  /^!\[Company Logo\]/i,
  /^\[\\?\[.*\\?\]\]\(/,
  /^\*\*\\?\*\\?\*/,
];

const TAIL_START = [
  /^Retrieved from "/i,
  /^\[Categories\]/i,
  /^Categories:/i,
  /^Hidden categories:/i,
  /^## Categories$/i,
  /^## Hidden categories$/i,
];

function stripLinkTitle(href) {
  let url = href.trim();
  const quoted = url.match(/^(\S+)\s+"[^"]*"$/);
  if (quoted) url = quoted[1];
  return url;
}

function resolveMarkdownUrl(href, baseUrl) {
  let url = stripLinkTitle(href);
  if (!url || url.startsWith('javascript:')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/') && baseUrl) {
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return url;
    }
  }
  return url;
}

function isNoiseLink(href, label) {
  const url = stripLinkTitle(href);
  if (url.includes('action=edit') || url.includes('index.php?title=')) return true;
  if (url.startsWith('#cite_')) return true;
  if (/^edit$/i.test(label.replace(/[\[\]]/g, ''))) return true;
  return false;
}

function resolveMarkdownLinks(text, baseUrl) {
  return text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, label, href) => {
    if (isNoiseLink(href, label)) return label.replace(/^\[|\]$/g, '') || '';
    const resolved = resolveMarkdownUrl(href, baseUrl);
    if (resolved.startsWith('#')) return label;
    return `[${label}](${resolved})`;
  });
}

function stripFootnotes(text) {
  return text
    .replace(/\[\[\d+\]\]\(#cite[^)]*\)/g, '')
    .replace(/\[\d+\]\(#cite[^)]*\)/g, '')
    .replace(/\[_?\d+_?\]\(#cite[^)]*\)/g, '')
    .replace(/\[[a-z]\]\(#cite[^)]*\)/gi, '');
}

function isBrokenTable(block) {
  const rows = block.split('\n').filter((l) => l.trim().startsWith('|'));
  if (rows.length < 2) return true;

  const pipeRows = rows.filter((r) => {
    const inner = r.replace(/\|/g, '').replace(/[-:\s]/g, '');
    return inner.length > 0;
  });

  if (pipeRows.length < 2) return true;

  const hasSeparator = pipeRows.some((r) => /^\|[\s\-:|]+\|$/.test(r.trim()));
  if (hasSeparator && pipeRows.length >= 3) return false;

  let sparse = 0;
  for (const row of pipeRows) {
    const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length <= 1 || cells.every((c) => c.length < 2)) sparse += 1;
  }

  return sparse / pipeRows.length >= 0.6;
}

function removeBrokenLeadingTables(text) {
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#') || t.startsWith('>')) {
      i += 1;
      continue;
    }
    break;
  }

  if (i >= lines.length || !lines[i].trim().startsWith('|')) return text;

  let end = i;
  while (end < lines.length && (lines[end].trim().startsWith('|') || !lines[end].trim())) {
    end += 1;
  }

  const tableBlock = lines.slice(i, end).join('\n');
  if (!isBrokenTable(tableBlock)) return text;

  const kept = [...lines.slice(0, i), ...lines.slice(end)];
  return kept.join('\n').replace(/^\n+/, '');
}

function cleanHeading(line) {
  return line.replace(/^((#{1,6})\s+)(.+?)(\s+-\s+Wikipedia)\s*$/i, '$1$3');
}

function isBoilerplateLine(line) {
  const t = line.trim();
  if (!t) return false;
  return WIKI_BOILERPLATE.some((re) => re.test(t));
}

function isTailStart(line) {
  const t = line.trim();
  return TAIL_START.some((re) => re.test(t));
}

function isLogoOnlyLine(line) {
  const t = line.trim();
  if (/^!\[[^\]]*(logo|icon)[^\]]*\]\(/i.test(t)) return true;
  if (/^!\[Image\]\(\/\/upload\.wikimedia/i.test(t)) return true;
  return false;
}

function fixNextJsLinkNoise(text) {
  return text
    .replace(/\[\\?\[([^\]]+)\\?\]\(([^)]+)\)\]\([^)]+\)/g, '[$1]($2)')
    .replace(/([A-Z])\\?\[\\?\[([^\]]+)\\?\]\(([^)]+)\)\\?\]/g, '[$2]($3)')
    .replace(/\*\*\\?\*\\?\*([^*]+)\\?\*\\?\*\\?\*\\?\*/g, '**$1**')
    .replace(/\[([^\]\n]+)\n+\]\(([^)]+)\)/g, '[$1]($2)')
    .replace(/(\[([^\]]+)\]\([^)]+\))\1+/g, '$1')
    .replace(/(\[[^\]]+\]\([^)]+\))(\s*\1)+/g, '$1');
}

function stripLatexNoise(text) {
  return text
    .replace(/\{\s*\\displaystyle[\s\S]*?\}/g, '')
    .replace(/\*\s*\n\n\{\s*\\displaystyle[\s\S]*?\}/g, '*')
    .replace(/\n\s*[ΔΑ-Ωα-ωA-Za-z]+\s*\n\n\{\s*\\displaystyle[\s\S]*?\}/g, '');
}

function stripOrphanEdit(text) {
  return text
    .replace(/^edit\s+(?=[A-Z*\[])/gm, '')
    .replace(/\nedit\s+(?=[A-Z*\[])/g, '\n');
}

function fixWikiLeadMarkup(text) {
  return text
    .replace(/Categoryvte\s+/gi, '')
    .replace(/\b([A-Z][A-Za-z0-9 (),.-]{2,60})\*\* is /g, '**$1** is ');
}

function trimWikiPreamble(text) {
  text = fixWikiLeadMarkup(text);

  const headerMatch = text.match(/^((?:#[^\n]+\n)?(?:\n> Source:[^\n]+\n)?)/);
  const header = headerMatch ? headerMatch[1] : '';
  const body = text.slice(header.length).trimStart();
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (/\*\*[^*]{2,}\*\* is (?:a|an|the) /.test(t)) {
      return header + lines.slice(i).join('\n');
    }
    if (/^[A-Z][A-Za-z0-9 (),.-]{2,}\*\* is (?:a|an|the) /.test(t)) {
      const fixed = fixWikiLeadMarkup(t);
      return header + fixed + '\n' + lines.slice(i + 1).join('\n');
    }
    if (/^## [A-Za-z]/.test(t)) {
      return header + lines.slice(i).join('\n');
    }
  }

  return text;
}

function normalizeTitle(text) {
  return text.replace(/^#\s+(.+?)\s+-\s+Wikipedia\s*$/im, '# $1');
}

function injectSourceBlock(text, url) {
  if (!url || text.includes('> Source:')) return text;
  const titleMatch = text.match(/^#\s+(.+)$/m);
  if (!titleMatch) return text;
  const title = titleMatch[1].trim();
  return text.replace(/^#\s+.+$/m, `# ${title}\n\n> Source: ${url}`);
}

function applyLlmStrict(markdown, options = {}) {
  if (!markdown?.trim()) return markdown;

  let text = stripFootnotes(markdown);
  text = fixWikiLeadMarkup(text);
  text = fixNextJsLinkNoise(text);
  text = resolveMarkdownLinks(text, options.url);
  text = stripLatexNoise(text);

  const lines = text.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = cleanHeading(lines[i]);
    const t = line.trim();

    if (isTailStart(line)) break;
    if (isBoilerplateLine(line)) continue;
    if (isLogoOnlyLine(line)) continue;

    // Broken image + orphan file link pair
    if (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(t) && i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      if (/^\]\(\/wiki\/File:/.test(next)) {
        const img = t.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
        if (img && img[1] && img[1] !== 'Image') {
          out.push(`![${img[1]}](${resolveMarkdownUrl(img[2], options.url)})`);
        }
        i += 1;
        continue;
      }
    }

    if (/^\|\s*\|?\s*$/.test(t)) continue;
    if (/^#{1,6}\s*$/.test(t)) continue;

    line = stripFootnotes(line);
    line = line.replace(/\s{2,}/g, ' ').trim();

    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }

    out.push(line);
  }

  text = out.join('\n');
  text = stripOrphanEdit(text);
  text = trimWikiPreamble(text);
  text = removeBrokenLeadingTables(text);
  text = normalizeTitle(text);
  text = injectSourceBlock(text, options.url);
  text = text.replace(/\*{3,}([^*\n]+)\*\*/g, '**$1**');
  text = text.replace(/(> Source:[^\n]+)\n(?!\n)/, '$1\n\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text ? `${text}\n` : '_No content extracted._\n';
}

module.exports = { applyLlmStrict, resolveMarkdownUrl, stripFootnotes, isBrokenTable };
