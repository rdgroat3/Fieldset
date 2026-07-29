// Harness for the smart nameplate field extractor.
// Run:  node src/data/nameplateSmart.test.mjs
//
// Fixtures are synthetic ML Kit results: real nameplate layouts reduced to
// lines + bounding boxes. Each covers a failure mode the old text-only
// pipeline had:
//   1. Bordered-table plates where labels and values are separate OCR lines
//      whose FLAT-TEXT ORDER is scrambled (columns interleaved) — geometry
//      must do the pairing.
//   2. Faded/peeled labels — nomenclature must recognize the model & serial
//      with no label at all.
//   3. OCR confusion (O/0, I/1) inside a serial — repair must recover it.
//   4. Printed MFG DATE fields in MM/YYYY and MM/DD/YY forms.

import { extractSmart, flattenBlocks, yearFromDateValue, assessCaptureQuality } from './nameplateSmart.js';
import { parseNameplateText } from './nomenclature.js';

let pass = 0, fail = 0;
const bad = [];
const ok = (cond, label, got) => {
  if (cond) pass++;
  else { fail++; bad.push(`FAIL  ${label}\n      got: ${JSON.stringify(got)}`); }
};

// Build a one-line-per-entry blocks fixture. Each entry:
// [text, left, top, width, height]
const B = (rows) => rows.map(([text, left, top, width, height]) => ({
  text,
  lines: [{ text, frame: { left, top, width, height } }],
}));
const textOf = (rows) => rows.map((r) => r[0]).join('\n');

/* 1 ── Carrier RTU, bordered table, label LEFT / value RIGHT, and the flat
       text order deliberately scrambled the way ML Kit interleaves columns. */
{
  const rows = [
    ['CARRIER CORPORATION', 40, 10, 300, 24],
    ['MODEL NO.', 40, 60, 110, 20],
    ['VOLTS 460', 40, 140, 120, 20],
    ['48TCED12A2A5', 190, 60, 180, 20],   // value sits right of MODEL NO.
    ['SERIAL NO.', 40, 100, 110, 20],
    ['3014X12345', 190, 100, 150, 20],    // value right of SERIAL NO.
  ];
  const r = extractSmart({ text: textOf(rows), blocks: B(rows) }, 'hvac');
  ok(r.picks.model?.value === '48TCED12A2A5', 'table L/R: model paired by geometry', r.picks.model);
  ok(r.picks.serial?.value === '3014X12345', 'table L/R: serial paired by geometry', r.picks.serial);

  const p = parseNameplateText(textOf(rows), 'hvac', B(rows));
  ok(p.model === '48TCED12A2A5' && p.serial === '3014X12345', 'parseNameplateText integrates smart picks', p);
  ok(p.make === 'Carrier', 'brand still detected', p.make);
}

/* 2 ── Water-heater style: label ABOVE value, stacked cells. */
{
  const rows = [
    ['A.O. SMITH', 30, 10, 200, 22],
    ['MODEL NUMBER', 30, 60, 140, 18],
    ['SERIAL NUMBER', 220, 60, 140, 18],
    ['EJC 6 200', 30, 84, 120, 20],       // directly below MODEL NUMBER
    ['2019M123456', 220, 84, 150, 20],    // directly below SERIAL NUMBER
    ['GALLON CAPACITY 6', 30, 130, 220, 18],
  ];
  const r = extractSmart({ text: textOf(rows), blocks: B(rows) }, 'waterheater');
  ok(r.picks.model?.value === 'EJC 6 200', 'stacked cells: model from below-label', r.picks.model);
  ok(r.picks.serial?.value === '2019M123456', 'stacked cells: serial from below-label', r.picks.serial);
}

/* 3 ── Peeled label: NO model/serial labels survive, brand text present.
       Trane model + serial must be recognized purely from nomenclature. */
{
  const rows = [
    ['TRANE', 40, 10, 120, 24],
    ['4TTR6036J1000AA', 40, 60, 220, 20], // Trane model nomenclature
    ['16211KAT2F', 40, 100, 160, 20],     // Trane 2010+ serial (2016)
    ['R-410A 7.1 LBS', 40, 140, 180, 18],
  ];
  const r = extractSmart({ text: textOf(rows), blocks: B(rows) }, 'hvac');
  ok(r.picks.model?.value === '4TTR6036J1000AA', 'label-free: model via nomenclature', r.picks.model);
  ok(r.picks.serial?.value === '16211KAT2F', 'label-free: serial via serial rules', r.picks.serial);
}

