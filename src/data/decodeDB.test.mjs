// Self-validating harness for the decode database.
// Runs every `examples` case declared on every rule, plus a capacity suite.
// Run:  node src/data/decodeDB.test.mjs
import { DECODE_DB, DECODE_DB_VERSION } from './decodeDB.js';
import {
  decodeYearFromSerial, decodeCapacity, detectBrand,
  detectBrandFromModel, decodeSerialCandidates, brandInfo, catalogStats,
} from './hvacDecode.js';

let pass = 0, fail = 0;
const bad = [];
const ok = (cond, label, got) => { cond ? pass++ : (fail++, bad.push(`FAIL  ${label}\n      got: ${JSON.stringify(got)}`)); };
const rankOf = (c) => ({ high: 3, medium: 2, low: 1 }[c] || 0);

// 1) Every serial example declared in the DB.
for (const brand of DECODE_DB) {
  for (const rule of brand.serialRules || []) {
    for (const [serial, expect] of rule.examples || []) {
      const r = decodeYearFromSerial(serial, brand.name, brand.category);
      const yOk = r && (expect.year != null ? r.year === expect.year : expect.yearIn?.includes(r.year));
      const mOk = expect.month == null || (r && r.month === expect.month);
      const wOk = expect.week == null || (r && r.week === expect.week);
      ok(yOk && mOk && wOk, `${brand.name} [${rule.id}] ${serial} -> ${JSON.stringify(expect)}`, r);
    }
  }
}

// 2) Capacity suite (model -> tons / gallons).
const cap = [
  ['hvac', '24ACC636A003', 'tons', 3],
  ['hvac', '4TTR4036', 'tons', 3],
  ['hvac', 'GSX130241', 'tons', 2],
  ['hvac', 'ML14XC1-030-230', 'tons', 2.5],
  ['hvac', 'YCD120', 'tons', 10],
  ['waterheater', 'XE50T06', 'gallons', 50],
  ['waterheater', 'GCV-40', 'gallons', 40],
];
for (const [c, model, kind, val] of cap) {
  const r = decodeCapacity(model, c);
  ok(r && r.kind === kind && r.value === val, `capacity ${c} ${model} -> ${val} ${kind}`, r);
}

// 3) Brand detection incl. cross-category aliases.
const det = [
  ['BRYANT unit', undefined, 'Carrier'],
  ['AMANA hvac', 'hvac', 'Goodman'],
  ['RUUD ac', 'hvac', 'Rheem'],
  ['BRADFORD WHITE tank', 'waterheater', 'Bradford White'],
  ['STATE water heater', 'waterheater', 'A.O. Smith (Water Heater)'],
  // Specificity regression: "daikin applied" must not fall through to
  // Goodman's plain "daikin" alias (residential Daikin, built by Goodman).
  ['DAIKIN APPLIED chiller', 'hvac', 'Daikin Applied (McQuay)'],
  ['DAIKIN residential split', 'hvac', 'Goodman'],
  ['MCQUAY rooftop', 'hvac', 'Daikin Applied (McQuay)'],
];
for (const [text, cat, want] of det) ok(detectBrand(text, cat) === want, `detect "${text}" (${cat||'any'}) -> ${want}`, detectBrand(text, cat));

// 4) Category disambiguation: Rheem HVAC vs Rheem water heater, same-looking input.
const rhHvac = decodeYearFromSerial('F181234567', 'Rheem', 'hvac');
ok(rhHvac && rhHvac.year === 2018 && rhHvac.month === 6, 'Rheem HVAC F18 -> Jun 2018', rhHvac);
const rhWh = decodeYearFromSerial('0884810488', 'Rheem (Water Heater)', 'waterheater');
ok(rhWh && rhWh.year === 1984 && rhWh.month === 8, 'Rheem WH 0884 -> Aug 1984', rhWh);

// 5) REGRESSION — Trane YWW (2002-2009) vs YYWW (2010+).
// This is the headline bug fix. Trane used a 1-digit year + 2-digit week
// through 2009 and a 2-digit year + 2-digit week from 2010. The old engine
// tried YYWW first and first-match-wins, so a 2002 unit silently read as 2021.
// LENGTH is the only disambiguator: 9 chars = YWW era, 10 chars = YYWW era.
// If these fail, do NOT relax the length anchors in decodeDB.js - fix the rule.
const traneRegression = [
  ['21023S41F', 2002, 10, 'trane-ywwd-9'],   // NOT 2021
  ['91531S41F', 2009, 15, 'trane-ywwd-9'],
  ['10161KEDAA', 2010, 16, 'trane-yyww-10'],
  ['130313596L', 2013, 3, 'trane-yyww-10'],
];
for (const [serial, year, week, ruleId] of traneRegression) {
  const r = decodeYearFromSerial(serial, 'Trane', 'hvac');
  ok(r && r.year === year && r.week === week && r.ruleId === ruleId,
    `Trane ${serial} -> ${year} wk${week} via ${ruleId}`, r);
}

