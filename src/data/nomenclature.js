// Nomenclature decode dictionary.
// Deliberately decoupled from app logic (per spec §4.3): update these rules
// without touching any screen code. Every decode is an ESTIMATE and is
// labeled as such in the UI — the engineer confirms before it's saved.

const TON_FROM_MBH = (code) => {
  const n = parseInt(code, 10);
  if (!n) return null;
  const tons = n / 12;
  return `${Number.isInteger(tons) ? tons : tons.toFixed(1)} Tons (${n},000 BTU/h)`;
};

export const BRANDS = [
  {
    name: 'Carrier',
    detect: /carrier/i,
    model: {
      // e.g. 48TCED12 / 38AUZA036 — capacity digits are the trailing 2-3 digit group
      capacity: (m) => {
        const g = m.match(/(?:^|[A-Z])(\d{2,3})(?:[A-Z-]|$)/);
        return g ? TON_FROM_MBH(g[1]) : null;
      },
    },
    serialYear: (s) => {
      // Common Carrier format: WWYY prefix (week + 2-digit year), e.g. 3214X...
      const g = s.match(/^(\d{2})(\d{2})/);
      if (!g) return null;
      const wk = parseInt(g[1], 10), yy = parseInt(g[2], 10);
      if (wk < 1 || wk > 53) return null;
      return { year: yy > 50 ? 1900 + yy : 2000 + yy, note: `week ${wk}` };
    },
  },
  {
    name: 'Trane',
    detect: /trane|american standard/i,
    model: {
      capacity: (m) => {
        const g = m.match(/(?:^|[A-Z])(\d{3})(?:[A-Z]|$)/);
        return g ? TON_FROM_MBH(g[1]) : null;
      },
    },
    serialYear: (s) => {
      // Post-2002 Trane: leading 1-2 digits = year within decade context,
      // or letter-coded older units. Keep to the modern numeric rule.
      const g = s.match(/^(\d{2})/);
      if (!g) return null;
      const yy = parseInt(g[1], 10);
      if (yy < 2 || yy > 39) return null;
      return { year: 2000 + yy, note: 'modern serial format' };
    },
  },
  {
    name: 'York',
    detect: /\byork\b|johnson controls/i,
    model: {
      capacity: (m) => {
        const g = m.match(/(\d{3})/);
        return g ? TON_FROM_MBH(g[1]) : null;
      },
    },
    serialYear: (s) => {
      // York letter-pair style (e.g. W1L...) varies by era — too ambiguous
      // to auto-decode reliably; surface digits if a 4-digit year appears.
      const g = s.match(/(19|20)\d{2}/);
      return g ? { year: parseInt(g[0], 10), note: 'year string found in serial' } : null;
    },
  },
  {
    name: 'Daikin',
    detect: /daikin|mcquay/i,
    model: { capacity: (m) => { const g = m.match(/(\d{3})/); return g ? TON_FROM_MBH(g[1]) : null; } },
    serialYear: (s) => {
      const g = s.match(/^(\d{2})/);
      if (!g) return null;
      const yy = parseInt(g[1], 10);
      if (yy < 5 || yy > 39) return null;
      return { year: 2000 + yy, note: 'estimate' };
    },
  },
  {
    name: 'Lennox',
    detect: /lennox/i,
    model: { capacity: (m) => { const g = m.match(/-(\d{2,3})/); return g ? TON_FROM_MBH(g[1]) : null; } },
    serialYear: (s) => {
      const g = s.match(/^(\d{2})(\d{2})/);
      if (!g) return null;
      const yy = parseInt(g[1], 10);
      return { year: yy > 50 ? 1900 + yy : 2000 + yy, note: 'estimate' };
    },
  },
  {
    name: 'Square D',
    detect: /square\s*d|schneider/i,
    model: { capacity: (m) => { const g = m.match(/(\d{2,4})\s*A/i); return g ? `${g[1]}A rating` : null; } },
    serialYear: () => null,
  },
  {
    name: 'Eaton',
    detect: /eaton|cutler[\s-]*hammer/i,
    model: { capacity: (m) => { const g = m.match(/(\d{2,4})\s*A/i); return g ? `${g[1]}A rating` : null; } },
    serialYear: () => null,
  },
  {
    name: 'Siemens',
    detect: /siemens|\bite\b/i,
    model: { capacity: (m) => { const g = m.match(/(\d{2,4})\s*A/i); return g ? `${g[1]}A rating` : null; } },
    serialYear: () => null,
  },
];

