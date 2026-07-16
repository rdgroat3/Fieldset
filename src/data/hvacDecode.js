// ─────────────────────────────────────────────────────────────────────────
// DECODE ENGINE  (interpreter over decodeDB.js)
//
// Public API (unchanged names, so existing callers keep working):
//   decodeTonnageFromModel(model, brand?)    -> HVAC nominal tonnage
//   decodeCapacity(model, category, brand?)  -> tonnage (hvac) | gallons (wh)
//   decodeYearFromSerial(serial, brand, cat) -> manufacture date + confidence
//   detectBrand(text, category?)             -> canonical brand name
//   ageFromYear(year)                        -> integer age
//   HVAC_BRANDS                              -> list of hvac brand names
//
// New in this revision:
//   detectBrandFromModel(model, category?)   -> brand from model nomenclature
//   brandInfo(name, category?)               -> plateNote / hazard / family
//   decodeSerialCandidates(...)              -> every plausible reading
//
// All rule data + provenance lives in decodeDB.js. This file only interprets.
// Every result carries a confidence level; nothing is asserted without one.
//
// SCORING, NOT FIRST-MATCH-WINS
// ----------------------------
// The old engine returned the first rule that produced a plausible date. That
// is fine when a brand has one format, and quietly wrong when it has four —
// e.g. a Trane serial parses under BOTH the 2002-2009 and 2010+ styles and
// yields two different, individually plausible years. First-match-wins picked
// whichever rule the author happened to list first.
//
// Now every rule is evaluated, results are ranked by (confidence, rule order),
// the winner is returned, and any rule that produced a DIFFERENT year comes
// back in `alternates`. The UI can then show the surveyor that the serial is
// ambiguous rather than presenting a coin flip as fact.
// ─────────────────────────────────────────────────────────────────────────

import {
  DECODE_DB, DECODE_DB_VERSION, HVAC_CAPACITY_CODES, HVAC_CAPACITY_CODES_2,
  WH_GALLON_SIZES, BW_YEAR_LETTERS, YORK_YEAR_LETTERS, TRANE_YEAR_LETTERS,
} from './decodeDB.js';

export { DECODE_DB_VERSION };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Month letter A..M skipping I (Rheem HVAC months, Bradford White months,
// York post-2004 months).
const MONTH_STD = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 9, K: 10, L: 11, M: 12 };

// York / JCI PRE-2004 month letters. Skips BOTH I and J — so J is not a valid
// month here and K is September, not October. Mixing this up with MONTH_STD
// shifts every pre-2004 York date by a month, which is exactly the kind of
// silent error this engine exists to avoid.
const MONTH_YORK = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, K: 9, L: 10, M: 11, N: 12 };

// Straight alphabetic months, A=1 .. L=12.
const MONTH_ALPHA = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, J: 10, K: 11, L: 12 };

const CONF_RANK = { high: 3, medium: 2, low: 1 };
const rank = (c) => CONF_RANK[c] || 0;
// When two fields of one result have different confidences, the result as a
// whole is only as good as its weakest asserted field.
const weakest = (a, b) => (rank(a) <= rank(b) ? a : b);

const yyWindow = (n) => (n > 50 ? 1900 + n : 2000 + n);
const plausibleYear = (y) => y >= 1970 && y <= new Date().getFullYear() + 1;

function bwYearCandidates(letter) {
  const idx = BW_YEAR_LETTERS.indexOf(String(letter).toUpperCase());
  if (idx < 0) return null;
  const cap = new Date().getFullYear() + 1;
  const out = [];
  for (let y = 1984 + idx; y <= cap; y += 20) out.push(y);
  return out.length ? out : null;
}

// York pre-2004: 21-year cycle from 1971. The second pass through the cycle
// only ran until the format was retired in Oct 2004, so letters after N have
// exactly one candidate.
function yorkYearCandidates(letter) {
  const idx = YORK_YEAR_LETTERS.indexOf(String(letter).toUpperCase());
  if (idx < 0) return null;
  const base = 1971 + idx;
  const out = [base];
  if (base + 21 <= 2004) out.push(base + 21);
  return out;
}