// 6) York post-2004: year is chars 2 and 4 CONCATENATED, not a single field.
const y04 = decodeYearFromSerial('N0G6653823', 'York', 'hvac');
ok(y04 && y04.year === 2006 && y04.month === 7, 'York N0G6 -> Jul 2006 (digits 2+4)', y04);

// York pre-2004 is a 21-year letter cycle: inherently ambiguous. The engine
// must surface BOTH candidates rather than picking one and sounding certain.
const yPre = decodeYearFromSerial('EBHM062202', 'York', 'hvac');
ok(yPre && yPre.ambiguous === true, 'York pre-2004 flagged ambiguous', yPre);
ok(yPre && [1978, 1999].includes(yPre.year) &&
   (yPre.altYears || []).some((y) => [1978, 1999].includes(y) && y !== yPre.year),
  'York pre-2004 surfaces both year candidates', yPre);

// 7) Lennox: year is solid, month letter map is contested between sources,
// so the month must be de-rated below the year rather than silently trusted.
const lx = decodeYearFromSerial('1606B13871', 'Lennox', 'hvac');
ok(lx && lx.year === 2006, 'Lennox 1606B -> 2006', lx);
ok(lx && rankOf(lx.monthConfidence) < rankOf(lx.confidence),
  'Lennox month confidence de-rated below year confidence', lx);

// 8) Brand detection from model nomenclature (fallback when OCR misses the
// brand text). Narrow by design: a false brand match picks the wrong serial
// rules, which is worse than no brand at all.
const modelDet = [
  ['4TTR4036A1000AA', 'hvac', 'Trane'],
  ['GSX130241', 'hvac', 'Goodman'],
  ['ZZQQ999', 'hvac', null],
];
for (const [model, cat, want] of modelDet) {
  ok(detectBrandFromModel(model, cat) === want,
    `detectBrandFromModel "${model}" -> ${want}`, detectBrandFromModel(model, cat));
}

// 9) Rule-free brands must say "read the plate", never guess a year.
// ~half the catalog is deliberately rule-free; that is the accuracy-over-
// coverage decision, and it only holds if the UI gets a distinct shape.
let plateOnlyChecked = 0;
for (const brand of DECODE_DB) {
  if ((brand.serialRules || []).length) continue;
  plateOnlyChecked++;
  ok(!!brand.plateNote, `rule-free brand "${brand.name}" declares a plateNote`, brand.plateNote);
}
ok(plateOnlyChecked > 0, 'catalog contains rule-free brands (by design)', plateOnlyChecked);

const noRule = decodeYearFromSerial('ABC123456', 'Greenheck', 'hvac');
ok(noRule && noRule.noRule === true && noRule.year === null && noRule.confidence === 'none',
  'rule-free brand returns noRule/none rather than a guess', noRule);

// 10) Every rule example must also be reachable through decodeSerialCandidates.
const cands = decodeSerialCandidates('N0G6653823', 'York', 'hvac');
ok(cands.length > 0 && cands[0].year === 2006, 'decodeSerialCandidates ranks best first', cands[0]);

// 11) brandInfo surfaces family + hazard for the panels that fail to trip.
const fpe = brandInfo('Federal Pacific', 'electrical');
ok(fpe && !!fpe.hazard, 'Federal Pacific carries a hazard note', fpe && fpe.hazard);
ok(brandInfo('Bryant', 'hvac')?.family === 'Carrier Global', 'brandInfo resolves alias -> family', brandInfo('Bryant', 'hvac'));

// 12) catalogStats sanity - this number is shown in Settings, so it must be real.
const stats = catalogStats();
ok(stats.total === DECODE_DB.length && stats.withRules > 0 && stats.withRules <= stats.total,
  'catalogStats totals are internally consistent', stats);

// 13) REGRESSION — non-cooling brands must not be handed a tonnage.
// Fans/pumps/boilers/diffusers have model numbers full of digit groups (wheel
// size, GPM, MBH) that the generic capacity scan reads as capacity codes.
// A Greenheck exhaust fan reporting "2 Tons" is a fabricated number, not a
// near-miss. If this fails, do NOT loosen the assertion - fix the flag.
const noTons = [
  ['Greenheck', 'SWB-124-15'],
  ['Bell & Gossett', 'E-1510-3BD-120'],
  ['Weil-McLain', 'CGA-036'],
  ['Titus', 'TMS-036'],
  ['Modine', 'HD-060'],
];
for (const [brand, model] of noTons) {
  ok(decodeCapacity(model, 'hvac', brand) === null,
    `noTonnage: ${brand} ${model} -> no capacity`, decodeCapacity(model, 'hvac', brand));
}
// ...but a real cooling brand with the same shape of model still decodes.
ok(decodeCapacity('4TTR4036A1000AA', 'hvac', 'Trane')?.value === 3,
  'noTonnage flag does not suppress real cooling brands', decodeCapacity('4TTR4036A1000AA', 'hvac', 'Trane'));

