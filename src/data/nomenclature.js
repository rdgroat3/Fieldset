// Nomenclature decode dictionary.
// Nameplate make/model/serial/year/tonnage decoding now lives in hvacDecode.js;
// parseNameplateText below is the OCR-text front end for it. Pipe-size tables
// (unrelated) remain here.

import { decodeCapacity, decodeYearFromSerial, detectBrand, detectBrandInfo, detectBrandFromModel, sanityCheckCapacity } from './hvacDecode.js';
import { extractSmart, looksLikeValue } from './nameplateSmart.js';

// Generic field extraction from raw OCR lines. Return shape is unchanged
// (make/model/serial/capacity/year/decodeNotes) so existing callers keep working;
// the decode logic now runs through the shared hvacDecode engine.
// `category` is optional and defaults to undefined (search every brand), which
// is what the old single-arg callers effectively did.
// A line that's ONLY a label (e.g. "MODEL NUMBER", "SERIAL NO.") with no
// value on it — used below to know when to look at the next line instead.
const isBareLabel = (line, labelWords) => {
  const stripped = line.replace(/[.:#]/g, ' ').trim();
  return labelWords.some((w) => new RegExp(`^${w}$`, 'i').test(stripped));
};

/**
 * A plausible model/serial VALUE token, for the legacy text-order passes
 * below.
 *
 * This used to be its own, much weaker test — a short reject-list of six
 * label words plus a shape regex. Two independent plausibility rules for
 * the same question is one too many, and the weaker one silently won
 * whenever the geometry passes came up empty. Measured failure: a plate
 * whose values had burned off entirely, leaving only labels, assigned
 * "MFG DATE" as the SERIAL — because the old list happened to contain
 * "DATE" but not "MFG", so "MFG DATE" wasn't recognised as a label at all.
 *
 * Delegating to nameplateSmart's looksLikeValue means the rating-token
 * filter, the digit requirement, the calendar-date guard and the
 * all-words-are-labels check apply on every path, not just the geometric
 * one. The extra length cap is the only thing kept from the old version:
 * these text-order passes read whole lines rather than tokens, so they are
 * more exposed to an address or a disclaimer sentence running long.
 */
const looksLikeCode = (line) => {
  const s = String(line || '').trim();
  if (s.length > 24) return false;
  return looksLikeValue(s);
};

// Auto-detects which equipment category a nameplate belongs to from its raw
// OCR text, so the surveyor doesn't have to manually tap HVAC/Water
// Heater/Electrical/VAV/Backflow on every single scan — a real nameplate
// almost always names its own equipment type somewhere on the plate.
// Ordered most-specific-first: a water heater plate that happens to mention
// "circuit" shouldn't get misread as electrical gear, so the narrower
// signals are checked before the broad ones.
export function guessCategory(text) {
  const t = (text || '').toUpperCase();
  const has = (...words) => words.some((w) => t.includes(w));

  if (has('BACKFLOW', 'REDUCED PRESSURE', 'RPZ', 'DOUBLE CHECK VALVE', 'DCVA', 'VACUUM BREAKER', 'PVB'))
    return 'backflow';
  if (has('VAV', 'AIR TERMINAL', 'INLET SIZE', 'PRIMARY CFM', 'DIFFUSER', 'REGISTER', 'FAN POWERED BOX'))
    return 'vav';
  if (has('WATER HEATER', 'STORAGE TANK', 'TANKLESS', 'GALLON', 'US GAL', 'RECOVERY RATE'))
    return 'waterheater';
  if (has('SWITCHBOARD', 'PANELBOARD', 'CIRCUIT BREAKER PANEL', 'MAIN BREAKER', 'BUS RATING',
      'TRANSFORMER', 'DISCONNECT SWITCH', 'MOTOR CONTROL CENTER', 'SWITCHGEAR'))
    return 'electrical';
  if (has('REFRIGERANT', 'COMPRESSOR', 'CONDENSING UNIT', 'HEAT PUMP', 'ROOFTOP', 'FAN COIL',
      'AIR HANDLER', 'FURNACE', 'PACKAGE UNIT'))
    return 'hvac';

  // No equipment-type keyword on the plate at all — try the brand instead.
  // A nameplate that just says "Carrier Corporation" with no other
  // descriptive word still tells you plenty: Carrier's water-heater and
  // electrical-gear entries don't exist in this DB, so if it matches
  // anything it's the hvac brand entry. Checked in the same specificity
  // order as above.
  for (const cat of ['backflow', 'vav', 'waterheater', 'electrical', 'hvac']) {
    if (detectBrand(text, cat)) return cat;
  }
  return null; // no signal at all — leave whatever category the user already had
}

// Reads a literal MM/DD/YY or MM/DD/YYYY date next to a DATE label. Many
// terminal-unit and accessory nameplates (VAV boxes, backflow preventers)
// print the manufacture date directly rather than encoding it into a serial
// number the way HVAC compressors do — Redd-i's plates are a clean example
// ("DATE: 11/22/13", no serial-to-year decode needed or possible). Tried
// as a fallback after the serial-decode path, and separate from the
// existing 4-digit-year-near-MFG regex below since that one can't parse a
// 2-digit year at all.
// NOT every date on a plate is the manufacture date.
//
// Equipment accumulates dates: hydrostatic test stamps, annual inspection
// tags, backflow retest stickers, calibration certificates, warranty expiry,
// label artwork revisions, and the installer's start-up sticker. Every one of
// them sits next to the word DATE, and the regexes below search for DATE
// unanchored, so any of them can be picked up.
//
// This guard became load-bearing when year precedence was inverted so that a
// printed date outranks a serial decode. Before that change, a stray test
// date only mattered when the serial produced nothing. After it, a boiler
// stamped "TEST DATE 05/2024" was reported as manufactured in 2024 — a
// forty-year-old cast-iron boiler recorded as new, dropping straight off the
// replacement schedule with a full service life ahead of it. Inverting the
// precedence was right; shipping it without this list would not have been.
//
// Matched against the text immediately PRECEDING the DATE keyword.
const NON_MFG_DATE_QUALIFIER = new RegExp(
  '(?:' + [
    'TEST', 'RETEST', 'INSPECT\\w*', 'CERT\\w*', 'CALIB\\w*',
    'WARRANT\\w*', 'EXPIR\\w*', 'EXP',
    'REV', 'REVISION', 'REVISED',
    'INSTALL\\w*', 'SERVICE', 'SERVICED', 'START\\s*-?\\s*UP', 'STARTUP', 'COMMISSION\\w*',
    'DUE', 'NEXT', 'LAST', 'CHECK\\w*', 'PM',
    'SHIP\\w*', 'PURCHASE\\w*', 'SOLD', 'PRINT\\w*', 'ORDER\\w*', 'INVOICE',
  ].join('|') + ')[\\s.:#\\-]*$', 'i'
);

// Is the DATE keyword at `index` qualified as something other than a
// manufacture date by the words just before it?
function dateIsDisqualified(text, index) {
  const before = text.slice(Math.max(0, index - 28), index);
  return NON_MFG_DATE_QUALIFIER.test(before);
}

// Scans every DATE-ish match rather than only the first, so that a plate
// carrying BOTH a disqualified date and a real one ("MFG DATE 04/2009" above
// "TEST DATE 05/2024") still finds the real one instead of stopping at
// whichever appears first in OCR order.
function matchDateNear(text, re) {
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = rx.exec(text)) !== null) {
    if (!dateIsDisqualified(text, m.index)) return m;
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  return null;
}

function literalDateField(text) {
  const m = matchDateNear(text || '', /DATE[.:#\s]*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/i);
  if (!m) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += year > 50 ? 1900 : 2000;
  if (year < 1970 || year > new Date().getFullYear() + 1) return null;
  return { year, month: parseInt(m[1], 10) };
}

// `blocks` (optional) is ML Kit's structured result — per-line bounding
// boxes. When present, field assignment runs through the smart extractor in
// nameplateSmart.js FIRST (geometry-aware label→value pairing plus
// nomenclature-based label-free recognition), and the legacy text-order
// passes below only fill whatever it left blank. Callers without blocks
// (re-parses of stored rawOcr, older photos) get the smart extractor's
// nomenclature signals but not its geometry — still strictly better than
// the old text-only pipeline.
export function parseNameplateText(rawText, category, blocks) {
  const text = rawText || '';
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  const out = { make: '', model: '', serial: '', capacity: '', year: '', decodeNotes: [], candidates: null };

  // Brand
  // detectBrandInfo, not detectBrand: when the brand had to be borrowed from
  // another equipment category we want to say so on the report rather than
  // present it as a clean in-category match.
  const brandHit = detectBrandInfo(text, category);
  out.make = brandHit.name || '';
  if (brandHit.outOfCategory && brandHit.note) out.decodeNotes.push(brandHit.note);

  // Smart pass — geometry + nomenclature. Wrapped defensively: a decode
  // helper must never take down a scan; worst case we degrade to the legacy
  // passes below, which is exactly the pre-smart behavior.
  let smart = null;
  try {
    smart = extractSmart({ text, blocks }, category, out.make || null);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[nomenclature] extractSmart failed, using legacy passes:', e);
  }
  let smartYear = null;
  if (smart) {
    out.candidates = smart.candidates;
    for (const n of smart.notes) out.decodeNotes.push(n);
    if (!out.make && smart.picks.make) out.make = smart.picks.make.value;
    if (smart.picks.model) {
      out.model = smart.picks.model.value.toUpperCase();
      out.decodeNotes.push(`Model: ${smart.picks.model.why[0]} \u2014 verify`);
    }
    if (smart.picks.serial) {
      out.serial = smart.picks.serial.value.toUpperCase();
      out.decodeNotes.push(`Serial: ${smart.picks.serial.why[0]} \u2014 verify`);
    }
    // Held until after the serial→year decode below: a brand-rule decode of
    // the serial outranks a printed date when both exist, matching the
    // precedence the legacy pipeline already established.
    smartYear = smart.picks.year ? smart.picks.year.value : null;
  }

  const MODEL_WORDS = ['MODEL', 'MODEL NO', 'MODEL NUMBER', 'MOD', 'M/N', 'MDL'];
  const SERIAL_WORDS = ['SERIAL', 'SERIAL NO', 'SERIAL NUMBER', 'SER', 'S/N', 'SN'];
  // Guards against the label regexes below "succeeding" by capturing their
  // OWN trailing word as if it were the value — e.g. "MODEL NUMBER" alone
  // (nothing after it) let the optional (?:NO|NUMBER)? backtrack out, and
  // the capture group then matched "NUMBER" itself as a 6-character
  // alphanumeric "model number". Every real scan hit this immediately,
  // which is a big part of why fields came back full of noise instead of
  // empty or right.
  const isLabelFragment = (s) => /^(NO\.?|NUMBER|NUM|SER|SERIAL)$/i.test(s.trim());

  // Model / Serial via labeled lines.
  //
  // Nameplates are laid out as bordered TABLES far more often than as plain
  // label-colon-value text — "MODEL NUMBER" and "EJC 6 200" sit in two
  // different table cells, one above the other. OCR (ML Kit / Vision) reads
  // each visual block as its own line, so the label and its value routinely
  // land on SEPARATE OCR lines instead of the same one. The original
  // same-line-only regex simply never matched that shape, which is why
  // fields so often came back empty even though the text was captured fine —
  // this was the actual root cause of "OCR pulls text but doesn't populate
  // the right field."
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!out.model) {
      const mdl = line.match(/(?:MODEL\s*(?:NO|NUMBER)?|MOD|M\/N|MDL)[.:#\s]*([A-Z0-9][A-Z0-9\-\/]{3,})/i);
      if (mdl && !isLabelFragment(mdl[1])) {
        out.model = mdl[1].toUpperCase();
      } else if (isBareLabel(line, MODEL_WORDS) && lines[i + 1] && looksLikeCode(lines[i + 1])) {
        out.model = lines[i + 1].toUpperCase();
        out.decodeNotes.push('Model read from the line below its label (table layout) \u2014 verify');
      }
    }
    if (!out.serial) {
      const ser = line.match(/(?:SERIAL\s*(?:NO|NUMBER)?|SER|S\/N|SN)[.:#\s]*([A-Z0-9][A-Z0-9\-]{3,})/i);
      if (ser && !isLabelFragment(ser[1])) {
        out.serial = ser[1].toUpperCase();
      } else if (isBareLabel(line, SERIAL_WORDS) && lines[i + 1] && looksLikeCode(lines[i + 1])) {
        out.serial = lines[i + 1].toUpperCase();
        out.decodeNotes.push('Serial read from the line below its label (table layout) \u2014 verify');
      }
    }
  }

  // Sequence-of-labels layout: "MODEL NUMBER" / "SERIAL NUMBER" / "ITEM ID"
  // each on their OWN line (not combined into one header row), immediately
  // followed by the same count of value lines in the same order — a third
  // real table shape ML Kit produces, distinct from both cases above. Only
  // runs if the simpler passes left something missing, and only trusts a
  // label at position k pairing with the value at position k if the counts
  // match exactly; a mismatched count means the guess isn't safe and it's
  // left for "Insert from scan" instead.
  if (!out.model || !out.serial) {
    for (let i = 0; i < lines.length; i++) {
      const isModelLbl = isBareLabel(lines[i], MODEL_WORDS);
      const isSerialLbl = isBareLabel(lines[i], SERIAL_WORDS);
      if (!isModelLbl && !isSerialLbl) continue;

      // Walk forward collecting a run of bare-label-shaped lines (short,
      // all-caps-ish, not themselves a plausible code value).
      const labelRun = [];
      let j = i;
      while (j < lines.length && j - i < 5 && lines[j].length <= 30 && !looksLikeCode(lines[j])) {
        labelRun.push(lines[j]);
        j++;
      }
      if (labelRun.length < 2) continue;

      const valueRun = lines.slice(j, j + labelRun.length);
      if (valueRun.length !== labelRun.length || !valueRun.every(looksLikeCode)) continue;

      labelRun.forEach((lbl, k) => {
        if (!out.model && isBareLabel(lbl, MODEL_WORDS)) {
          out.model = valueRun[k].toUpperCase();
          out.decodeNotes.push('Model read from a label-sequence table layout \u2014 verify');
        }
        if (!out.serial && isBareLabel(lbl, SERIAL_WORDS)) {
          out.serial = valueRun[k].toUpperCase();
          out.decodeNotes.push('Serial read from a label-sequence table layout \u2014 verify');
        }
      });
      break;
    }
  }
  // both values together on the next (A.O. Smith, State Industries, and
  // most tank water heaters lay the plate out exactly this way). Only runs
  // if the simpler per-label pass above didn't already fill both fields, and
  // only trusts it when the value line cleanly splits into 2+ separate
  // tokens — a single run-on token isn't safely splittable and is better
  // left for the surveyor to assign via "Insert from scan".
  if ((!out.model || !out.serial)) {
    for (let i = 0; i < lines.length - 1; i++) {
      const header = lines[i].toUpperCase();
      if (/MODEL/.test(header) && /SERIAL/.test(header)) {
        const modelFirst = header.indexOf('MODEL') < header.indexOf('SERIAL');
        const tokens = lines[i + 1].split(/\s{2,}|\t/).map((t) => t.trim()).filter(Boolean);
        if (tokens.length >= 2) {
          const [a, b] = modelFirst ? tokens : [tokens[1], tokens[0]];
          if (!out.model && looksLikeCode(a)) {
            out.model = a.toUpperCase();
            out.decodeNotes.push('Model read from a combined MODEL/SERIAL header row \u2014 verify');
          }
          if (!out.serial && looksLikeCode(b)) {
            out.serial = b.toUpperCase();
            out.decodeNotes.push('Serial read from a combined MODEL/SERIAL header row \u2014 verify');
          }
        }
        break;
      }
    }
  }

  // If the brand text didn't survive OCR (peeled, painted over, glare), the
  // model nomenclature is the fallback. Never let it override a brand we
  // actually read — a wrong brand selects the wrong serial rules.
  if (!out.make && out.model) {
    const guess = detectBrandFromModel(out.model, category);
    if (guess) {
      out.make = guess;
      out.decodeNotes.push(`Brand inferred from model prefix \u2014 ${guess} \u2014 confirm`);
    }
  }

  // Electrical ratings commonly present. Matched per-line, not against the
  // whole blob — \s* in the old whole-text version happily crossed
  // newlines, so a 3-digit ID number ending a completely different field
  // ("...9260431000") could pair up with the word "VOLTS" starting the
  // NEXT line and get captured as if it were a voltage rating. Scoping each
  // match to one line at a time makes that kind of coincidence structurally
  // impossible. Volts and FLA are searched independently (not requiring
  // both on the same line) since table-laid-out plates commonly put them in
  // separate cells/rows.
  let voltsVal = null, flaVal = null;
  // Numeric forms kept separately from the display strings, for the
  // capacity/electrical cross-check below.
  let voltsNum = null, phaseNum = null, mcaNum = null, rlaNum = null;
  for (const line of lines) {
    if (!voltsVal) {
      const v = line.match(/(\d{3})\s*[\/-]\s*(\d{3})?\s*V\b|(\d{3})\s*V\b/i);
      if (v) voltsVal = v[0].replace(/\s+/g, '');
    }
    if (!flaVal) {
      const f = line.match(/(?:FLA|RLA|AMPS?)[.:\s]*(\d{1,4}(?:\.\d)?)/i);
      if (f) flaVal = `${f[1]}A`;
    }
    if (voltsNum == null) {
      // A bare "208/230" cell (no V suffix) is the overwhelmingly common
      // table form; the display regex above requires the V and misses it.
      const v2 = line.match(/\b(\d{3})\s*(?:Y)?\s*[\/-]\s*\d{3}\b/) || line.match(/\b(\d{3})\s*V\b/i);
      if (v2) voltsNum = parseInt(v2[1], 10);
    }
    if (phaseNum == null) {
      const ph = line.match(/\b([13])\s*(?:PH|PHASE)\b/i);
      if (ph) phaseNum = parseInt(ph[1], 10);
      else if (/^\s*PHASE\s*$/i.test(line)) phaseNum = null; // bare label, value is elsewhere
    }
    if (mcaNum == null) {
      const m = line.match(/(?:MIN(?:IMUM)?\.?\s*(?:CKT|CIRCUIT)\s*AMPACITY|MCA|MIN\.?\s*AMPACITY)[.:\s]*(\d{1,4}(?:\.\d)?)/i);
      if (m) mcaNum = parseFloat(m[1]);
    }
    // RLA is compressor-only, so electric heat can't distort it — the
    // preferred input to the capacity cross-check when the plate has it.
    if (rlaNum == null) {
      const r = line.match(/\b(?:RLA|RATED\s*LOAD\s*AMPS)[.:\s]*(\d{1,4}(?:\.\d)?)/i);
      if (r) rlaNum = parseFloat(r[1]);
    }
  }
  // Table layouts put the label and its number in separate cells, so the
  // same-line regexes above find the label and no value. Fall back to the
  // line immediately following a bare MCA/PHASE label.
  for (let i = 0; i < lines.length - 1; i++) {
    if (mcaNum == null && /^(MIN\.?\s*(CKT|CIRCUIT)\s*AMPACITY|MCA)$/i.test(lines[i].replace(/[.:]/g, '').trim())) {
      const n = lines[i + 1].match(/^(\d{1,4}(?:\.\d)?)$/);
      if (n) mcaNum = parseFloat(n[1]);
    }
    if (phaseNum == null && /^PHASE$/i.test(lines[i].replace(/[.:]/g, '').trim())) {
      const n = lines[i + 1].match(/^([13])$/);
      if (n) phaseNum = parseInt(n[1], 10);
    }
    if (rlaNum == null && /^RLA$/i.test(lines[i].replace(/[.:]/g, '').trim())) {
      const n = lines[i + 1].match(/^(\d{1,4}(?:\.\d)?)$/);
      if (n) rlaNum = parseFloat(n[1]);
    }
  }
  const elec = [voltsVal, flaVal].filter(Boolean).join(' \u00b7 ');

  // Tonnage/gallons from model — brand-aware and category-dispatching, so
  // 'waterheater' correctly runs the gallons decode instead of always
  // running the HVAC-only tonnage one (which is what this called before,
  // silently leaving every water heater's capacity blank even when the
  // model and brand were both read correctly — the gallons path was simply
  // never reached). VAV and backflow have their own capacity fields below,
  // not a tons/gallons number, so this is skipped for them.
  if (out.model && category !== 'vav' && category !== 'backflow') {
    const c = decodeCapacity(out.model, category || 'hvac', out.make || undefined);
    if (c) {
      out.capacity = c.label;
      const kind = c.kind === 'gallons' ? 'Capacity' : 'Tonnage';
      // A generic hit and a nomenclature-anchored hit are not the same
      // claim and must not read the same on screen. The old note said
      // "decoded from model code NNN (high confidence)" for both, so an
      // unanchored coincidence was presented to the surveyor in exactly
      // the language reserved for a manufacturer-documented decode.
      out.decodeNotes.push(
        c.generic
          ? `${kind} guessed from an unanchored digit match in the model (${c.confidence} confidence) \u2014 no verified nomenclature for this brand, confirm at the unit`
          : `${kind} decoded from model code ${c.code} (${c.confidence} confidence) \u2014 verify`
      );
      // Second opinion from a DIFFERENT field on the same plate. Every
      // capacity decode reads the model number, so a bad nomenclature rule
      // has nothing to contradict it — which is how a 20-ton rooftop came
      // back as 2 tons with full confidence. Minimum circuit ampacity is
      // set by the actual compressor load, so it disagrees loudly when the
      // decoded size is off by an order of magnitude.
      if (c.kind === 'tons') {
        const sanity = sanityCheckCapacity({ tons: c.value, volts: voltsNum, phase: phaseNum, mca: mcaNum, rla: rlaNum });
        if (sanity && sanity.ok === false) {
          out.capacityConflict = sanity;
          out.decodeNotes.push(`\u26a0 ${sanity.note}`);
        }
      }
    }
  }
  if (!out.capacity && elec) out.capacity = elec;
  else if (elec) out.capacity += ` \u00b7 ${elec}`;

  // VAV / air terminal: the decodable field is INLET SIZE (inches), not
  // tonnage — Redd-i and similar terminal-unit plates print it directly.
  // Primary CFM is very often "FIELD SET" rather than a fixed number, so
  // it's not a reliable capacity value to pull automatically.
  if (category === 'vav' && !out.capacity) {
    const inlet = text.match(/INLET\s*SIZE[.:#\s]*(\d{1,2}(?:\.\d)?)/i);
    if (inlet) {
      out.capacity = `${inlet[1]}" inlet`;
      out.decodeNotes.push('Inlet size read directly from plate');
    } else {
      const kw = text.match(/TOTAL\s*KW[.:#\s]*(\d{1,3}(?:\.\d+)?)/i);
      if (kw) {
        out.capacity = `${kw[1]} kW (reheat)`;
        out.decodeNotes.push('Heater kW read directly from plate \u2014 fan-powered/reheat box');
      }
    }
  }

  // Backflow preventer: nominal pipe size + assembly type, both printed
  // directly — there's no manufacturer date-decode scheme comparable to
  // HVAC's for these; a stamped date or test-tag date is the only source.
  if (category === 'backflow' && !out.capacity) {
    const size = text.match(/(\d(?:\s?\d\/\d)?)\s*(?:IN\.?|INCH|")/i);
    const typeMatch = text.match(/\b(RPZ|RP|DC|DCVA|PVB|SVB)\b/);
    out.capacity = [size ? `${size[1]}"` : null, typeMatch ? typeMatch[1] : null].filter(Boolean).join(' \u00b7 ') || out.capacity;
    if (out.capacity) out.decodeNotes.push('Size/type read directly from plate \u2014 confirm assembly type');
  }

  /* ─────────────────── manufacture year ───────────────────
   *
   * Two independent sources, and they are NOT equally trustworthy:
   *
   *   PRINTED   — a date the manufacturer stamped on the plate. Primary
   *               evidence. "MFG DATE 03/2018" is the manufacturer stating
   *               when it built the unit.
   *   DECODED   — a year inferred by applying a reverse-engineered,
   *               brand-specific rule to the serial. Secondary evidence.
   *               Every one of those notes ends in "verify" for a reason:
   *               the rules are undocumented, they change between plants
   *               and model eras, and they are the single largest source of
   *               wrong years in this decoder.
   *
   * This block used to run decoded-first, with a comment explaining that a
   * "real decoded year" should never be displaced by "a plainer literal-date
   * match." That has the epistemics backwards, and it is exactly what the
   * printed-date-beats-serial fixture pins: a plate printed 03/2018 was
   * reported as 2009 because a serial rule said so. Year drives age, which
   * drives remaining useful life, which drives the replace/plan
   * recommendation that ships to the client — so a wrong year is not a
   * cosmetic defect. It is the report telling an owner a unit is nine years
   * older than its manufacturer says it is.
   *
   * When the two sources disagree by more than a year, the disagreement is
   * itself the finding: it usually means a reserialised or replaced unit, a
   * swapped plate, or a decode rule that does not apply to this model era.
   * Reporting one number and silently discarding the other throws away the
   * only available signal that something is wrong. This is the year analogue
   * of sanityCheckCapacity() — an independent second opinion, so that a bad
   * rule has something capable of contradicting it.
   */

  // ── Source A: printed date, in decreasing order of how well anchored it is.
  let printedYear = null;
  let printedNote = null;
  if (smartYear) {
    // Geometry-aware labelled-date pick: handles MM/YYYY, MM/DD/YY, YYYY-MM,
    // month-name forms, and values sitting in the next table cell.
    printedYear = parseInt(smartYear, 10);
    printedNote = 'Mfg date read from a printed DATE field on the plate';
  }
  if (!printedYear) {
    const m = matchDateNear(text, /(?:MFG|MANUF|DATE)[^\d]*((?:19|20)\d{2})/i);
    if (m) {
      printedYear = parseInt(m[1], 10);
      printedNote = 'Mfg year read from a printed date beside an MFG/DATE label';
    }
  }
  if (!printedYear) {
    const d = literalDateField(text);
    if (d) {
      printedYear = d.year;
      printedNote = 'Mfg date read directly from plate (printed DATE field, not decoded)';
    }
  }
  if (printedYear && !(printedYear >= 1970 && printedYear <= new Date().getFullYear() + 1)) {
    printedYear = null;
    printedNote = null;
  }

  // ── Source B: serial decode.
  let decodedYear = null;
  let decoded = null;
  if (out.serial) {
    const y = decodeYearFromSerial(out.serial, out.make, category);
    // y.year is null when the brand is known but has no verified rule. Guard
    // it: String(null) writes the literal text "null" into the year field and
    // it looks like a real answer on the report.
    if (y && y.year) {
      decoded = y;
      decodedYear = y.year;
    } else if (y && y.noRule) {
      out.decodeNotes.push(y.note);
    }
  }

  const pushDecodedNotes = () => {
    if (!decoded) return;
    out.decodeNotes.push(`Mfg year decoded from serial — ${decoded.note} (${decoded.confidence} confidence) — verify`);
    if (decoded.ambiguous) {
      const alts = [...new Set([
        ...(decoded.altYears || []),
        ...(decoded.alternates || []).map((a) => a.year),
      ])].filter((v) => v && v !== decoded.year);
      if (alts.length) out.decodeNotes.push(`Serial is ambiguous — could also be ${alts.join(', ')} — confirm at the unit`);
    }
  };

  if (printedYear && decodedYear) {
    out.year = String(printedYear);
    if (Math.abs(printedYear - decodedYear) > 1) {
      out.yearConflict = { printed: printedYear, decoded: decodedYear };
      out.decodeNotes.push(
        `Mfg year CONFLICT — the plate is printed ${printedYear} but the serial decodes to ${decodedYear}. ` +
        `Using the printed date. A gap this size usually means a replaced or reserialised unit, ` +
        `or a serial rule that does not apply to this model era — confirm at the unit.`
      );
      pushDecodedNotes();
    } else {
      out.decodeNotes.push(`${printedNote} — serial decode agrees (${decodedYear})`);
    }
  } else if (printedYear) {
    out.year = String(printedYear);
    out.decodeNotes.push(printedNote);
  } else if (decodedYear) {
    out.year = String(decodedYear);
    pushDecodedNotes();
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