/* ───────────────────────── CAPACITY ───────────────────────── */

const tonsLabel = (tons) => {
  const btu = Math.round(tons * 12) * 1000;
  const t = Number.isInteger(tons) ? tons : tons.toFixed(1);
  return `${t} ${tons === 1 ? 'Ton' : 'Tons'} (${btu.toLocaleString()} BTU/h)`;
};

// Brand-specific capacity rules know WHERE in the model number the capacity
// field sits, so they can't be fooled by a coincidental 3-digit run elsewhere
// in the string. The generic scanner below is the fallback for the ~half of
// the catalog with no capacity rule of its own.
function capacityFromRules(entry, m) {
  if (!entry?.capacityRules) return null;
  for (const rule of entry.capacityRules) {
    const match = m.match(rule.test);
    if (!match) continue;
    const f = rule.map || {};
    if (f.tons3 != null) {
      const code = match[f.tons3];
      const tons = HVAC_CAPACITY_CODES[code];
      if (tons != null) return { tons, label: tonsLabel(tons), code, confidence: rule.confidence, ruleId: rule.id };
    }
    if (f.tons2 != null) {
      const code = match[f.tons2];
      const tons = HVAC_CAPACITY_CODES_2[code];
      if (tons != null) return { tons, label: tonsLabel(tons), code, confidence: rule.confidence, ruleId: rule.id };
    }
    // Raw kBTU/h value (compressor nomenclature): tons = kBTU / 12, rounded
    // to a tenth. Not restricted to the standard capacity-code grid because
    // compressors ship in sizes the grid doesn't cover (ZR40 = 40 kBTU).
    if (f.kbtu != null) {
      const n = parseInt(match[f.kbtu], 10);
      if (n >= 6 && n <= 700) {
        const tons = Math.round((n / 12) * 10) / 10;
        return { tons, label: tonsLabel(tons), code: match[f.kbtu], confidence: rule.confidence, ruleId: rule.id };
      }
    }
  }
  return null;
}

export function decodeTonnageFromModel(model, brandName) {
  if (!model) return null;
  const m = String(model).toUpperCase().replace(/\s+/g, '');

  // 1) Brand-aware, position-anchored rule (best).
  const entry = findBrandEntry(brandName, 'hvac') || findBrandEntry(brandName);
  const byRule = capacityFromRules(entry, m);
  if (byRule) return byRule;

  // 1b) Some brands make equipment that has no cooling tonnage at all — fans,
  // pumps, boilers, unit heaters, diffusers, cooling towers. Their model
  // numbers are full of 2- and 3-digit groups (wheel size, GPM, MBH, neck
  // size) that the generic scan below will happily read as a capacity code.
  // A Greenheck exhaust fan reporting "2 Tons" is not a near-miss, it is a
  // fabricated number on a condition report. Stop here instead.
  if (entry?.noTonnage) return null;

  // 1c) Same trap, different door: when the caller has no category (the OCR
  // front-end often doesn't), a NON-hvac brand slips past the hvac-scoped
  // lookup above and lands in the generic scan — which then reads the "42"
  // in a Square D panel catalog number (NQOD442L225) as 3.5 tons. If the
  // brand resolves to any non-hvac category, there is no tonnage to decode.
  if (entry && entry.category !== 'hvac') return null;

  // 2) Generic: prefer an exact 3-digit capacity code.
  for (let i = 0; i <= m.length - 3; i++) {
    const code = m.slice(i, i + 3);
    if (/^\d{3}$/.test(code) && HVAC_CAPACITY_CODES[code] != null) {
      return { tons: HVAC_CAPACITY_CODES[code], label: tonsLabel(HVAC_CAPACITY_CODES[code]), code, confidence: 'high' };
    }
  }
  // 3) 2-digit fallback: skip a leading NNx product-series prefix, scan
  // overlapping pairs (so "636" -> "36"), take the last valid standard code.
  const body = /^\d{2}[A-Z]/.test(m) ? m.slice(2) : m;
  let best = null;
  for (let i = 0; i <= body.length - 2; i++) {
    const code = body.slice(i, i + 2);
    if (/^\d{2}$/.test(code) && HVAC_CAPACITY_CODES_2[code] != null) best = code;
  }
  if (best) return { tons: HVAC_CAPACITY_CODES_2[best], label: tonsLabel(HVAC_CAPACITY_CODES_2[best]), code: best, confidence: 'medium' };
  return null;
}