// Generic field extraction from raw OCR lines.
export function parseNameplateText(rawText) {
  const text = rawText || '';
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  const out = { make: '', model: '', serial: '', capacity: '', year: '', decodeNotes: [] };

  // Brand
  const brand = BRANDS.find((b) => b.detect.test(text));
  if (brand) out.make = brand.name;

  // Model / Serial via labeled lines first
  for (const line of lines) {
    const mdl = line.match(/(?:MODEL|MOD|M\/N|MDL)[.:#\s]*([A-Z0-9][A-Z0-9\-\/]{3,})/i);
    if (mdl && !out.model) out.model = mdl[1].toUpperCase();
    const ser = line.match(/(?:SERIAL|SER|S\/N|SN)[.:#\s]*([A-Z0-9][A-Z0-9\-]{3,})/i);
    if (ser && !out.serial) out.serial = ser[1].toUpperCase();
  }

  // Electrical ratings commonly present
  const volts = text.match(/(\d{3})\s*[\/-]\s*(\d{3})?\s*V|(\d{3})\s*V/i);
  const fla = text.match(/(?:FLA|RLA|AMPS?)[.:\s]*(\d{1,4}(?:\.\d)?)/i);
  const elec = [volts ? volts[0].replace(/\s+/g, '') : null, fla ? `${fla[1]}A` : null].filter(Boolean).join(' · ');

  // Brand-specific decodes
  if (brand && out.model) {
    const cap = brand.model.capacity(out.model);
    if (cap) { out.capacity = cap; out.decodeNotes.push(`Capacity decoded from ${brand.name} model digits — verify`); }
  }
  if (!out.capacity && elec) out.capacity = elec;
  else if (elec) out.capacity += ` · ${elec}`;

  if (brand && out.serial) {
    const yr = brand.serialYear(out.serial);
    if (yr) { out.year = String(yr.year); out.decodeNotes.push(`Mfg year decoded from serial (${yr.note}) — verify`); }
  }
  if (!out.year) {
    const y = text.match(/(?:MFG|MANUF|DATE)[^\d]*((?:19|20)\d{2})/i);
    if (y) out.year = y[1];
  }

  return out;
}

// Nominal pipe size lookup: structural OD (inches) -> trade size.
export const PIPE_TABLES = {
  'Steel (Sch 40)': [
    [0.84, '1/2"'], [1.05, '3/4"'], [1.315, '1"'], [1.66, '1-1/4"'], [1.9, '1-1/2"'],
    [2.375, '2"'], [2.875, '2-1/2"'], [3.5, '3"'], [4.5, '4"'], [5.563, '5"'],
    [6.625, '6"'], [8.625, '8"'], [10.75, '10"'], [12.75, '12"'],
  ],
  'Copper (Type L)': [
    [0.625, '1/2"'], [0.875, '3/4"'], [1.125, '1"'], [1.375, '1-1/4"'], [1.625, '1-1/2"'],
    [2.125, '2"'], [2.625, '2-1/2"'], [3.125, '3"'], [4.125, '4"'],
  ],
};

export function nearestNominal(od, table) {
  let best = null, bestErr = Infinity;
  for (const [refOd, label] of PIPE_TABLES[table]) {
    const err = Math.abs(refOd - od);
    if (err < bestErr) { bestErr = err; best = { label, refOd, err }; }
  }
  return best;
}
