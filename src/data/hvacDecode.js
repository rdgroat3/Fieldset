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
  CATEGORIES,
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
    // Rule-local lookup table. Needed because some platforms number their
    // sizes on a scale that has nothing to do with the industry kBTU/12
    // grid — Carrier's 48TC commercial rooftops call 20 tons "24" and 25
    // tons "28", where the shared 2-digit grid reads "24" as 2 tons and
    // "28" as nothing. Feeding those through HVAC_CAPACITY_CODES_2 doesn't
    // just miss, it produces a confident answer that is wrong by a factor
    // of ten. A rule that knows its own platform's scale carries its own
    // table.
    if (f.table != null && rule.table) {
      const code = match[f.table];
      const tons = rule.table[code];
      if (tons != null) return { tons, label: tonsLabel(tons), code, confidence: rule.confidence, ruleId: rule.id };
    }
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

  // 1d) The brand IS known AND we hold position-anchored nomenclature for it,
  // but none of its rules matched this model.
  //
  // That is meaningful information, and the old code threw it away. If we
  // know how Carrier writes a model number and this string doesn't fit any
  // of the shapes Carrier uses, then a 3-digit run somewhere inside it is
  // far more likely to be a voltage code, a revision number, or a factory
  // SKU fragment than a capacity field. Falling through to the blind scan
  // takes a case where we had good reason to doubt and converts it into a
  // confident number.
  //
  // This is the same accuracy-over-coverage call the catalog already makes
  // by leaving ~76 brands rule-free: no answer beats a fabricated one. The
  // surveyor still sees whatever the plate itself printed.
  if (entry?.capacityRules?.length) {
    return null;
  }

  // 2) Generic: an exact 3-digit code off the standard kBTU/12 grid.
  //
  // Confidence downgraded from 'high' to 'medium'. It was never 'high' in
  // any real sense — position is unverified, so this is "a run of digits
  // somewhere in this string happens to be a valid capacity code", which is
  // a coincidence a long model number can produce on its own. Labelling
  // that 'high' put an unverified guess on the same footing as a decode
  // anchored to a manufacturer's published nomenclature table, and the UI
  // and the exported condition report both believed it.
  for (let i = 0; i <= m.length - 3; i++) {
    const code = m.slice(i, i + 3);
    if (/^\d{3}$/.test(code) && HVAC_CAPACITY_CODES[code] != null) {
      return {
        tons: HVAC_CAPACITY_CODES[code],
        label: tonsLabel(HVAC_CAPACITY_CODES[code]),
        code,
        confidence: 'medium',
        generic: true,
        note: 'Capacity read from an unanchored digit match \u2014 no verified nomenclature for this brand. Confirm against the plate.',
      };
    }
  }
  // 3) 2-digit fallback: skip a leading NNx product-series prefix, scan
  // overlapping pairs (so "636" -> "36"), take the last valid standard code.
  //
  // Downgraded to 'low'. Two digits is the weakest possible evidence — a
  // two-character window will find a "valid" code in a large fraction of
  // arbitrary model numbers purely by chance.
  const body = /^\d{2}[A-Z]/.test(m) ? m.slice(2) : m;
  let best = null;
  for (let i = 0; i <= body.length - 2; i++) {
    const code = body.slice(i, i + 2);
    if (/^\d{2}$/.test(code) && HVAC_CAPACITY_CODES_2[code] != null) best = code;
  }
  if (best) {
    return {
      tons: HVAC_CAPACITY_CODES_2[best],
      label: tonsLabel(HVAC_CAPACITY_CODES_2[best]),
      code: best,
      confidence: 'low',
      generic: true,
      note: 'Capacity inferred from a 2-digit match with no positional anchor \u2014 weak evidence. Verify at the unit.',
    };
  }
  return null;
}

