// ─────────────────────────────────────────────────────────────────────────
// SMART NAMEPLATE FIELD ASSIGNMENT
//
// parseNameplateText's label-anchored regexes work when the OCR text happens
// to arrive in reading order — and nameplates being bordered tables read by
// ML Kit, it very often doesn't. Blocks come back column-interleaved, so
// "MODEL NUMBER" and its value can land many lines apart in the flat text
// even though they're 20px apart on the plate. That's the root cause of
// "the info is there but lands in the wrong field / no field".
//
// This module attacks it from two independent directions and merges:
//
//  1. GEOMETRY. ML Kit gives every line a bounding box. A bare label's value
//     is the nearest plausible line to its RIGHT (same row of the table) or
//     directly BELOW it (stacked cell) — measured in pixels, immune to the
//     flat-text ordering problem entirely.
//
//  2. NOMENCLATURE. The decode DB already knows what each brand's model
//     numbers LOOK like (modelPrefixes) and what its serials LOOK like
//     (serialRules regexes). A token that matches Trane's model nomenclature
//     IS the model, label or no label; a token that decodes to a plausible
//     year under the detected brand's serial rules IS the serial. Faded,
//     peeled, or glare-eaten labels stop mattering.
//
// Every signal contributes to a per-field candidate score; the winner is
// auto-assigned only above a threshold, and the full ranked candidate list
// is returned so the UI's "Insert from scan" can offer best-guesses first
// instead of a flat wall of raw lines.
//
// OCR confusion repair: serials/models get re-tested with the classic
// O↔0 / I↔1 swaps when the raw token doesn't match — a Carrier serial that
// OCR read as "3O14X12345" still decodes, flagged "corrected — verify".
// ─────────────────────────────────────────────────────────────────────────

import { DECODE_DB, CONFIRMED_FIELD_MODELS } from './decodeDB.js';
import { detectBrand, decodeSerialCandidates } from './hvacDecode.js';

/* ───────────────────────── label lexicon ───────────────────────── */

// Anchored at line start. [O0] / [I1l] tolerate the most common OCR
// misreads of the label words themselves ("M0DEL", "SER1AL").
//
// A trailing \b fails to fire when OCR drops the space between a label
// and a digit-led value ("SERBAL71604246") — the last label character and
// the first value character are both \w, so no boundary exists there even
// though a human reads it as two distinct tokens. LABEL_END accepts either
// a real word boundary OR a straight transition into a digit run, which
// covers that recurring glued-label case without loosening the label
// match itself.
const LABEL_END = '(?=\\b|\\d)';
const MODEL_LABEL = new RegExp(`^\\s*(M[O0]DE?L|M\\/N|MDL|M[O0]D)${LABEL_END}`, 'i');
// SER[BR]AL tolerates the I->B misread that shows up on stamped/embossed
// plates where OCR's clean confusion table (O/0, I/1) doesn't cover the
// glyph shape well enough — B and I share enough of a stroke pattern under
// glare/skew that this specific misread recurs across scans.
const SERIAL_LABEL = new RegExp(`^\\s*(SER[I1lB]AL|S\\/N|SN|SER)${LABEL_END}`, 'i');
const DATE_LABEL = /^\s*(MFG\.?\s*DATE|MF[GD]\b|MANUF\w*(\s*DATE)?|DATE\s*OF\s*MAN\w*|D\.?O\.?M\.?|PROD\w*\s*DATE|BUILD\s*DATE|DATE)\b/i;