// Every noTonnage brand should be rule-free/plate-only; if one ever gains a
// capacityRule the flag would silently contradict it.
for (const b of DECODE_DB.filter((x) => x.noTonnage)) {
  ok(!(b.capacityRules || []).length,
    `noTonnage brand "${b.name}" declares no conflicting capacityRules`, b.capacityRules);
}

// 14) NEW 2026.07.2 — compressor date codes (Copeland/Bristol/Tecumseh/
// Scroll Tech). Compressor plates often outlive the unit plate; Copeland's
// scheme is manufacturer-documented. Bristol's Julian day must convert to a
// calendar month (day 195 of 1997 = mid-July).
const cop = decodeYearFromSerial('01D1020HL', 'Copeland', 'hvac');
ok(cop && cop.year === 2001 && cop.month === 4, 'Copeland 01D -> Apr 2001', cop);
const bri = decodeYearFromSerial('19597011199-S', 'Bristol', 'hvac');
ok(bri && bri.year === 1997 && bri.month === 7, 'Bristol Julian 195/97 -> Jul 1997', bri);
const tec = decodeYearFromSerial('H2995', 'Tecumseh', 'hvac');
ok(tec && tec.year === 1995 && tec.month === 8, 'Tecumseh date code H2995 -> Aug 1995', tec);

// Copeland capacity is a raw kBTU field, NOT the standard code grid: ZR40 is
// a real size the grid doesn't contain. 40/12 = 3.3 tons.
const zr = decodeCapacity('ZR40KC-PFV-230', 'hvac', 'Copeland');
ok(zr && zr.value === 3.3, 'Copeland ZR40 -> 3.3 tons via kbtu field', zr);

// 15) NEW — Square D DATE CODE (not the serial). Panels stay honest: the
// plateNote still explains where the code lives if nothing matches.
const sqd = decodeYearFromSerial('97171', 'Square D', 'electrical');
ok(sqd && sqd.year === 1997 && sqd.week === 17, 'Square D deadfront 97171 -> wk17 1997', sqd);
const sqdNone = decodeYearFromSerial('ABC12345XYZ', 'Square D', 'electrical');
ok(!sqdNone || sqdNone.year == null || sqdNone.confidence === 'low',
  'Square D non-date-code serial does not fabricate a confident year', sqdNone);

// Electrical category must NEVER produce a capacity — a panel catalog number
// full of digits is not a tonnage.
ok(decodeCapacity('NQOD442L225', 'electrical', 'Square D') === null,
  'electrical category yields no capacity', decodeCapacity('NQOD442L225', 'electrical', 'Square D'));

// REGRESSION — cross-category leak. The OCR front-end calls with NO category;
// an electrical brand then missed the hvac-scoped lookup and the generic scan
// read the "42" in NQOD442L225 as 3.5 tons. Any non-hvac brand => null,
// category argument or not. Caught by e2e, not unit tests: keep both.
ok(decodeCapacity('NQOD442L225', 'hvac', 'Square D') === null,
  'non-hvac brand suppresses generic tonnage scan even under hvac category', decodeCapacity('NQOD442L225', 'hvac', 'Square D'));
ok(decodeCapacity('NQOD442L225', undefined, 'Square D') === null,
  'non-hvac brand suppresses generic tonnage scan with no category', decodeCapacity('NQOD442L225', undefined, 'Square D'));

// 16) NEW — short aliases ('ge', 'lg', 'abb') match on word boundaries.
// includes() made "GENERAL SUPPLY" hit the 'ge' alias. Long aliases keep
// substring matching because OCR jams words together ("YORKINTL").
ok(detectBrand('GENERAL SUPPLY CO tank', 'waterheater') === null,
  'boundary: "GENERAL SUPPLY" must not match the ge alias', detectBrand('GENERAL SUPPLY CO tank', 'waterheater'));
ok(detectBrand('GE water heater', 'waterheater') === 'Rheem (Water Heater)',
  'boundary: standalone GE still matches', detectBrand('GE water heater', 'waterheater'));
ok(detectBrand('YORKINTL unit', 'hvac') === 'York',
  'jammed-OCR long alias still matches by substring', detectBrand('YORKINTL unit', 'hvac'));

// 17) NEW — alias-restructure regression: ABB is its own entry now, and
// plain "abb" must not resolve to GE.
ok(detectBrand('ABB switchgear', 'electrical') === 'ABB', 'ABB resolves to ABB, not GE', detectBrand('ABB switchgear', 'electrical'));

console.log(`\nDecode DB v${DECODE_DB_VERSION}`);
console.log(`${stats.total} brands, ${stats.withRules} with verified serial rules, ${stats.rules} rules, ${stats.examples} declared examples`);
console.log(bad.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