function decodeGallonsFromModel(model) {
  if (!model) return null;
  const m = String(model).toUpperCase();
  // Look for a standard tank size appearing as a 2-3 digit group.
  const nums = m.match(/\d{2,3}/g) || [];
  for (const n of nums) {
    const g = parseInt(n, 10);
    if (WH_GALLON_SIZES.includes(g)) {
      return { gallons: g, label: `${g} gal`, code: n, confidence: 'medium' };
    }
  }
  return null;
}

// Category-aware capacity: tonnage for HVAC, gallons for water heaters.
// Electrical gear has NO decodable capacity in this sense — amp/voltage
// ratings come off the plate text, and letting the tonnage scanner loose on
// a panel catalog number would fabricate a number. Hard null.
export function decodeCapacity(model, category = 'hvac', brandName) {
  if (category === 'electrical') return null;
  if (category === 'waterheater') {
    const g = decodeGallonsFromModel(model);
    return g ? { kind: 'gallons', value: g.gallons, label: g.label, code: g.code, confidence: g.confidence } : null;
  }
  const t = decodeTonnageFromModel(model, brandName);
  return t ? { kind: 'tons', value: t.tons, label: t.label, code: t.code, confidence: t.confidence, ruleId: t.ruleId } : null;
}

/* ───────────────────────── BRAND ───────────────────────── */

// For each brand whose alias appears in the text, record its LONGEST
// matching alias — needed so a more specific brand (e.g. "Daikin Applied")
// wins over a shorter substring alias on a different brand (e.g. Goodman's
// plain "daikin"), rather than whichever happens to sit first in the array.
//
// Aliases of ≤3 characters ('ge', 'lg', 'abb', 'icp', …) are matched on WORD
// BOUNDARIES, not substrings: plain includes() makes "GENERAL SUPPLY CO"
// match the 'ge' alias and "ALGAE-RESISTANT COATING" match 'lg'. Longer
// aliases keep substring matching because OCR routinely jams words together
// ("YORKINTL") and a boundary requirement would miss those.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shortAliasHit = (text, alias) =>
  new RegExp(`(^|[^a-z0-9])${escapeRe(alias)}([^a-z0-9]|$)`, 'i').test(text);

function brandsMatching(text, category) {
  if (!text) return [];
  const n = String(text).toLowerCase();
  const hits = [];
  for (const b of DECODE_DB) {
    if (category && b.category !== category) continue;
    let bestLen = 0;
    for (const a of b.aliases) {
      const hit = a.length <= 3 ? shortAliasHit(n, a) : n.includes(a);
      if (hit && a.length > bestLen) bestLen = a.length;
    }
    if (bestLen > 0) hits.push({ brand: b, matchLen: bestLen });
  }
  hits.sort((x, y) => y.matchLen - x.matchLen);
  return hits.map((h) => h.brand);
}

export function detectBrand(text, category) {
  const hits = brandsMatching(text, category);
  return hits.length ? hits[0].name : null;
}

// Brand from MODEL NOMENCLATURE. Nameplates get painted over, sun-bleached,
// and stickered; the model number survives when the brand name doesn't. A
// model starting 4TTR is a Trane whether or not the word "Trane" is legible.
//
// This is a FALLBACK only — it never overrides a brand read from the text.
// Prefixes are kept deliberately narrow; a false brand match is worse than
// no brand match, because it selects the wrong serial rules.
export function detectBrandFromModel(model, category) {
  if (!model) return null;
  const m = String(model).toUpperCase().replace(/\s+/g, '');
  for (const b of DECODE_DB) {
    if (category && b.category !== category) continue;
    if (!b.modelPrefixes) continue;
    for (const re of b.modelPrefixes) {
      if (re.test(m)) return b.name;
    }
  }
  return null;
}