// Trailing label filler after the anchor word: "NO." "NUMBER" "#" ":" etc.
// Whitespace is allowed BETWEEN repetitions (not just around the whole
// run) because OCR routinely renders "MOD. NO." as two separate tokens
// with a real space in between — the old version only consumed the first
// token and left ". NO. " (or similar) stuck to the front of the value.
// "BER" is included as a tail token because OCR routinely splits "NUMBER"
// across two lines/blocks on a bordered plate ("Num" + "ber"), leaving the
// second half's fragment sitting right in front of the real value with no
// other marker distinguishing it from part of the value itself.
const LABEL_TAIL = /^(?:\s*(?:N[O0]\.?|NUMBER|NUM|BER|#|:|\.|\/))*\s*/i;

// Words that mean a token is part of a label, not a value.
// "PRODUCT" is deliberately included here even though some Carrier/Bryant
// plates print a real, DIFFERENT value next to it (Product No. is the
// factory SKU, distinct from Model No.) — this list only governs "is this
// word part of a value token", not "should we ever read a Product No.
// field", so including it just stops "PRODUCT" from being swept into an
// adjacent value string. It does not stop Product No. from being read on
// its own where a future field explicitly wants it.
const LABELY = /^(M[O0]DE?L|SER[I1l]AL|N[O0]\.?|NUMBER|NUM|ITEM|PART|PRODUCT|DATE|MFG|MFD|MANUF\w*|CIRCUIT|MADE|V[O0]LTS?|PHASE|WATTS?|AMPS?|HERTZ|HZ|CAPACITY|RATING|TYPE|SIZE|CAT|REF|CHARGE|DESIGN|PRESSURE|TEST|MAX|MIN|UNIT)$/i;

const stripLabel = (line, labelRe) => {
  const m = line.match(labelRe);
  if (!m) return null;
  let rest = line.slice(m.index + m[0].length);
  rest = rest.replace(LABEL_TAIL, '');
  return truncateAtNextLabel(rest.trim());
};

// Multi-word labels ("Serial Number") routinely get OCR'd as their own
// short line when a bordered plate wraps the label across the cell —
// "Serlal" / "Num" / "ber". A neighboring geometry pick (valueToRight /
// valueBelow) has no way to know "ber" is label debris rather than the
// start of the value, because it's reading a WHOLE candidate line, not
// text immediately following an anchored label match. Strip any leading
// run of short label-continuation fragments (a handful of bare letters
// with no digits, i.e. not a code) before the value is scored — this is
// deliberately narrower than LABEL_TAIL: it only eats a leading ALPHA-ONLY
// fragment of 4 or fewer letters, which real model/serial values almost
// never start with (they're either digit-led or a long alpha run).
// A label word running straight into a digit-led value with no separator,
// e.g. "SERIAL71604246" / "MODELNO48TCED08". Returns just the value part.
const GLUED_LABEL = /^(?:M[O0]DE?L|SER[I1lB]AL|MDL|M\/N|S\/N|SN|SER|PART|CAT)(?:N[O0]|NUMBER|NUM)?[.:#]?(?=\d)/i;
function stripGluedLabel(s) {
  const t = String(s || '').trim();
  const m = t.match(GLUED_LABEL);
  return m ? t.slice(m[0].length) : t;
}

// Label debris is a FRAGMENT OF A LABEL WORD, not merely any short word.
//
// This used to strip any leading alpha run of 4 or fewer letters, on the
// stated reasoning that "real model/serial values almost never start with"
// one. Measured against the corpus, that claim is wrong often enough to
// matter: Patterson-Kelley's "MACH C-2000" was being reported as "C-2000",
// and the same rule would eat the lead word of Grundfos "CR 15-4",
// Weil-McLain "EG 45", Lochinvar "KN 6" and Bell & Gossett "VSX 6".
//
// A model number truncated at the FRONT is worse than one left alone. It
// matches no catalog, so nobody downstream can price the unit or cross-
// reference a part, and it reads like a transcription the surveyor fumbled.
//
// The real signal is narrower than word length. OCR debris is a piece of a
// label word that got split ("Num" + "ber" out of NUMBER, "Serlal" out of
// SERIAL), so match those pieces explicitly.
const LABEL_FRAGMENT_WORDS = new RegExp(
  '^(?:' + [
    'NUM', 'NUMB', 'BER', 'MBER', 'UMBER',
    'MOD', 'MODE', 'DEL', 'ODEL',
    'SER', 'SERI', 'SERL', 'IAL', 'RIAL', 'ERIAL',
    'N[O0]', 'NR',
    'DAT', 'ATE', 'DATE',
    'PART', 'CAT', 'REF',
  ].join('|') + ')$', 'i'
);
const LEADING_LABEL_FRAGMENT = /^([A-Za-z]{1,5})\s+(?=\S)/;
function stripLeadingLabelFragment(s) {
  const t = String(s || '').trim();
  const m = t.match(LEADING_LABEL_FRAGMENT);
  if (!m) return t;
  const head = m[1];
  // A real code fragment like "H2A" is never label debris.
  if (/\d/.test(head)) return t;
  // Only strip pieces of an actual label word. Anything else belongs to the
  // value, even when it is short.
  if (!LABEL_FRAGMENT_WORDS.test(head)) return t;
  const rest = t.slice(m[0].length).trim();
  return looksLikeValue(rest) ? rest : t;
}

// Bordered-table nameplates routinely get OCR'd as ONE physical row spanning
// several cells jammed onto a single flat-text line — "MOD. NO. 2A7A1024A1000AA
// VOLTS" is really two cells ("MODEL NO." + value, "VOLTS" + its own value)
// that a table-blind OCR line-grouper glued together. Reading the label at
// the front is fine; blindly keeping EVERYTHING after it is not — the next
// column's label word rides along and gets appended to the value, silently
// corrupting it ("2A7A1024A1000AA VOLS"). Stop at the first word that looks
// like another field's label instead of accepting the whole remainder.
// The FIRST word is always kept even if it happens to match LABELY — that
// word is the one immediately after the label we already anchored on, and a
// real (if unlucky) value token is far likelier there than a second label.
function truncateAtNextLabel(rest) {
  if (!rest.includes(' ')) return rest;
  const words = rest.split(/\s+/);
  const out = [words[0]];
  for (let i = 1; i < words.length; i++) {
    const bare = words[i].replace(/[.:#]/g, '');
    if (LABELY.test(bare)) break;
    out.push(words[i]);
  }
  return out.join(' ');
}

/* ───────────────────────── value plausibility ───────────────────────── */

// Cheap shape test for "could be a model/serial value at all".
// Trailing unit abbreviations that commonly ride along with a spec number
// on nameplates (pressures, currents, weights, etc). A number-plus-unit
// fragment like "4826 KPA" or "8.19 LBS" is legitimate nameplate text but
// is a SPEC VALUE, not a model/serial candidate — without this filter it
// passes the generic code-shape regex below (digits + letters + a space)
// and can get scored as a serial purely because the leading digits happen
// to decode to a plausible year under some brand's rule.
const TRAILING_UNIT = /\s(KPA|PSIG?|PSI|LBS?|KG|AMPS?|VOLTS?|WATTS?|HZ|MPA|OZ|GAL|CFM|BTU\w*|HP|TONS?|IN|MM|CM)$/i;

// A full ISO-ish calendar date (YYYY-MM-DD or YYYY/MM/DD) embedded in a
// token is a timestamp, not an equipment code — nameplates don't print
// serials or models in that shape, but screenshot/UI chrome that leaks
// into a scan (browser timestamps, gallery metadata) routinely does.
const EMBEDDED_CALENDAR_DATE = /\b(19|20)\d{2}[\-\/](0[1-9]|1[0-2])[\-\/](0[1-9]|[12]\d|3[01])\b/;

/* ───────────────────── negative evidence: rating tokens ─────────────────
 *
 * The single biggest source of wrong field assignments, and the one the
 * corpus caught immediately: most of a nameplate's SURFACE AREA is the
 * electrical ratings table, not the identification block. Those cells are
 * short alphanumeric tokens sitting in exactly the same geometric
 * relationship to their labels as a model number does to "MODEL NO." —
 * so every geometry and shape heuristic in this module treats them as
 * equally plausible values, and there are ten to twenty of them per plate
 * against one real model number.
 *
 * The measured failure: a plate cropped to just the ratings table returned
 * "50HZ" as the MODEL, auto-assigned above threshold. "50HZ" is code-shaped
 * (letters + digits), it isn't a bare label word, and it satisfies Carrier's
 * model-prefix pattern (family code "50" followed by two letters) — every
 * positive signal agreed, because nothing in the module was looking for
 * reasons to say no.
 *
 * These patterns are deliberately anchored and specific. A rejection list
 * that is too broad silently eats real model numbers, which is a worse
 * failure than the one it fixes, so each entry describes a token shape that
 * cannot be a model or serial rather than one that merely often isn't.
 */
const RATING_TOKENS = [
  // Frequency: 50HZ, 60 HZ, 50/60HZ
  /^\d{2}(\/\d{2})?\s*(HZ|HERTZ)$/i,
  // Supply voltage in every common plate form: 208/230, 208Y/120, 460/3/60,
  // 115/1/60, 277/480. Also control voltage: 24V, 24VAC, 24 VDC.
  /^\d{2,3}(Y)?(\/\d{1,3}){1,3}$/i,
  /^\d{1,3}\s*V(AC|DC)?$/i,
  // Phase / wire notations: 1PH, 3PH, 3PHASE, 3W, 4W, 1PH60HZ
  /^\d\s*(PH|PHASE|W)$/i,
  /^\d\s*PH\s*\d{2}\s*HZ$/i,
  // Refrigerants — R-22, R410A, R-454B, HCFC-22, HFC-410A, A2L
  /^(R|HCFC|HFC|HFO)\s*-?\s*\d{2,3}[A-Z]?$/i,
  /^A[123][L]?$/i,
  // Agency listings and standards. These carry file numbers that look
  // exactly like serials: ETL 3068422, UL 1995, CSA C22.2, AHRI 210/240.
  /^(UL|CUL|CSA|ETL|AHRI|ARI|NOM|CE|IEC|ASHRAE|ANSI|NSF)\b/i,
  /^C\d{2}\.\d/i,                       // C22.2
  // Current / power / pressure ratings when glued to their unit with no
  // space (TRAILING_UNIT below only catches the spaced form).
  /^\d+(\.\d+)?\s*(A|AMP|AMPS|FLA|RLA|LRA|MCA|MOCP|W|KW|HP|BTU|MBH|TON|TONS|PSI|PSIG|KPA|LBS?|KG|CFM|GPM|RPM|AWG)$/i,
  // Bare numbers that are ratings, not codes. A model number is never a
  // lone 1-4 digit run; a serial never is either.
  /^\d{1,4}$/,
  /^\d{1,4}\.\d+$/,
  // Efficiency / rating figures: 13SEER, 11.5EER, 81%
  /^\d+(\.\d+)?\s*(SEER2?|EER|IEER|HSPF2?|AFUE)$/i,
  /^\d+(\.\d+)?%$/,
  // Capture chrome from photographing a screen rather than a plate.
  /^IMG[_-]?\d+$/i,
  /^(DSC|DCIM|PXL|SCREENSHOT)[_-]?\d*$/i,
  /^\d{1,3}%\s*(BATTERY|CHARGED)?$/i,
  // Temperature and time-of-day fragments
  /^-?\d{1,3}\s*(°|DEG)?\s*[CF]$/i,
  /^\d{1,2}:\d{2}(:\d{2})?$/,
];

// True when the token is a nameplate SPEC value rather than an identity
// value. Checked against the whitespace-collapsed form too, because ML Kit
// splits "50 HZ" and "50HZ" unpredictably depending on kerning.
export function isRatingToken(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  const squashed = t.replace(/\s+/g, '');
  return RATING_TOKENS.some((re) => re.test(t) || re.test(squashed));
}

export const looksLikeValue = (s, { requireDigit = true } = {}) => {
  const t = String(s || '').trim();
  if (t.length < 3 || t.length > 26) return false;
  if (!/^[A-Z0-9]/i.test(t)) return false;
  if (LABELY.test(t.replace(/[.:#]/g, '').trim())) return false;
  // A candidate can be MULTIPLE label words strung together ("PRODUCT
  // NUMBER", "SERIAL NO") — none of which individually reach the check
  // above because that only tests the whole string as ONE label word.
  // A neighboring cell's label (not its value) getting picked up by
  // valueBelow/valueToRight is exactly this shape: every word present is
  // a label word and nothing else. Reject only when EVERY word matches —
  // a real value that happens to start or end with a label-ish word
  // ("MODEL A200X") still has a non-label word carrying real information
  // and must not be thrown out.
  if (t.includes(' ')) {
    const words = t.split(/\s+/).map((w) => w.replace(/[.:#]/g, ''));
    if (words.length > 1 && words.every((w) => LABELY.test(w))) return false;
  }
  if (TRAILING_UNIT.test(t)) return false;
  if (EMBEDDED_CALENDAR_DATE.test(t)) return false;
  // Nameplate SPEC values (voltage, frequency, refrigerant, agency file
  // numbers, capture chrome). These are the majority of a plate's text and
  // they satisfy every positive shape test below, so without an explicit
  // rejection they outnumber the one real model number ten to one.
  if (isRatingToken(t)) return false;
  // Must be code-shaped throughout (letters/digits/-/.//, internal spaces ok).
  if (!/^[A-Z0-9][A-Z0-9\-\/. ]{2,}$/i.test(t)) return false;

  // A model or serial contains at least one digit. Effectively without
  // exception — capacity, series and sequence are all numeric fields, and a
  // manufacturer that shipped an all-letter model number would have no way
  // to enumerate its own catalog.
  //
  // This one condition removed six of the fourteen junk candidates the
  // corpus was surfacing, all of the same shape: an adjacent cell's LABEL
  // being read as if it were a value. "REFRIGERANT", "IMPELLER",
  // "CONTROL CIRCUIT", "INPUT MBH", "INTERNATIONAL". None are in LABELY —
  // that list can only ever cover words someone thought to add, and every
  // manufacturer invents new ones. Requiring a digit is a property of what
  // a model number IS, so it generalises to the labels nobody has seen yet.
  //
  // `requireDigit: false` is used only for a value found INLINE after an
  // explicit MODEL/SERIAL label on the same line, where the label itself is
  // the evidence and the shape test is just a sanity check.
  if (requireDigit && !/\d/.test(t)) return false;

  // Pure alphabetic 3-4 letter words ("FOR", "WITH") aren't codes.
  if (/^[A-Z]{3,4}$/i.test(t) && !/\d/.test(t)) return false;
  return true;
};

/* ───────────────────────── barcode detection ─────────────────────────
 *
 * A UPC-A (12 digit) or EAN-13 barcode number printed under the serial is
 * a long, clean, digit-only run sitting in the identification block — the
 * single most serial-looking thing on the plate that isn't the serial. The
 * shape heuristics actively PREFER it (Pass 3 gives a bonus to long
 * all-digit tokens).
 *
 * Both formats carry a mod-10 check digit, so this is a real test rather
 * than a guess about length. A genuine serial has a 1-in-10 chance of
 * passing by coincidence, which is why this only DEMOTES the candidate
 * instead of dropping it: a barcode should lose to a label-anchored serial
 * and win against nothing.
 */
function isBarcodeNumber(s) {
  const d = String(s || '').replace(/\s/g, '');
  if (!/^\d{12,13}$/.test(d)) return false;
  const digits = d.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  // Weights alternate 3/1 from the rightmost body digit leftwards.
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += digits[i] * w;
  }
  return (10 - (sum % 10)) % 10 === check;
}

const compact = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');

/* ───────────────────────── OCR confusion repair ───────────────────────── */

// Two conservative variants only: everything-ambiguous-to-digits and
// everything-ambiguous-to-letters. A cartesian product of per-character
// swaps explodes and starts "finding" matches that were never on the plate.
// G<->6 and Z<->2 added after field photos showed both in the wild (a
// Trane/American Standard "2A7A1024A1000AA" read back as "ZA7A..." and an
// ICP "N4A336AKB200" read back as "N4A33GAKB200") — same class of confusion
// as O/0 and I/1, just two more glyph pairs a condensed or worn stamped
// font routinely blurs together.
const toDigits = (s) => s.replace(/O/g, '0').replace(/[Il]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/G/g, '6').replace(/Z/g, '2');
const toLetters = (s) => s.replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B').replace(/6/g, 'G').replace(/2/g, 'Z');

const charDiff = (a, b) => {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

// How much of a token a "repair" may rewrite before the result stops being
// a correction and starts being a different string.
//
// A flat edit count is the wrong measure and breaks a real case: a serial
// read as "I62IIKAT2F" needs THREE I->1 substitutions, and that is entirely
// plausible — in a font where I and 1 are near-identical, OCR misreads
// every one of them the same way, so consistent repeated substitution is
// evidence FOR the repair, not against it.
//
// What actually distinguishes repair from destruction is the PROPORTION
// rewritten. toDigits/toLetters rewrite every ambiguous character at once,
// so on a digit-heavy code they can rewrite most of it: "D1EE060N06525C"
// becomes "DIEEOGONOGSZSC", nine of fourteen characters, which measurably
// reached the Best Guesses list as a serial option. Nobody can check that
// against a plate.
//
// 40%, with a floor of 2 so short tokens aren't over-constrained, separates
// the two cleanly: 3-of-10 passes, 9-of-14 does not.
const maxRepairEdits = (len) => Math.max(2, Math.ceil(len * 0.4));

/**
 * Try fn on the raw token, then on repaired variants.
 * Returns { value, result, corrected } or null.
 *
 * `value` is what will be OFFERED to the surveyor, and that is the subtle
 * part. A blanket toLetters() of "D1EE060N06525C" produces
 * "DIEEOGONOGSZSC" — which measurably reached the Best Guesses list as a
 * serial candidate. It is unreadable, it is not on the plate, and it is
 * sitting in a list the surveyor is being asked to choose from.
 *
 * So a repaired variant is only offered when the repair rewrites a small
 * enough PROPORTION of the token to be a plausible misread (see
 * maxRepairEdits). Beyond that the hypothesis is still worth testing — the
 * match may well be real — but what gets shown is the token as actually
 * read, with the correction noted rather than substituted.
 */
function withRepair(token, fn) {
  const raw = fn(token);
  if (raw) return { value: token, result: raw, corrected: false };
  for (const v of [toDigits(token), toLetters(token)]) {
    if (v === token) continue;
    const r = fn(v);
    if (!r) continue;
    const edits = charDiff(token, v);
    if (edits <= maxRepairEdits(token.length)) {
      return { value: v, result: r, corrected: true, edits };
    }
    // Match found, but only by rewriting the token beyond recognition.
    // Keep the evidence, show what was actually read.
    return { value: token, result: r, corrected: true, edits, unreliable: true };
  }
  return null;
}

/* ───────────────────────── known-model fuzzy match ───────────────────────── */
//
// Brand modelPrefixes are deliberately unanchored at the END (real models
// have wildly variable-length suffixes), which means a token can match a
// brand's prefix trivially even when a LATER character is OCR-garbled —
// "N4A33GAKB200" starts with ICP's "N4A" prefix just fine, so the ordinary
// nomenclature check above "succeeds" on the raw corrupted string and never
// gets a chance to clean it up. Separately, some OCR errors are insertions
// or deletions ("N4A336GAKB200", an extra character) that the character-
// substitution repair above structurally cannot fix at all — there's no
// single swapped glyph to un-swap.
//
// Both are the same underlying situation: an OCR token is close to, but not
// exactly, a model this module has ALREADY seen confirmed on a real
// nameplate (CONFIRMED_FIELD_MODELS in decodeDB.js). A small edit-distance
// check against that corpus catches both cases without guessing — every
// anchor is a real, physically-confirmed model number, not a synthesized
// pattern, so a match here is evidence, not a coincidence-prone regex.
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    const cur = [i];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[bl];
}

// Same known glyph-confusion pairs as the repair pass above, but checked
// POSITION BY POSITION against the original string rather than via a
// blanket whole-string transform. That distinction matters: toDigits/
// toLetters rewrite EVERY ambiguous character at once, so a string with
// two different ambiguous characters that need opposite treatment (a "G"
// that should become "6" two, but a genuine "B" that must stay "B") gets
// the second one wrongly flipped too ("N4A33GAKB200" -> toDigits also
// turns the real "B" into "8", producing "N4A336AK8200" — still wrong).
// Checking per-position means only the actual differences have to be
// individually explainable by a known confusion, so a correct nearby
// character is never collaterally "corrected" into a new mistake.
const CONFUSABLE_PAIRS = new Set(['O0', '0O', 'I1', '1I', 'L1', '1L', 'S5', '5S', 'B8', '8B', 'G6', '6G', 'Z2', '2Z']);
function confusionExplainedMatch(token, anchor) {
  if (token.length !== anchor.length) return false;
  for (let i = 0; i < token.length; i++) {
    const a = token[i], b = anchor[i];
    if (a === b) continue;
    if (!CONFUSABLE_PAIRS.has(a + b)) return false;
  }
  return true;
}

// Best confirmed-model match for `token`, or null. Checked in order of
// how much trust each level deserves:
//   1. Exact match (dist 0) — the token IS a model we've confirmed.
//   2. Confusion-explained (dist 0-equivalent) — every differing
//      character is a known OCR glyph confusion, checked per-position, so
//      this is effectively certain even though the raw bytes differ.
//   3. Levenshtein <= 1-2 — a genuine fuzzy miss (usually an inserted or
//      dropped character), real evidence but never auto-assigned.
function knownModelMatch(token, category) {
  const t = compact(token);
  let best = null;
  for (const ref of CONFIRMED_FIELD_MODELS) {
    if (category && ref.category !== category) continue;
    const anchor = compact(ref.model);
    if (t === anchor) return { brand: ref.brand, model: ref.model, dist: 0, explained: false };
    if (confusionExplainedMatch(t, anchor)) {
      if (!best || best.dist > 0) best = { brand: ref.brand, model: ref.model, dist: 0, explained: true };
      continue;
    }
    if (Math.abs(anchor.length - t.length) > 2) continue; // cheap prefilter
    const maxDist = anchor.length >= 14 ? 2 : 1; // longer strings tolerate one more edit
    const d = levenshtein(t, anchor);
    if (d <= maxDist && (!best || d < best.dist)) {
      best = { brand: ref.brand, model: ref.model, dist: d, explained: false };
    }
  }
  return best;
}

/* ───────────────────────── geometry helpers ───────────────────────── */

// ML Kit gives each LINE a `cornerPoints` quadrilateral (4 points) alongside
// its axis-aligned `frame`. When the camera wasn't held dead-level to the
// plate — extremely common in the field: equipment mounted overhead, plates
// wedged in tight electrical rooms, awkward angles because the surveyor is
// standing on a ladder — every line is rotated a few (or many) degrees in
// the photo. The axis-aligned frame then LIES about which lines share a row
// or column: two cells that are level with each other on the physical plate
// land at different pixel `top` values once the whole plate is tilted in
// frame, which is a direct, confirmed cause of "value assigned to the wrong
// field" independent of anything OCR itself got wrong.
//
// Fix: derive each line's rotation from its own corner quadrilateral (angle
// of its longest edge — ordering-agnostic, so it doesn't matter whether ML
// Kit's points start top-left or bottom-right), take the robust (median)
// rotation across the whole plate, and when that's non-trivial, work in
// DEROTATED coordinates for every row/column comparison instead of raw
// pixel top/left. A perfectly level photo measures ~0 degrees and this is a
// no-op.
function edgeAngleDeg(cp) {
  if (!cp || cp.length !== 4) return null;
  let best = null, bestLen = -1;
  for (let i = 0; i < 4; i++) {
    const a = cp[i], b = cp[(i + 1) % 4];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    if (len > bestLen) {
      bestLen = len;
      // Normalize to (-90, 90] -- a text line read forwards or the same
      // edge walked backwards should give the same axis, not a 180-flip.
      let deg = Math.atan2(dy, dx) * (180 / Math.PI);
      if (deg <= -90) deg += 180;
      if (deg > 90) deg -= 180;
      best = deg;
    }
  }
  return best;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Rotate a point by -angleDeg around pivot, giving "as if the plate were
// held level" coordinates for row/column comparison. Sizes (width/height)
// are left as-is -- a few degrees of rotation barely changes a line's own
// bounding-box footprint, and re-deriving it isn't worth the complexity.
function derotatePoint(x, y, angleDeg, pivot) {
  const rad = -angleDeg * (Math.PI / 180);
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = x - pivot.x, dy = y - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

// Skew significant enough to bother correcting for. Below this, raw pixel
// math is already accurate and cheaper/more precise than a rotation with no
// real signal behind it (corner-point noise on a level photo shouldn't be
// mistaken for real tilt).
const SKEW_CORRECT_THRESHOLD_DEG = 3.5;

// Flatten ML Kit blocks into positioned lines. Lines without frames are
// kept (geometry passes just skip them). Sorted top-to-bottom, then
// left-to-right, which also becomes a saner "all lines" list for the UI
// than raw block order.
//
// When lines carry `cornerPoints` and the plate is measurably tilted in the
// photo, every line's frame is replaced with a DEROTATED equivalent before
// anything downstream (sort order, valueToRight, valueBelow) ever sees it --
// so "same row" and "to the right" mean what they mean on the physical
// plate, not what they happen to mean in the photo's pixel grid.
export function flattenBlocks(blocks) {
  const out = flattenBlocksRaw(blocks);

  // Robust global rotation estimate from every line that has corner points.
  const angles = out.map((l) => edgeAngleDeg(l.cornerPoints)).filter((a) => a != null);
  const globalAngle = angles.length >= 3 ? median(angles) : 0;

  if (Math.abs(globalAngle) >= SKEW_CORRECT_THRESHOLD_DEG && out.some((l) => l.frame)) {
    const withFrame = out.filter((l) => l.frame);
    const pivot = {
      x: withFrame.reduce((s, l) => s + l.frame.left + l.frame.width / 2, 0) / withFrame.length,
      y: withFrame.reduce((s, l) => s + l.frame.top + l.frame.height / 2, 0) / withFrame.length,
    };
    for (const l of out) {
      if (!l.frame) continue;
      const cx = l.frame.left + l.frame.width / 2;
      const cy = l.frame.top + l.frame.height / 2;
      const r = derotatePoint(cx, cy, globalAngle, pivot);
      l.frame = { left: r.x - l.frame.width / 2, top: r.y - l.frame.height / 2, width: l.frame.width, height: l.frame.height };
    }
  }

  out.sort((a, b) => {
    if (!a.frame || !b.frame) return 0;
    const dy = a.frame.top - b.frame.top;
    // Same visual row → left-to-right.
    if (Math.abs(dy) < Math.min(a.frame.height, b.frame.height) * 0.6) {
      return a.frame.left - b.frame.left;
    }
    return dy;
  });
  return out;
}

// Internal: line-flattening with NO rotation correction and no sort --
// assessCaptureQuality needs the raw per-line angles to detect skew in the
// first place (correcting first would erase the very signal it measures),
// and flattenBlocks above builds on this before correcting + sorting.
function flattenBlocksRaw(blocks) {
  const out = [];
  for (const b of blocks || []) {
    for (const ln of b.lines || []) {
      const text = (ln.text || '').trim();
      if (!text) continue;
      out.push({ text, frame: ln.frame || null, cornerPoints: ln.cornerPoints || null });
    }
  }
  return out;
}

// Capture-quality advisory: tells the UI when a scan is skewed enough that
// no amount of downstream parsing cleverness will reliably fix it, so the
// surveyor gets a "hold the phone level with the plate" prompt BEFORE
// trusting an empty or wrong-looking result. Deliberately conservative
// thresholds -- this should fire on genuinely bad angles, not nudge people
// on every scan.
// Fallback skew estimate using ONLY axis-aligned frame centers — no
// cornerPoints needed at all. A linear regression of each line's vertical
// center against its horizontal center: on a plate laid out as a roughly
// even grid of label/value cells (which nameplates are), a photo taken at
// rotation angle theta introduces a systematic top-vs-left correlation of
// slope ~ tan(theta) across the set of lines. This exists purely as a
// safety net — cornerPoints support in the OCR wrapper is unverified
// against a real device in this pass, so if it ever comes back empty or
// unpopulated in practice, this keeps SOME skew signal alive rather than
// silently going blind. It's much noisier than the cornerPoints method (a
// lopsided plate layout can fool a regression), so it demands a clearly
// bigger angle before it's willing to say anything.
function estimateSkewFromFrameRegression(lines) {
  const pts = lines.filter((l) => l.frame).map((l) => ({
    x: l.frame.left + l.frame.width / 2,
    y: l.frame.top + l.frame.height / 2,
  }));
  if (pts.length < 6) return null;
  const n = pts.length;
  const meanX = pts.reduce((s, p) => s + p.x, 0) / n;
  const meanY = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x - meanX) * (p.y - meanY); den += (p.x - meanX) ** 2; }
  if (den === 0) return null;
  return Math.atan(num / den) * (180 / Math.PI);
}

export function assessCaptureQuality(ocr) {
  const lines = flattenBlocksRaw(ocr?.blocks);
  const angles = lines.map((l) => edgeAngleDeg(l.cornerPoints)).filter((a) => a != null);

  if (angles.length >= 3) {
    const angleDeg = median(angles);
    const spread = Math.max(...angles) - Math.min(...angles);
    // A big median angle means the whole plate is rotated in-frame (fixable --
    // handled above). A big SPREAD with a modest median means individual
    // lines disagree with each other, which is what true keystone/perspective
    // distortion looks like (each line tilts a different amount depending on
    // its position) rather than simple rotation -- that isn't something a 2D
    // rotation can correct, so it's worth a stronger nudge.
    const skewed = Math.abs(angleDeg) >= 12 || spread >= 20;
    const note = !skewed ? null
      : spread >= 20
        ? 'Photo looks taken at a steep angle — hold the phone parallel to the plate and retake for a cleaner read.'
        : 'Plate looks tilted in the photo — level the phone with the plate and retake for a cleaner read.';
    return { skewed, angleDeg: Math.round(angleDeg), spreadDeg: Math.round(spread), note, source: 'cornerPoints' };
  }

  // Fallback path: no (or too few) cornerPoints came back from the OCR
  // engine for this scan. Weaker signal, higher bar before it speaks up.
  const fallbackAngle = estimateSkewFromFrameRegression(lines);
  if (fallbackAngle == null) return { skewed: false, angleDeg: null, note: null, source: null };
  const skewed = Math.abs(fallbackAngle) >= 18;
  const note = skewed
    ? 'Photo may be tilted — hold the phone level with the plate and retake if fields come back empty or wrong.'
    : null;
  return { skewed, angleDeg: Math.round(fallbackAngle), spreadDeg: null, note, source: 'frame-regression' };
}

const centerY = (f) => f.top + f.height / 2;

// Nearest plausible value line to the RIGHT of `lab`, on the same visual row.
//
// `ok` overrides what counts as a plausible value. It exists because the
// generic looksLikeValue() test rejects anything shaped like an electrical
// rating, and a manufacture date is shaped EXACTLY like one: "06/19" is
// indistinguishable from a voltage pair such as "208/230" by shape alone.
// The DATE branch knows it is looking for a date, so it supplies its own
// test rather than being filtered by a rule written to keep ratings out of
// model and serial fields.
function valueToRight(lines, i, ok = looksLikeValue) {
  const lab = lines[i];
  if (!lab.frame) return null;
  let best = null;
  for (let j = 0; j < lines.length; j++) {
    if (j === i) continue;
    const c = lines[j];
    if (!c.frame) continue;
    if (Math.abs(centerY(c.frame) - centerY(lab.frame)) > lab.frame.height * 0.7) continue;
    const gap = c.frame.left - (lab.frame.left + lab.frame.width);
    // Allow slight overlap (borders/kerning), reject far-away columns.
    if (gap < -lab.frame.width * 0.2) continue;
    if (gap > lab.frame.height * 14) continue;
    if (!ok(c.text)) continue;
    if (!best || gap < best.gap) best = { line: c, gap };
  }
  return best?.line || null;
}

// Nearest plausible value line directly BELOW `lab` (stacked table cell).
function valueBelow(lines, i, ok = looksLikeValue) {
  const lab = lines[i];
  if (!lab.frame) return null;
  let best = null;
  for (let j = 0; j < lines.length; j++) {
    if (j === i) continue;
    const c = lines[j];
    if (!c.frame) continue;
    const dy = c.frame.top - (lab.frame.top + lab.frame.height);
    if (dy < -lab.frame.height * 0.3 || dy > lab.frame.height * 2.4) continue;
    const overlap = Math.min(lab.frame.left + lab.frame.width, c.frame.left + c.frame.width)
      - Math.max(lab.frame.left, c.frame.left);
    if (overlap < Math.min(lab.frame.width, c.frame.width) * 0.3) continue;
    if (!ok(c.text)) continue;
    if (!best || dy < best.dy) best = { line: c, dy };
  }
  return best?.line || null;
}

/* ───────────────────────── nomenclature signals ───────────────────────── */

// Does `token` match any brand's model nomenclature? Prefer the brand the
// plate itself named; a match on some OTHER brand's prefix is still a
// candidate (peeled-label case) but scores lower and carries the implied
// brand so the UI can note it.
function modelNomenclatureHit(token, brandName, category) {
  const m = compact(token);
  if (m.length < 4) return null;
  const hitFor = (entry) => {
    if (!entry.modelPrefixes) return false;
    return entry.modelPrefixes.some((re) => re.test(m));
  };
  for (const b of DECODE_DB) {
    if (category && b.category !== category) continue;
    if (brandName && b.name.toLowerCase() === String(brandName).toLowerCase()) {
      if (hitFor(b)) return { brand: b.name, sameBrand: true };
    }
  }
  for (const b of DECODE_DB) {
    if (category && b.category !== category) continue;
    if (hitFor(b)) return { brand: b.name, sameBrand: !brandName ? null : b.name.toLowerCase() === String(brandName).toLowerCase() };
  }
  return null;
}

// Does `token` decode to a plausible year under the brand's serial rules?
function serialNomenclatureHit(token, brandName, category) {
  if (!brandName) return null;
  const t = compact(token);
  if (t.length < 6) return null;
  const cands = decodeSerialCandidates(t, brandName, category);
  return cands.length ? cands[0] : null;
}

/* ───────────────────────── candidate accumulator ───────────────────────── */

const CONF_MULT = { high: 1, medium: 0.85, low: 0.65 };

function makeBag() {
  const bag = new Map(); // normalized value -> { value, score, why:[] }
  return {
    add(value, score, why) {
      const v = String(value).trim();
      if (!v) return;
      const key = compact(v);
      const cur = bag.get(key);
      if (cur) {
        cur.score += score;
        if (why && !cur.why.includes(why)) cur.why.push(why);
        // Prefer the longest surface form seen (keeps internal spaces).
        if (v.length > cur.value.length) cur.value = v;
      } else {
        bag.set(key, { value: v, score, why: why ? [why] : [] });
      }
    },
    ranked() {
      return [...bag.values()].sort((a, b) => b.score - a.score);
    },
  };
}

/* ───────────────────────── date extraction ───────────────────────── */

// Is this string shaped like a date at all? Used as the plausibility gate
// when hunting for the value that belongs to a DATE label, in place of the
// generic looksLikeValue(). Deliberately strict: it must parse to a
// plausible year AND carry no unit suffix, so that a genuine rating sitting
// in the next cell ("50HZ", "8.19 LBS", "4826 KPA") still cannot be read as
// a manufacture date.
const DATE_UNIT_SUFFIX = /\b(HZ|HERTZ|V|VAC|VDC|VOLTS?|A|AMP|AMPS|W|KW|KVA|HP|PSI|KPA|LBS?|KG|GAL|MBH|BTU|CFM|GPM|RPM|IN|MM|TON|TONS)\b/i;
const DATE_SHAPES = [
  /^\d{1,4}([\/\-.]\d{1,4}){0,2}$/,            // 06/19, 03/2018, 2019-06, 11/22/13
  /^[A-Z]{3,9}\.?\s*\d{2,4}$/i,                 // SEP 2015, MARCH 2019
  /^(?:WK|WEEK)\.?\s*\d{1,2}\s*[-\/ ]?\s*\d{2,4}$/i, // WK 38 2015
];
function isDateShaped(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 16) return false;
  if (DATE_UNIT_SUFFIX.test(t)) return false;
  if (!DATE_SHAPES.some((re) => re.test(t))) return false;
  return yearFromDateValue(t) != null;
}

const plausibleYear = (y) => y >= 1970 && y <= new Date().getFullYear() + 1;

function expandYear(n) {
  let y = parseInt(n, 10);
  if (y < 100) y += y > 50 ? 1900 : 2000;
  return y;
}

// Pull a mfg year out of a value string that followed a date-ish label.
// Handles MM/YYYY, YYYY-MM, MM/DD/YY(YY), bare YYYY, and "MAR 2019".
export function yearFromDateValue(s) {
  const t = String(s || '').trim();
  let m = t.match(/\b(19|20)\d{2}\b/);
  if (m) {
    const y = parseInt(m[0], 10);
    if (plausibleYear(y)) return y;
  }
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
  if (m) {
    const y = expandYear(m[3] != null ? m[3] : m[2]);
    if (plausibleYear(y)) return y;
  }
  m = t.match(/^(\d{1,2})[\/\-.](\d{2})$/); // MM/YY
  if (m) {
    const y = expandYear(m[2]);
    if (plausibleYear(y)) return y;
  }
  return null;
}

/* ───────────────────────── main entry ───────────────────────── */

/**
 * extractSmart({ text, blocks }, category, knownBrand?) ->
 * {
 *   picks: { make, model, serial, year },        // each { value, score, why[] } or null
 *   candidates: { model:[], serial:[], year:[] } // ranked, for the UI chooser
 *   notes: []                                    // decode notes to surface
 *   lines: []                                    // geometry-ordered line texts
 * }
 *
 * Auto-assignment threshold: 70. Anything scoring lower is still returned in
 * `candidates` for one-tap insertion, but never silently written into a field.
 */
export function extractSmart(ocr, category, knownBrand) {
  const text = ocr?.text || '';
  const lines = flattenBlocks(ocr?.blocks);
  const haveGeom = lines.some((l) => l.frame);
  // Fall back to text-split lines when geometry is missing (older scans,
  // manual re-parse of stored rawOcr) — nomenclature signals still work.
  const lineObjs = lines.length
    ? lines
    : text.split(/\n+/).map((t) => ({ text: t.trim(), frame: null })).filter((l) => l.text);

  const brand = knownBrand || detectBrand(text, category) || null;

  const model = makeBag();
  const serial = makeBag();
  const year = makeBag();
  const notes = [];
  let impliedBrand = null;

  /* Pass 1 — labels, inline + geometric */
  for (let i = 0; i < lineObjs.length; i++) {
    const raw = lineObjs[i].text;

    for (const [labelRe, bag, name] of [
      [MODEL_LABEL, model, 'model'],
      [SERIAL_LABEL, serial, 'serial'],
    ]) {
      const rest = stripLabel(raw, labelRe);
      if (rest === null) continue;
      // Relaxed shape test here only: an explicit MODEL/SERIAL label on the
      // SAME LINE is strong enough evidence on its own that the digit
      // requirement would be second-guessing the plate.
      if (rest && looksLikeValue(rest, { requireDigit: false })) {
        bag.add(rest, 100, `next to its ${name} label`);
      } else if (!rest && haveGeom) {
        const clean = (txt) => stripLeadingLabelFragment(stripGluedLabel(txt));
        const right = valueToRight(lineObjs, i);
        if (right) bag.add(clean(right.text), 85, `right of the ${name} label (table layout)`);
        const below = valueBelow(lineObjs, i);
        if (below && (!right || compact(below.text) !== compact(right.text))) {
          // A cell to the RIGHT and a cell BELOW are alternative readings of
          // the same table, not two independent pieces of evidence. When the
          // row reading already produced a value, the line underneath is
          // usually the NEXT FIELD's row, not this field's value — measured:
          // "MODEL NUMBER | D1EE060N06525C" with "SERIAL71604246" on the
          // line below put the serial into the model's candidate list at 75,
          // ten points off the correct answer. Kept as a visible option,
          // dropped below the auto-assign threshold.
          bag.add(clean(below.text), right ? 55 : 75, `below the ${name} label (table layout)`);
        }
      }
    }

    // Dates: only DATE-labeled lines; bare 4-digit years elsewhere are
    // handled by the caller's existing MFG regex (which requires context).
    const dRest = stripLabel(raw, DATE_LABEL);
    if (dRest !== null) {
      let y = dRest ? yearFromDateValue(dRest) : null;
      if (y == null && haveGeom) {
        // looksLikeValue() is the wrong gate here: it classifies "06/19" as
        // an electrical rating and drops it, so a plate reading
        // "D.O.M. | 06/19" produced no year at all. Ask for a DATE-shaped
        // neighbour instead.
        const right = valueToRight(lineObjs, i, isDateShaped);
        if (right) y = yearFromDateValue(right.text);
        if (y == null) {
          const below = valueBelow(lineObjs, i, isDateShaped);
          if (below) y = yearFromDateValue(below.text);
        }
        if (y != null) year.add(String(y), 85, 'date field (table layout)');
      } else if (y != null) {
        year.add(String(y), 100, 'printed date field');
      }
    }
  }

  /* Pass 2 — nomenclature, label-free */
  const seen = new Set();
  for (const l of lineObjs) {
    const toks = new Set([l.text, ...l.text.split(/\s+/)]);
    for (const tok0 of toks) {
      // "SERIAL71604246" — OCR dropped the space between a label and its
      // value. Pass 1 already handles this via LABEL_END and extracts the
      // right value, but Pass 2 was ALSO adding the whole glued token as
      // its own candidate, so the Best Guesses list showed both
      // "71604246" and "SERIAL71604246". Strip the label here too so the
      // two passes agree on what the value is.
      const tok = stripGluedLabel(tok0);
      const t = tok.replace(/[.,:;]+$/, '');
      const key = compact(t);
      if (t.length < 4 || seen.has(key)) continue;
      seen.add(key);
      if (!looksLikeValue(t)) continue;

      // Model nomenclature
      const mh = withRepair(t, (v) => modelNomenclatureHit(v, brand, category));
      if (mh) {
        // sameBrand is `true` (matches the brand printed on the plate),
        // `false` (matches a DIFFERENT brand than what's printed — genuine
        // conflict, e.g. a peeled sticker from a repair swap), or `null`
        // (the plate declared no brand at all, so there's nothing to
        // conflict with). Only the `false` case deserves the discount —
        // treating "no brand on the plate" the same as "conflicts with the
        // plate" punishes exactly the faded/peeled-label scenario this
        // module exists to handle.
        // Format-only evidence ("this token's shape matches brand X's model
        // prefix") is real but weak — a bare regex match on noise text
        // (screenshot chrome, forum snippets, unrelated stray words) can
        // and does coincidentally satisfy a permissive prefix pattern. It
        // must not be able to outscore a value that's actually anchored to
        // a MODEL label by geometry (75-100) or that matches a CONFIRMED
        // real catalog model (96) — those are strictly better evidence.
        // Scored just under the weakest geometry tier (below-label, 75) so
        // format-only hits only win when nothing better is on the plate.
        const conflicting = mh.result.sameBrand === false;
        const base = conflicting ? 40 : 75;
        const score = base - (mh.corrected ? 15 : 0);
        const why = conflicting
          ? `matches ${mh.result.brand} model format — different brand than plate${mh.corrected ? ' (OCR-corrected)' : ''}`
          : `matches ${mh.result.brand} model format${mh.corrected ? ' (OCR-corrected)' : ''}`;
        model.add(mh.value, score, why);
        if (!brand && !impliedBrand) impliedBrand = mh.result.brand;
      }

      // Known-model fuzzy match — independent of the check above, and
      // runs even when it already found something: a prefix check can
      // "succeed" on a token whose LATER characters are still corrupted,
      // so this needs its own chance to win rather than being skipped
      // whenever mh already returned a (possibly wrong) hit.
      const km = knownModelMatch(t, category);
      if (km) {
        // dist 0 (exact, or every difference explained by a known glyph
        // confusion) is certain enough to offer the CANONICAL spelling —
        // that is OCR repair with a real anchor behind it.
        //
        // For dist 1-2 the right answer depends on WHAT KIND of edit it is,
        // and the old code treated both kinds the same by always offering
        // the anchor:
        //
        //   LENGTH DIFFERS (insertion or deletion) — OCR doubled a
        //   character or dropped one. There is no plausible reading where
        //   the plate really says a model one character longer than every
        //   model that manufacturer ships. The anchor is almost certainly
        //   what is physically printed, so offering it is a genuine
        //   correction the surveyor can confirm at a glance.
        //
        //   SAME LENGTH, substitutions not explained by known glyph
        //   confusions — this is far more likely a DIFFERENT REAL MODEL
        //   that merely resembles one we have on file. Measured: a plate
        //   reading 4TTR4036A1000AA put "4TTR3036E1000AA" into the Best
        //   Guesses list. Different series, different letter, never on the
        //   plate, and perfectly well-formed — the most dangerous kind of
        //   wrong answer, because nothing about it looks like a guess.
        //   Here we offer what was actually READ and merely note what it
        //   resembles.
        //
        // Either way the score stays well under the auto-assign threshold:
        // real evidence, never silently trusted over the surveyor's eyes.
        const exact = km.dist === 0;
        const lengthDiffers = compact(t).length !== compact(km.model).length;
        const offerAnchor = exact || lengthDiffers;
        const score = exact ? 96 : Math.max(40, 70 - km.dist * 15);
        const why = exact
          ? `matches a confirmed real ${km.brand} model${km.explained ? ' (OCR-corrected)' : ''}`
          : lengthDiffers
            ? `confirmed real ${km.brand} model \u2014 scan appears to have ${compact(t).length > compact(km.model).length ? 'added' : 'dropped'} a character \u2014 verify carefully`
            : `close to a confirmed ${km.brand} model (${km.model}, ${km.dist} character${km.dist > 1 ? 's' : ''} off) \u2014 read the plate carefully`;
        model.add(offerAnchor ? km.model : t, score, why);
        if (!brand && !impliedBrand) impliedBrand = km.brand;
      }

      // Serial nomenclature (needs a brand to be meaningful)
      const sh = withRepair(t, (v) => serialNomenclatureHit(v, brand || impliedBrand, category));
      if (sh) {
        const conf = CONF_MULT[sh.result.confidence] || 0.5;
        const score = Math.round(90 * conf) - (sh.corrected ? 15 : 0);
        serial.add(
          sh.value,
          score,
          `decodes to ${sh.result.year} under ${brand || impliedBrand} serial rules${sh.corrected ? ' (OCR-corrected)' : ''}`
        );
      }
    }
  }

  /* Pass 3 — shape nudges (tie-breakers only, never decisive alone) */
  for (const bag of [model, serial]) {
    for (const c of bag.ranked()) {
      const v = compact(c.value);
      if (/^\d+$/.test(v) && v.length >= 8) c.score += 4;       // long all-digit: serial-ish
      if (/^[A-Z]/.test(v) && /\d/.test(v)) c.score += 3;       // letter-led alnum: code-ish
      // A checksum-valid UPC/EAN printed under the serial is the most
      // serial-looking thing on the plate that isn't the serial — and the
      // long-all-digit bonus two lines up actively rewards it. Demote hard
      // rather than reject: the checksum can pass by coincidence on a real
      // 12-digit serial, so it should lose to a labelled value and still
      // beat nothing.
      if (isBarcodeNumber(v)) {
        c.score = Math.round(c.score * 0.35);
        if (!c.why.includes('looks like a printed barcode number')) {
          c.why.push('looks like a printed barcode number');
        }
      }
    }
  }

  // A value scored as a SERIAL candidate that ALSO matches the plate's
  // own brand's MODEL nomenclature shape is almost certainly a mis-pair,
  // not a real serial — genuine serials don't coincidentally take the
  // shape of that same brand's model-number prefix. This happens when a
  // plate prints a model number twice (a "Product No." field alongside
  // "Model No.") and one copy's geometry lands nearer the SERIAL label
  // than the actual serial does. Runs AFTER both passes because the
  // brand is often only known via impliedBrand, which Pass 2 sets — a
  // check placed inside Pass 1 would silently never fire on exactly the
  // faded/peeled-label plates this whole module exists to handle.
  // Discount rather than drop — still offered as a candidate, just not
  // trusted enough to out-rank real evidence or auto-assign alone.
  const effectiveBrand = brand || impliedBrand;
  if (effectiveBrand) {
    for (const c of serial.ranked()) {
      const hit = modelNomenclatureHit(c.value, effectiveBrand, category);
      if (hit && hit.sameBrand) {
        c.score = Math.round(c.score * 0.5);
        if (!c.why.includes('shape matches the plate\'s own model format — likely a mis-pair')) {
          c.why.push('shape matches the plate\'s own model format — likely a mis-pair');
        }
      }
    }
  }

  /* Resolve picks with conflict handling: the same token can't be both the
     model and the serial. Higher score keeps it; the other field takes its
     runner-up. */
  const THRESH = 70;
  const mRank = model.ranked();
  const sRank = serial.ranked();
  let mPick = mRank[0] && mRank[0].score >= THRESH ? mRank[0] : null;
  let sPick = sRank[0] && sRank[0].score >= THRESH ? sRank[0] : null;
  if (mPick && sPick && compact(mPick.value) === compact(sPick.value)) {
    if (mPick.score >= sPick.score) {
      sPick = sRank[1] && sRank[1].score >= THRESH ? sRank[1] : null;
    } else {
      mPick = mRank[1] && mRank[1].score >= THRESH ? mRank[1] : null;
    }
  }
  const yRank = year.ranked();
  const yPick = yRank[0] && yRank[0].score >= THRESH ? yRank[0] : null;

  if (impliedBrand && !brand) {
    notes.push(`Brand inferred from model nomenclature — ${impliedBrand} — confirm`);
  }

  return {
    picks: {
      make: brand ? null : (impliedBrand ? { value: impliedBrand, score: 60, why: ['model nomenclature'] } : null),
      model: mPick,
      serial: sPick,
      year: yPick,
    },
    candidates: {
      model: mRank.slice(0, 6),
      serial: sRank.slice(0, 6),
      year: yRank.slice(0, 4),
    },
    notes,
    lines: lineObjs.map((l) => l.text),
    usedGeometry: haveGeom,
  };
}

/* ───────────────────────── diagnostics export ───────────────────────── */
//
// This whole module's geometry engine hinges on ML Kit actually populating
// `cornerPoints` the way its own type definitions say it does — which is
// NOT verifiable from a development sandbox; it can only be confirmed on a
// real device. This export exists so that when a real scan comes out wrong
// in the field, the surveyor can grab the EXACT raw OCR result (text +
// every line's frame + cornerPoints, whatever ML Kit actually returned)
// and send it back — real ground truth to fix against, instead of a
// description of the symptom or a guess. Deliberately dependency-free
// (plain JSON) so it can be shared through anything: text message, email,
// Slack, whatever's on hand.
export function buildScanDiagnostics(ocr, meta = {}) {
  const blocks = (ocr?.blocks || []).map((b) => ({
    lines: (b.lines || []).map((l) => ({
      text: l.text,
      frame: l.frame || null,
      cornerPoints: l.cornerPoints || null,
    })),
  }));
  const cq = assessCaptureQuality(ocr);
  const payload = {
    _note: 'Fieldset nameplate decoder scan diagnostics — send this back if a scan populated the wrong fields.',
    capturedAt: new Date().toISOString(),
    ...meta,
    hasCornerPoints: blocks.some((b) => b.lines.some((l) => l.cornerPoints)),
    captureQuality: cq,
    text: ocr?.text || '',
    blocks,
  };
  return JSON.stringify(payload, null, 1);
}