/* 4 ── OCR confusion: serial digits misread as letters. */
{
  const rows = [
    ['TRANE', 40, 10, 120, 24],
    ['4TTR6036J1000AA', 40, 60, 220, 20],
    ['I62IIKAT2F', 40, 100, 160, 20],     // 16211KAT2F with 1→I misreads
  ];
  const r = extractSmart({ text: textOf(rows), blocks: B(rows) }, 'hvac');
  ok(r.picks.serial?.value === '16211KAT2F', 'OCR repair: I→1 recovered serial', r.picks.serial);
  ok((r.picks.serial?.why || []).join(' ').includes('corrected'), 'OCR repair is flagged', r.picks.serial);
}

/* 5 ── Printed dates. */
{
  ok(yearFromDateValue('03/2019') === 2019, 'MM/YYYY', yearFromDateValue('03/2019'));
  ok(yearFromDateValue('11/22/13') === 2013, 'MM/DD/YY', yearFromDateValue('11/22/13'));
  ok(yearFromDateValue('2019-03') === 2019, 'YYYY-MM', yearFromDateValue('2019-03'));
  ok(yearFromDateValue('MAR 2019') === 2019, 'MON YYYY', yearFromDateValue('MAR 2019'));

  const rows = [
    ['GREENHECK', 30, 10, 200, 22],
    ['MFG DATE', 30, 60, 100, 18],
    ['05/2017', 150, 60, 90, 18],
  ];
  const r = extractSmart({ text: textOf(rows), blocks: B(rows) }, 'hvac');
  ok(r.picks.year?.value === '2017', 'date field paired by geometry', r.picks.year);
}

/* 6 ── Same token can't win both fields. */
{
  const rows = [
    ['MODEL', 30, 60, 80, 18],
    ['SERIAL', 30, 100, 80, 18],
    ['ABC12345', 140, 60, 120, 18],
    ['ABC12345', 140, 100, 120, 18],   // OCR duplicated a value across rows
  ];
  const r = extractSmart({ text: textOf(rows), blocks: B(rows) }, 'hvac');
  const m = r.picks.model?.value, s = r.picks.serial?.value;
  ok(!(m && s && m === s), 'conflict resolution: one token, one field', { m, s });
}

/* 7 ── No geometry at all (stored rawOcr re-parse): nomenclature still fires. */
{
  const text = 'TRANE\n4TTR6036J1000AA\n16211KAT2F';
  const r = extractSmart({ text, blocks: null }, 'hvac');
  ok(r.picks.model?.value === '4TTR6036J1000AA', 'text-only fallback: model', r.picks.model);
  ok(r.picks.serial?.value === '16211KAT2F', 'text-only fallback: serial', r.picks.serial);
}

/* 8 ── flattenBlocks reading order. */
{
  const rows = [
    ['SECOND', 200, 10, 100, 20],
    ['FIRST', 20, 12, 100, 20],
    ['THIRD', 20, 60, 100, 20],
  ];
  const flat = flattenBlocks(B(rows)).map((l) => l.text);
  ok(flat.join(',') === 'FIRST,SECOND,THIRD', 'reading order: top-down, left-right', flat);
}

/* 9 ── Legacy behavior preserved: same-line labels, no blocks, category
       capacity/year chain still works through parseNameplateText. */
{
  const p = parseNameplateText('CARRIER\nMODEL: 24ACC636A003\nSERIAL: 3014X12345', 'hvac');
  ok(p.model === '24ACC636A003', 'legacy inline model', p.model);
  ok(p.serial === '3014X12345', 'legacy inline serial', p.serial);
  ok(!!p.capacity, 'capacity decode still runs', p.capacity);
}

/* ───────────────────────────────────────────────────────────────────────
   The tests below cover the 2026-07 decoder-accuracy pass: real bugs found
   by OCR-testing actual field photos, not hypothetical ones.
   ─────────────────────────────────────────────────────────────────────── */