function findBrandEntry(brandName, category) {
  if (!brandName) return null;
  const n = String(brandName).toLowerCase();
  // exact canonical name first
  const e = DECODE_DB.find((b) => (!category || b.category === category) && b.name.toLowerCase() === n);
  if (e) return e;
  // else most-specific alias match
  const hits = brandsMatching(n, category);
  return hits.length ? hits[0] : null;
}

// Everything the UI needs to talk about a brand honestly: the corporate
// family, whether we have any date rules at all, what to tell the surveyor
// when we don't, and any standing hazard note for the brand.
export function brandInfo(brandName, category) {
  const e = findBrandEntry(brandName, category);
  if (!e) return null;
  return {
    name: e.name,
    category: e.category,
    family: e.family || null,
    hasSerialRules: (e.serialRules || []).length > 0,
    plateNote: e.plateNote || null,
    hazard: e.hazard || null,
    notes: e.notes || null,
    sources: e.sources || [],
  };
}

/* ───────────────────────── SERIAL → DATE ───────────────────────── */

// Interpret one declarative rule against a serial string.
function applyRule(rule, s) {
  const m = s.match(rule.test);
  if (!m) return null;
  const f = rule.map || {};
  let year = null, month = null, week = null, altYears = null;

  if (f.yearFull != null) year = parseInt(m[f.yearFull], 10);
  if (f.yearShort != null) year = yyWindow(parseInt(m[f.yearShort], 10));
  if (f.year2000 != null) year = 2000 + parseInt(m[f.year2000], 10);
  if (f.yearDigits != null) {
    const [a, b] = f.yearDigits;
    year = 2000 + parseInt(`${m[a]}${m[b]}`, 10);
  }
  if (f.bwYear != null) {
    const cands = bwYearCandidates(m[f.bwYear]);
    if (!cands) return null;
    year = cands[cands.length - 1];        // most recent as primary
    if (cands.length > 1) altYears = cands.slice(0, -1);
  }
  if (f.yorkYear != null) {
    const cands = yorkYearCandidates(m[f.yorkYear]);
    if (!cands) return null;
    year = cands[cands.length - 1];
    if (cands.length > 1) altYears = cands.slice(0, -1);
  }
  if (f.traneYear != null) {
    year = TRANE_YEAR_LETTERS[String(m[f.traneYear]).toUpperCase()] || null;
    if (!year) return null;
  }
  if (f.monthNum != null) month = parseInt(m[f.monthNum], 10);
  if (f.monthStd != null) month = MONTH_STD[String(m[f.monthStd]).toUpperCase()] || null;
  if (f.monthYork != null) month = MONTH_YORK[String(m[f.monthYork]).toUpperCase()] || null;
  if (f.monthAlpha != null) month = MONTH_ALPHA[String(m[f.monthAlpha]).toUpperCase()] || null;
  // Julian day-of-year (Bristol compressors): converted to a calendar month.
  // Runs after the year fields above because the leap-day boundary needs the
  // decoded year to land the month correctly.
  if (f.julianDay != null) {
    const d = parseInt(m[f.julianDay], 10);
    if (d < 1 || d > 366) return null;
    if (year) month = new Date(year, 0, d).getMonth() + 1;
  }
  if (f.week != null) week = parseInt(m[f.week], 10);

  if (!year || !plausibleYear(year)) return null;
  if (month != null && (month < 1 || month > 12)) return null;
  if (week != null && (week < 1 || week > 53)) return null;

  // A rule may trust its year more than its month (see Lennox). Report the
  // month's own confidence rather than letting it inherit the year's.
  const monthConfidence = month != null ? (rule.monthConfidence || rule.confidence) : null;

  const parts = [];
  if (month) parts.push(MONTHS[month - 1] + (rank(monthConfidence) < rank(rule.confidence) ? '?' : ''));
  if (week) parts.push(`week ${week}`);
  const noteBits = [rule.note].filter(Boolean);
  if (altYears && altYears.length) noteBits.push(`could also be ${altYears.join(' / ')}`);
  const detail = parts.length ? `${parts.join(', ')} — ${noteBits.join('; ')}` : noteBits.join('; ');

  return {
    year, month, week, altYears,
    confidence: rule.confidence,
    monthConfidence,
    note: detail,
    ruleId: rule.id,
  };
}