function decodeGallonsFromModel(model) {
  if (!model) return null;
  const m = String(model).toUpperCase();

  // Primary pass: standard 2-3 digit runs, unchanged from before and
  // deliberately NOT delimiter-restricted — existing brands rely on that
  // (e.g. 'XE50T06' has its "50" gallon code glued directly between letters
  // with no separator at all, and that's a real passing test case).
  const nums = m.match(/\d{2,3}/g) || [];
  for (const n of nums) {
    const g = parseInt(n, 10);
    if (WH_GALLON_SIZES.includes(g)) {
      return { gallons: g, label: `${g} gal`, code: n, confidence: 'medium' };
    }
  }

  // Fallback: a single digit, but ONLY when it's delimited on both sides
  // (space, hyphen, or start/end of string) rather than fused onto letters.
  // This exists for point-of-use water heaters like A.O. Smith's "EJC 6
  // 200", where the gallon count is genuinely a lone digit. It's a fallback
  // rather than merged into the primary pass on purpose: an UNDELIMITED
  // single digit is too likely to be part of a model SERIES code instead of
  // a capacity field — "EN6-40-DORS" has exactly that shape, and matching
  // its "6" (from "EN6") before ever reaching the real "40" gallon code is
  // exactly the bug that motivated splitting these into two tiers.
  const single = m.match(/(?:^|[^A-Z0-9])(\d)(?:[^A-Z0-9]|$)/);
  if (single) {
    const g = parseInt(single[1], 10);
    if (WH_GALLON_SIZES.includes(g)) {
      return { gallons: g, label: `${g} gal`, code: single[1], confidence: 'medium' };
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
  // VAV/fan-terminal and backflow-preventer capacity (inlet size, heater kW,
  // pipe size + assembly type) isn't encoded in the model number the way
  // tonnage/gallons are — it's read straight off the plate text in
  // nomenclature.js's parseNameplateText and lives in the np.capacity field
  // directly. Falling through to the HVAC tonnage scanner here would be
  // actively wrong (a VAV model number isn't a compressor capacity code),
  // so these categories explicitly have no model-based decode.
  if (category === 'vav' || category === 'backflow') return null;
  const t = decodeTonnageFromModel(model, brandName);
  if (!t) return null;
  // `generic` and `note` must survive this wrapper. They are the whole
  // point of the honesty pass upstream — a caller that only sees
  // {value, confidence} has no way to distinguish "decoded from Carrier's
  // published nomenclature table" from "found three digits that happened to
  // be a valid code", and the Decoder screen and the exported condition
  // report both phrase their output based on exactly that distinction.
  return {
    kind: 'tons',
    value: t.tons,
    label: t.label,
    code: t.code,
    confidence: t.confidence,
    ruleId: t.ruleId,
    generic: t.generic || false,
    note: t.note || null,
  };
}

/* ───────────────── CAPACITY vs ELECTRICAL SANITY CHECK ─────────────────
 *
 * An independent second opinion on a decoded tonnage, using data the plate
 * already carries.
 *
 * Every capacity decode in this engine reads the SAME source — the model
 * number — so when the nomenclature is wrong or missing, nothing downstream
 * disagrees. That is exactly how a Carrier 48TC 20-ton rooftop came back as
 * "2 Tons": one bad rule, no second source, and a confident number on the
 * condition report.
 *
 * Minimum circuit ampacity is a genuinely independent signal. It comes from
 * a different field on the plate, it is set by the actual compressor and fan
 * loads, and it scales with capacity across every manufacturer because it is
 * governed by physics and the NEC rather than by a naming convention.
 *
 * THE BANDS ARE DELIBERATELY WIDE. Electric resistance heat, gas-pack
 * blowers, high-static motors, and dual-circuit machines all move MCA around
 * substantially at a fixed tonnage. This is not a capacity estimator and it
 * must never be used as one — the ratio has to be off by roughly 3x before
 * anything is said, which is far outside what accessory loads explain and
 * squarely in the range of a decode that read the wrong field. A quiet
 * result means "no contradiction found", not "the capacity is confirmed".
 *
 * Returns null when it has nothing to say, which is most of the time.
 */

// Amps per nominal ton, by supply.
//
// Two sets, because WHICH current figure you read matters more than the
// tolerance you put around it:
//
//   RLA (rated load amps) is the COMPRESSOR ALONE. Electric resistance
//   heat, which is the main reason a plate's current draw wanders away
//   from its cooling capacity, does not appear in it at all. When the
//   plate prints RLA this is by far the cleaner comparison, so it gets
//   tighter bands.
//
//   MCA (minimum circuit ampacity) is the whole machine including strip
//   heat and blower. A 3-ton heat pump with 10 kW of auxiliary heat draws
//   roughly double a cooling-only 3-ton, so MCA bands have to be loose
//   enough to leave that alone.
const AMPS_PER_TON = {
  rla: [
    { volts: [440, 600], phase: 3, low: 1.1, high: 2.8 },
    { volts: [180, 260], phase: 3, low: 2.6, high: 5.5 },
    { volts: [180, 260], phase: 1, low: 4.5, high: 9.0 },
    { volts: [100, 130], phase: 1, low: 9.0, high: 18.0 },
  ],
  mca: [
    { volts: [440, 600], phase: 3, low: 1.4, high: 4.5 },
    { volts: [180, 260], phase: 3, low: 3.5, high: 9.0 },
    { volts: [180, 260], phase: 1, low: 6.0, high: 14.0 },
    { volts: [100, 130], phase: 1, low: 12.0, high: 26.0 },
  ],
};

// How far outside the band counts as a contradiction rather than an
// unusual-but-real machine.
//
// Asymmetric on purpose. Auxiliary loads only ever push current UP, so a
// reading far ABOVE the band is the ambiguous direction and a reading far
// BELOW it is close to impossible — no accessory makes a large unit draw
// less. The looser factor goes where the ambiguity actually is.
//
// These are also deliberately more aggressive than an assertion would be,
// because this only ever raises a WARNING. A false alarm costs the surveyor
// ten seconds of re-reading the plate. A silent 10x capacity error costs a
// wrong replacement budget in a client's report.
const FACTOR = {
  rla: { over: 2.0, under: 2.5 },
  mca: { over: 2.5, under: 3.0 },
};

export function sanityCheckCapacity({ tons, volts, phase, mca, rla }) {
  const t = Number(tons);
  const v = Number(volts);
  const ph = Number(phase);
  if (!isFinite(t) || t <= 0 || !isFinite(v)) return null;

  // Prefer the compressor-only figure when the plate printed one.
  const source = isFinite(Number(rla)) && Number(rla) > 0 ? 'rla' : 'mca';
  const a = Number(source === 'rla' ? rla : mca);
  if (!isFinite(a) || a <= 0) return null;

  const band = AMPS_PER_TON[source].find(
    (b) => v >= b.volts[0] && v <= b.volts[1] && (!isFinite(ph) || ph === b.phase)
  );
  if (!band) return null;

  const f = FACTOR[source];
  const expectedLow = t * band.low;
  const expectedHigh = t * band.high;
  const label = source.toUpperCase();

  if (a > expectedHigh * f.over) {
    return {
      ok: false,
      direction: 'capacity-too-small',
      source,
      expected: [Math.round(expectedLow), Math.round(expectedHigh)],
      note: `Decoded capacity (${t} ton) does not fit this plate's electrical rating \u2014 ${label} of ${a}A at ${v}V would be expected on a much larger unit. Re-read the model number before using this capacity.`,
    };
  }
  if (a < expectedLow / f.under) {
    return {
      ok: false,
      direction: 'capacity-too-large',
      source,
      expected: [Math.round(expectedLow), Math.round(expectedHigh)],
      note: `Decoded capacity (${t} ton) does not fit this plate's electrical rating \u2014 ${label} of ${a}A at ${v}V is far below what a unit that size would draw. Re-read the model number before using this capacity.`,
    };
  }
  return { ok: true, source, expected: [Math.round(expectedLow), Math.round(expectedHigh)] };
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

/**
 * Collapse the punctuation and spacing a nameplate uses decoratively but
 * which carries no identity.
 *
 * Real plates print "A. O. SMITH" — periods AND spaces. The catalog alias is
 * "a.o. smith". Neither `includes` nor the short-alias word-boundary regex
 * bridges that gap, so an A.O. Smith water heater matched no brand at all,
 * which then meant no serial rules, no year, and no condition assessment —
 * the entire chain downstream of the brand went dark because of two spaces.
 *
 * Rather than bolting another alias onto one entry (and waiting to discover
 * the next brand with the same problem), both sides are normalized: strip
 * periods, ampersands, hyphens and commas, then collapse whitespace. This
 * makes "A. O. SMITH", "A.O.SMITH", "AO SMITH" and "A O Smith" all match the
 * single existing alias, and does the same for every other punctuated brand
 * in the catalog — "Day & Night", "CAC/BDP", "Carrier Corp.".
 *
 * Deliberately does NOT strip slashes: "CAC/BDP" vs "CACBDP" is fine either
 * way, but slashes separate meaningful tokens in model numbers and this
 * helper is also used on model-ish text.
 */
const normalizeBrandText = (s) =>
  String(s || '').toLowerCase().replace(/[.,&\-]/g, ' ').replace(/\s+/g, ' ').trim();

// A space-free form too, so "A.O. Smith" -> "aosmith" matches a plate that
// ran the initials together.
const squashBrandText = (s) => normalizeBrandText(s).replace(/\s/g, '');

// Aliases claimed by entries belonging to different manufacturer families.
// Derived from the catalog at load rather than hand-listed, so adding a brand
// that collides with an existing one is caught without anyone remembering to
// update a list. Same-family overlaps (Rheem hvac / Rheem waterheater, Bosch /
// Buderus) are deliberate sibling entries and are not included.
const CROSS_FAMILY_ALIASES = (() => {
  const byAlias = new Map();
  for (const b of DECODE_DB) {
    for (const a of b.aliases) {
      const k = normalizeBrandText(a);
      if (!byAlias.has(k)) byAlias.set(k, new Set());
      byAlias.get(k).add(b.family || b.name);
    }
  }
  const out = new Set();
  for (const [k, fams] of byAlias) if (fams.size > 1) out.add(k);
  return out;
})();

const isCrossFamilyAlias = (alias) => CROSS_FAMILY_ALIASES.has(normalizeBrandText(alias));

function brandsMatching(text, category, opts = {}) {
  if (!text) return [];
  const crossCategory = opts.crossCategory === true;
  const raw = String(text).toLowerCase();
  const norm = normalizeBrandText(text);
  const squash = squashBrandText(text);
  const hits = [];
  for (const b of DECODE_DB) {
    if (category && b.category !== category) {
      // Cross-category pass (see detectBrand): only a long, unambiguous
      // alias may match outside the selected category.
      if (!crossCategory) continue;
    }
    const outOfCategory = !!(category && b.category !== category);
    let bestLen = 0;
    let bestAlias = null;
    let firstAt = Infinity;
    for (const a of b.aliases) {
      const aNorm = normalizeBrandText(a);
      const aSquash = squashBrandText(a);
      // Short aliases keep the word-boundary requirement in every form —
      // a 2-3 character alias that matched on a bare substring would fire
      // on half the catalog.
      const hit = a.length <= 3
        ? (shortAliasHit(raw, a) || shortAliasHit(norm, aNorm))
        : (raw.includes(a) || norm.includes(aNorm) || (aSquash.length >= 5 && squash.includes(aSquash)));
      if (!hit) continue;
      if (a.length > bestLen) { bestLen = a.length; bestAlias = a; }
      const at = raw.indexOf(a) >= 0 ? raw.indexOf(a) : norm.indexOf(aNorm);
      if (at >= 0 && at < firstAt) firstAt = at;
    }
    // An out-of-category brand has to earn it: a 5+ character alias, which
    // means an actual brand word is printed on the plate rather than a short
    // ambiguous token coincidentally matching.
    if (bestLen > 0 && outOfCategory && bestLen < 5) continue;
    // …and the alias has to belong to one manufacturer. "general electric" is
    // claimed by GE (Electrical, ABB-built) and by Rheem (Water Heater), which
    // sells GE-branded heaters — both legitimate, both 16 characters, so the
    // length gate above passes them equally and catalog order decides.
    //
    // In-category that is harmless: the selected category is the tiebreak, and
    // it is the right one. Borrowing across categories it is not, because the
    // two entries are not interchangeable downstream — Rheem carries serial
    // rules and GE (Electrical) carries none, so a GE panel photographed while
    // the app is tagged for water heaters does not merely get the wrong name,
    // it gets a confident manufacture year off a water-heater serial rule, and
    // from there an age, a remaining life, and a line on the replacement
    // schedule. Leaving the brand blank costs the surveyor a typed word.
    if (bestLen > 0 && outOfCategory && bestAlias && isCrossFamilyAlias(bestAlias)) continue;
    if (bestLen > 0) hits.push({ brand: b, matchLen: bestLen, firstAt, outOfCategory });
  }

  /**
   * Ranking. The old sort was alias length alone, which is a proxy for
   * specificity and nothing else — and it produced a measured wrong answer:
   * a Lennox condensing unit photographed with its Copeland compressor
   * label in frame reported the brand as COPELAND, because "copeland" is
   * eight characters and "lennox" is six. Everything downstream then used
   * Copeland's serial rules on a Lennox serial.
   *
   * Three signals now, in priority order:
   *
   *  1. UNIT brand beats COMPONENT brand. A compressor, motor or valve
   *     maker is never the equipment's manufacturer, so if any non-component
   *     brand matched at all, the component brands are out of the running.
   *     This is a fact about the equipment, not a heuristic, so it sorts
   *     first.
   *  2. Earlier on the plate wins. Manufacturers put their name in the
   *     identification block at the top; component labels and licence text
   *     sit lower. Flat OCR text preserves that order closely enough to be
   *     the strongest positional signal available without geometry.
   *  3. Longer alias wins — the original tie-break, kept for the case it
   *     was right about: "Daikin Applied" over Goodman's plain "daikin".
   */
  const anyUnitBrand = hits.some((h) => !h.brand.componentBrand);
  hits.sort((x, y) => {
    // 0. A brand in the selected category always outranks one borrowed from
    //    another category, whatever the alias lengths say.
    const xo = x.outOfCategory ? 1 : 0;
    const yo = y.outOfCategory ? 1 : 0;
    if (xo !== yo) return xo - yo;
    if (anyUnitBrand) {
      const xc = x.brand.componentBrand ? 1 : 0;
      const yc = y.brand.componentBrand ? 1 : 0;
      if (xc !== yc) return xc - yc;
    }
    if (x.firstAt !== y.firstAt) return x.firstAt - y.firstAt;
    return y.matchLen - x.matchLen;
  });
  return hits.map((h) => h.brand);
}

/**
 * Brand from the plate text.
 *
 * The category filter used to be absolute, and that silently threw away
 * brands the plate states in plain English. A Bradford White water heater
 * photographed during an HVAC survey — which is where water heaters
 * actually are, in the mechanical room, between the boiler and the pumps —
 * matched nothing at all, because Bradford White is filed under
 * `waterheater` and the scan was tagged `hvac`. The knock-on cost is larger
 * than one blank field: no make means no serial rule, which means no
 * manufacture year, which means no age and no remaining-useful-life, which
 * means the unit quietly vanishes from the replacement schedule that the
 * survey was commissioned to produce.
 *
 * So: prefer the selected category, but rather than reporting nothing, fall
 * back to a cross-category match. The fallback is gated on a 5+ character
 * alias hit, so it fires when a real brand word is printed on the plate and
 * not when some short token coincidentally lines up. `detectBrandInfo`
 * reports which case occurred so callers can say so on the report instead of
 * presenting a borrowed match as a clean one.
 */
export function detectBrand(text, category) {
  return detectBrandInfo(text, category).name;
}

export function detectBrandInfo(text, category) {
  const inCat = brandsMatching(text, category);
  if (inCat.length) {
    return { name: inCat[0].name, category: inCat[0].category, outOfCategory: false, note: null };
  }
  if (!category) return { name: null, category: null, outOfCategory: false, note: null };
  const cross = brandsMatching(text, category, { crossCategory: true });
  const hit = cross.find((b) => b.category !== category);
  if (!hit) return { name: null, category: null, outOfCategory: false, note: null };
  return {
    name: hit.name,
    category: hit.category,
    outOfCategory: true,
    note: `Brand read as ${hit.name}, which is catalogued under ${CATEGORIES[hit.category] || hit.category} `
      + `rather than the ${CATEGORIES[category] || category} category this scan was tagged with `
      + `— check the equipment category is right before relying on the decoded year.`,
  };
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