// Rotate a point by angleDeg (clockwise, degrees) around pivot.
function rotatePoint(x, y, angleDeg, pivot) {
  const rad = angleDeg * (Math.PI / 180);
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = x - pivot.x, dy = y - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

// Build a fixture AS IF the plate were photographed tilted by angleDeg.
// Input rows are the plate's TRUE upright layout; output frame + cornerPoints
// are what ML Kit would actually report from the rotated photo — the frame
// is the tight axis-aligned box around the ROTATED quad, exactly as ML Kit
// computes it, not the original upright rectangle.
const BTilted = (rows, angleDeg, pivot) => rows.map(([text, left, top, width, height]) => {
  const corners = [
    { x: left, y: top }, { x: left + width, y: top },
    { x: left + width, y: top + height }, { x: left, y: top + height },
  ].map((p) => rotatePoint(p.x, p.y, angleDeg, pivot));
  const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
  const frame = {
    left: Math.min(...xs), top: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
  };
  return { text, lines: [{ text, frame, cornerPoints: corners }] };
});

/* 10 ── Rotation-aware geometry: a wide bordered-table plate photographed
        tilted ~14°. Two rows, each with a label on the left and its value
        far to the right — level with each other on the PHYSICAL plate. At
        this tilt and column spacing the vertical pixel offset introduced by
        rotation (~Δx·sin(θ)) is bigger than both the row height and the row
        spacing, so a rotation-blind row match latches onto the WRONG row's
        value — precisely the "value in the wrong column" failure mode this
        pass targets. Corner points let flattenBlocks derotate before any
        row/column comparison runs. */
{
  const rows = [
    ['MODEL NO.', 40, 100, 110, 20],
    ['XC16S048A230', 340, 100, 170, 20],   // level with MODEL NO. on the plate
    ['SERIAL NO.', 40, 140, 110, 20],
    ['5817C02027', 340, 140, 150, 20],     // level with SERIAL NO. on the plate
  ];
  const pivot = { x: 250, y: 120 };
  const tilted = BTilted(rows, 14, pivot);

  const flat = flattenBlocks(tilted);
  const modelLabel = flat.find((l) => l.text === 'MODEL NO.');
  const modelValue = flat.find((l) => l.text === 'XC16S048A230');
  // After derotation the two should be back on the same row (small residual
  // tolerance for floating point) — this is the direct fix under test.
  ok(Math.abs((modelLabel.frame.top + modelLabel.frame.height / 2) -
              (modelValue.frame.top + modelValue.frame.height / 2)) < 8,
    'derotation restores row alignment for tilted plate', {
      modelLabelTop: modelLabel.frame.top, modelValueTop: modelValue.frame.top,
    });

  const r = extractSmart({ text: textOf(rows), blocks: tilted }, 'hvac');
  ok(r.picks.model?.value === 'XC16S048A230', 'tilted plate: model still paired to the correct row', r.picks.model);
  ok(r.picks.serial?.value === '5817C02027', 'tilted plate: serial still paired to the correct row', r.picks.serial);
}

/* 11 ── assessCaptureQuality: a level (or near-level) plate should not be
        flagged, a steeply keystoned one should. */
{
  const rows = [
    ['MODEL NO.', 40, 100, 110, 20],
    ['ABC123', 200, 100, 100, 20],
    ['SERIAL NO.', 40, 140, 110, 20],
    ['XYZ789', 200, 140, 100, 20],
  ];
  const level = BTilted(rows, 0.5, { x: 150, y: 120 });
  const q1 = assessCaptureQuality({ blocks: level });
  ok(q1.skewed === false, 'near-level photo not flagged skewed', q1);

  const steep = BTilted(rows, 20, { x: 150, y: 120 });
  const q2 = assessCaptureQuality({ blocks: steep });
  ok(q2.skewed === true, 'steeply tilted photo flagged skewed', q2);
}

/* 12 ── Cross-column contamination: a table row that OCR jammed onto ONE
        flat-text line, label + value + the NEXT column's label riding
        along — real example from a field Trane/American Standard plate
        ("MOD. NO. 2A7A1024A1000AA VOLS", where "VOLS" is the start of the
        adjacent VOLTS cell). The value must stop before the next label
        word, not swallow the whole remainder of the line. */
{
  const rows = [['MOD. NO. 2A7A1024A1000AA VOLTS 208/230', 40, 60, 400, 20]];
  const r = extractSmart({ text: textOf(rows), blocks: B(rows) }, 'hvac');
  ok(r.picks.model?.value === '2A7A1024A1000AA', 'same-line value stops before the next column\'s label', r.picks.model);
}

/* 13 ── New OCR-confusion pairs (G<->6, Z<->2) confirmed from field photos:
        a Trane/American Standard "Allegiance" model OCR'd with a leading
        digit 2 misread as the letter Z. */
{
  const rows = [['ZA7A1024A1000AA', 40, 60, 200, 20]];
  const r = extractSmart({ text: textOf(rows), blocks: B(rows) }, 'hvac');
  ok(r.picks.model?.value === '2A7A1024A1000AA', 'Z/2 repair recovers Trane Allegiance model', r.picks.model);
  ok((r.picks.model?.why || []).some((w) => /OCR-corrected/.test(w)), 'Z/2 repair flagged as corrected', r.picks.model?.why);
}

/* 14 ── Known-model fuzzy match against CONFIRMED_FIELD_MODELS. Real ICP
        field photo produced TWO different garbled readings of the same
        plate across OCR passes:
          - "N4A33GAKB200": a single G/6 substitution — but this token
            ALSO already matches ICP's bare "N4A" prefix on the raw
            corrupted string (prefixes are unanchored at the end), so the
            plain nomenclature check "succeeds" without ever cleaning up
            the tail. Confusion-explained matching must win over that
            trivial prefix hit, not just get out-scored by it.
          - "N4A336GAKB200": an INSERTED extra character — no single-
            character substitution repair can fix an insertion, so this
            one can only ever be a fuzzy (non-auto-assigned) candidate. */
{
  const rows = [['N4A33GAKB200', 40, 60, 200, 20]];
  const r = extractSmart({ text: textOf(rows), blocks: B(rows) }, 'hvac');
  ok(r.picks.model?.value === 'N4A336AKB200',
    'confusion-explained match beats a trivial prefix hit on a corrupted tail', r.picks.model);
}
{
  const rows = [['N4A336GAKB200', 40, 60, 200, 20]];
  const r = extractSmart({ text: textOf(rows), blocks: B(rows) }, 'hvac');
  const cands = (r.candidates.model || []).map((c) => c.value);
  ok(cands.includes('N4A336AKB200'),
    'insertion-error model surfaces the confirmed real model as a candidate', cands);
  ok(!r.picks.model || r.picks.model.value !== 'N4A336AKB200' || r.picks.model.score < 90,
    'insertion-class fuzzy match does not silently overrule with false certainty', r.picks.model);
}

/* 15 ── assessCaptureQuality frame-only fallback: cornerPoints entirely
        absent from every line (e.g. an OCR wrapper/version that doesn't
        populate them) should still catch a badly tilted plate via the
        weaker frame-regression signal, and should stay quiet on a level
        one — with a visibly higher bar than the cornerPoints path, since
        this signal is noisier. */
{
  const rows = [
    ['MODEL NO.', 40, 100, 110, 20],
    ['ABC123', 340, 100, 170, 20],
    ['SERIAL NO.', 40, 140, 110, 20],
    ['XYZ789', 340, 140, 150, 20],
    ['VOLTS', 40, 180, 80, 20],
    ['208/230', 340, 180, 100, 20],
  ];
  // Level layout, no cornerPoints anywhere -> should not flag skewed.
  const flatNoCorners = rows.map(([text, left, top, width, height]) => ({
    text, lines: [{ text, frame: { left, top, width, height } }], // no cornerPoints
  }));
  const q1 = assessCaptureQuality({ blocks: flatNoCorners });
  ok(q1.source === 'frame-regression', 'falls back to frame-regression when cornerPoints absent', q1);
  ok(q1.skewed === false, 'level layout via frame-only fallback not flagged', q1);

  // Same rows, but manually skewed by shifting `top` proportional to
  // `left` (simulating what a rotated photo's axis-aligned boxes would
  // look like), still with no cornerPoints at all.
  const tiltedNoCorners = rows.map(([text, left, top, width, height]) => {
    const shiftedTop = top + (left - 200) * 0.5; // steep synthetic tilt
    return { text, lines: [{ text, frame: { left, top: shiftedTop, width, height } }] };
  });
  const q2 = assessCaptureQuality({ blocks: tiltedNoCorners });
  ok(q2.skewed === true, 'steep tilt caught via frame-only fallback', q2);
}

/* ── Year provenance: printed date vs serial decode ──────────────────────
   Pins the four defects the expanded corpus surfaced. These live here as well
   as in the corpus because each one is a small, tempting-to-"simplify" rule,
   and the reason it exists is not obvious from reading it. */
{
  const rows = [
    ['CARRIER', 40, 10, 140, 24],
    ['MODEL NO.', 40, 45, 120, 22], ['38AUZA08A0A6-0A0A0', 200, 45, 240, 22],
    ['SERIAL NO.', 40, 75, 120, 22], ['1409X12345', 200, 75, 160, 22],
    ['MFG DATE', 40, 105, 110, 22], ['03/2018', 200, 105, 110, 22],
  ];
  const p = parseNameplateText(textOf(rows), 'hvac', B(rows));
  ok(p.year === '2018', 'printed MFG DATE outranks the serial decode', p.year);
  ok(!!p.yearConflict, 'a printed/decoded year conflict is recorded, not discarded', p.yearConflict);
  ok(p.decodeNotes.some((n) => /CONFLICT/.test(n)), 'the conflict is stated in the notes', p.decodeNotes);
  ok(p.decodeNotes.some((n) => /2009/.test(n)), 'the discarded serial year stays visible', p.decodeNotes);
}
{
  // A test/inspection date must never become the manufacture year. Bare-year
  // form, which is the one that actually sprang the trap.
  const rows = [
    ['WEIL-McLAIN', 40, 10, 200, 24],
    ['MODEL', 40, 45, 90, 22], ['CGA-25', 200, 45, 120, 22],
    ['TEST DATE', 40, 105, 120, 22], ['2024', 200, 105, 80, 22],
  ];
  const p = parseNameplateText(textOf(rows), 'hvac', B(rows));
  ok(!p.year, 'a hydrostatic TEST DATE is not reported as the mfg year', p.year);
}
{
  // ...but a real MFG DATE printed after a disqualified one must still be found.
  const rows = [
    ['BURNHAM', 40, 10, 160, 24],
    ['MODEL', 40, 45, 90, 22], ['V1108', 200, 45, 120, 22],
    ['TEST DATE', 40, 105, 120, 22], ['2024', 200, 105, 80, 22],
    ['MFG DATE', 40, 135, 120, 22], ['2003', 200, 135, 80, 22],
  ];
  const p = parseNameplateText(textOf(rows), 'hvac', B(rows));
  ok(p.year === '2003', 'scanning continues past a disqualified date to the real one', p.year);
}
{
  // "06/19" is shaped exactly like a voltage pair, so the generic value test
  // rejected it and D.O.M. produced no year at all.
  const rows = [
    ['BELL & GOSSETT', 40, 10, 220, 24],
    ['MODEL', 40, 45, 90, 22], ['E-1510 3BD', 200, 45, 190, 22],
    ['D.O.M.', 40, 105, 100, 22], ['06/19', 190, 105, 100, 22],
  ];
  const p = parseNameplateText(textOf(rows), 'hvac', B(rows));
  ok(p.year === '2019', 'a rating-shaped date value is still read as a date', p.year);
  ok(p.model === 'E-1510 3BD', 'a multi-word model keeps both words', p.model);
}
{
  // Front-truncated models match no catalog. "MACH" is not label debris.
  const rows = [
    ['PATTERSON-KELLEY', 40, 10, 250, 24],
    ['MODEL', 40, 45, 90, 22], ['MACH C-2000', 200, 45, 180, 22],
  ];
  const p = parseNameplateText(textOf(rows), 'hvac', B(rows));
  ok(p.model === 'MACH C-2000', 'a short leading word that is not a label fragment is kept', p.model);
}
{
  // Genuine OCR label debris IS still stripped.
  const rows = [
    ['YORK', 40, 10, 100, 24],
    ['SERIAL', 40, 45, 90, 22], ['ber N1M1234567', 200, 45, 220, 22],
  ];
  const p = parseNameplateText(textOf(rows), 'hvac', B(rows));
  ok(p.serial === 'N1M1234567', 'a split NUMBER fragment is still stripped', p.serial);
}
{
  // A water heater scanned under the HVAC category still reports its brand,
  // flagged, instead of reporting nothing.
  const rows = [
    ['BRADFORD WHITE', 40, 10, 240, 24],
    ['MODEL', 40, 45, 90, 22], ['RG250T6N', 200, 45, 150, 22],
    ['SERIAL', 40, 75, 90, 22], ['MK1234567', 200, 75, 170, 22],
  ];
  const p = parseNameplateText(textOf(rows), 'hvac', B(rows));
  ok(p.make === 'Bradford White', 'brand printed on the plate survives a category mismatch', p.make);
  ok(p.decodeNotes.some((n) => /catalogued under/.test(n)), 'the category mismatch is disclosed', p.decodeNotes);
}
{
  // The fallback must not invent brands across categories on a short token.
  const rows = [['GENERIC UNIT', 40, 10, 200, 24], ['MODEL', 40, 45, 90, 22], ['ZZ-1', 200, 45, 100, 22]];
  const p = parseNameplateText(textOf(rows), 'hvac', B(rows));
  ok(!p.make, 'no cross-category brand invented from a short token', p.make);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (bad.length) { console.log('\n' + bad.join('\n\n')); process.exit(1); }