// Evaluate EVERY rule for a brand and return all plausible readings, best
// first. Exported so a UI (or a future field-validation harness) can show the
// full ambiguity rather than just the winner.
export function decodeSerialCandidates(serial, brandName, category) {
  if (!serial) return [];
  const s = normalizeSerial(serial);
  const entry = findBrandEntry(brandName, category);
  if (!entry) return [];

  const scored = [];
  (entry.serialRules || []).forEach((rule, i) => {
    const r = applyRule(rule, s);
    if (r) scored.push({ ...r, brand: entry.name, category: entry.category, _order: i });
  });
  // Rank by confidence, then by declaration order (earlier = more specific,
  // by convention in decodeDB.js).
  scored.sort((a, b) => (rank(b.confidence) - rank(a.confidence)) || (a._order - b._order));
  return scored.map(({ _order, ...r }) => r);
}

// OCR reads nameplates that are stamped, etched, or printed on curved metal.
// Spaces and dashes land inconsistently, so strip them before matching —
// every rule in the DB is written against the compact form.
function normalizeSerial(serial) {
  return String(serial).toUpperCase().replace(/[\s\-.]/g, '');
}

export function decodeYearFromSerial(serial, brandName, category) {
  if (!serial) return null;
  const s = normalizeSerial(serial);
  const entry = findBrandEntry(brandName, category);

  const cands = decodeSerialCandidates(serial, brandName, category);
  if (cands.length) {
    const best = cands[0];
    // Only surface alternates that actually disagree about the YEAR — two
    // rules agreeing on 2016 is not an ambiguity worth alarming anyone about.
    const alternates = cands.slice(1).filter((c) => c.year !== best.year);
    return {
      ...best,
      alternates: alternates.length ? alternates : undefined,
      // If a second rule reads a different year, the surveyor needs to know
      // the serial itself is ambiguous, regardless of how the winner is rated.
      ambiguous: alternates.length > 0 || !!(best.altYears && best.altYears.length),
      plateNote: entry?.plateNote || null,
    };
  }

  // Brand known, but we have no rule (or none matched). Say so plainly instead
  // of falling through to a guess.
  if (entry && !(entry.serialRules || []).length) {
    return {
      year: null,
      confidence: 'none',
      note: entry.plateNote || 'No verified serial-date rule for this brand.',
      brand: entry.name,
      category: entry.category,
      plateNote: entry.plateNote || null,
      noRule: true,
    };
  }

  // No brand/category or no rule matched: last-ditch bare 4-digit year.
  const g = s.match(/(19[7-9]\d|20[0-4]\d)/);
  if (g && plausibleYear(+g[0])) {
    return {
      year: +g[0], note: 'generic 4-digit year found in serial - not a brand rule, confirm',
      confidence: 'low', brand: entry?.name || null, category: entry?.category || null,
      plateNote: entry?.plateNote || null,
    };
  }
  return null;
}

export function ageFromYear(year) {
  if (!year) return null;
  return new Date().getFullYear() - year;
}

export const HVAC_BRANDS = DECODE_DB.filter((b) => b.category === 'hvac').map((b) => b.name);
export const ALL_BRANDS = DECODE_DB.map((b) => ({ name: b.name, category: b.category, family: b.family || null }));

// Catalog stats — surfaced in Settings so the coverage claim is auditable
// rather than marketing.
export function catalogStats() {
  const total = DECODE_DB.length;
  const withRules = DECODE_DB.filter((b) => (b.serialRules || []).length > 0).length;
  const rules = DECODE_DB.reduce((n, b) => n + (b.serialRules || []).length, 0);
  const examples = DECODE_DB.reduce(
    (n, b) => n + (b.serialRules || []).reduce((k, r) => k + (r.examples || []).length, 0), 0);
  const aliases = DECODE_DB.reduce((n, b) => n + b.aliases.length, 0);
  const byCategory = {};
  for (const b of DECODE_DB) byCategory[b.category] = (byCategory[b.category] || 0) + 1;
  return { version: DECODE_DB_VERSION, total, withRules, plateOnly: total - withRules, rules, examples, aliases, byCategory };
}
