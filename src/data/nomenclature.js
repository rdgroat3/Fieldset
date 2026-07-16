// Nomenclature decode dictionary.
// Nameplate make/model/serial/year/tonnage decoding now lives in hvacDecode.js;
// parseNameplateText below is the OCR-text front end for it. Pipe-size tables
// (unrelated) remain here.

import { decodeTonnageFromModel, decodeYearFromSerial, detectBrand, detectBrandFromModel } from './hvacDecode';

// Generic field extraction from raw OCR lines. Return shape is unchanged
// (make/model/serial/capacity/year/decodeNotes) so existing callers keep working;
// the decode logic now runs through the shared hvacDecode engine.
// `category` is optional and defaults to undefined (search every brand), which
// is what the old single-arg callers effectively did.
export function parseNameplateText(rawText, category) {
  const text = rawText || '';
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  const out = { make: '', model: '', serial: '', capacity: '', year: '', decodeNotes: [] };

  // Brand
  out.make = detectBrand(text, category) || '';

  // Model / Serial via labeled lines first
  for (const line of lines) {
    const mdl = line.match(/(?:MODEL|MOD|M\/N|MDL)[.:#\s]*([A-Z0-9][A-Z0-9\-\/]{3,})/i);
    if (mdl && !out.model) out.model = mdl[1].toUpperCase();
    const ser = line.match(/(?:SERIAL|SER|S\/N|SN)[.:#\s]*([A-Z0-9][A-Z0-9\-]{3,})/i);
    if (ser && !out.serial) out.serial = ser[1].toUpperCase();
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

  // Electrical ratings commonly present
  const volts = text.match(/(\d{3})\s*[\/-]\s*(\d{3})?\s*V|(\d{3})\s*V/i);
  const fla = text.match(/(?:FLA|RLA|AMPS?)[.:\s]*(\d{1,4}(?:\.\d)?)/i);
  const elec = [volts ? volts[0].replace(/\s+/g, '') : null, fla ? `${fla[1]}A` : null].filter(Boolean).join(' \u00b7 ');

  // Tonnage from model — brand-aware now, so position-anchored rules apply
  // instead of a generic three-digit scan.
  if (out.model) {
    const t = decodeTonnageFromModel(out.model, out.make || undefined);
    if (t) {
      out.capacity = t.label;
      out.decodeNotes.push(`Tonnage decoded from model code ${t.code} (${t.confidence} confidence) \u2014 verify`);
    }
  }
  if (!out.capacity && elec) out.capacity = elec;
  else if (elec) out.capacity += ` \u00b7 ${elec}`;

  // Year from serial
  if (out.serial) {
    const y = decodeYearFromSerial(out.serial, out.make, category);
    // y.year is null when the brand is known but has no verified rule. Guard
    // it: String(null) writes the literal text "null" into the year field and
    // it looks like a real answer on the report.
    if (y && y.year) {
      out.year = String(y.year);
      out.decodeNotes.push(`Mfg year decoded from serial \u2014 ${y.note} (${y.confidence} confidence) \u2014 verify`);
      if (y.ambiguous) {
        const alts = [...new Set([
          ...(y.altYears || []),
          ...(y.alternates || []).map((a) => a.year),
        ])].filter((v) => v && v !== y.year);
        if (alts.length) out.decodeNotes.push(`Serial is ambiguous \u2014 could also be ${alts.join(', ')} \u2014 confirm at the unit`);
      }
    } else if (y && y.noRule) {
      out.decodeNotes.push(y.note);
    }
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
