// Self-validating harness for the decode database.
// Runs every `examples` case declared on every rule, plus a capacity suite.
// Run:  node src/data/decodeDB.test.mjs
import { DECODE_DB, DECODE_DB_VERSION } from './decodeDB.js';
import {
  decodeYearFromSerial, decodeCapacity, detectBrand, detectBrandInfo,
  detectBrandFromModel, decodeSerialCandidates, brandInfo, catalogStats,
  sanityCheckCapacity,
} from './hvacDecode.js';

let pass = 0, fail = 0;
const bad = [];
const ok = (cond, label, got) => { cond ? pass++ : (fail++, bad.push(`FAIL  ${label}\n      got: ${JSON.stringify(got)}`)); };
const rankOf = (c) => ({ high: 3, medium: 2, low: 1 }[c] || 0);

// 0) Every rule must declare at least one example.
//
// Block 1 below iterates `examples`, so a rule declaring none contributes zero
// assertions: it is untested, and the suite still reports green. Six rules sat
// in that state — four of them the permissive `-loose` fallbacks, which are
// precisely the rules able to fire on another manufacturer's serial and the
// ones most in need of a pin. This makes the omission a red test rather than a
// silence, so the next rule added cannot repeat it.
for (const brand of DECODE_DB) {
  for (const rule of brand.serialRules || []) {
    ok((rule.examples || []).length > 0,
      `${brand.name} [${rule.id}] declares at least one example`, rule.examples);
  }
}

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

// 1b) Every CAPACITY example declared in the DB.
//
// This block did not exist. `examples` was only ever run against
// serialRules, so a capacityRule could declare examples and have them
// silently ignored — the rule was effectively untested, and a regression in
// it would surface as a wrong tonnage on a customer's condition report
// rather than as a red test. Capacity is the field most likely to be read
// off the report and acted on, so it needs at least the same coverage the
// serial decode already had.
for (const brand of DECODE_DB) {
  for (const rule of brand.capacityRules || []) {
    for (const [model, expectTons] of rule.examples || []) {
      const r = decodeCapacity(model, brand.category || 'hvac', brand.name);
      ok(r && r.value === expectTons && r.confidence === rule.confidence,
        `${brand.name} [${rule.id}] ${model} -> ${expectTons} tons (${rule.confidence})`, r);
    }
  }
}

// 1c) Generic-scan honesty.
//
// An unanchored digit match must never claim 'high' confidence. It used to,
// which put "a run of digits somewhere in this string happens to be a valid
// code" on exactly the same footing as a decode anchored to a published
// manufacturer nomenclature table. Both the Decoder UI and the exported
// condition report read `confidence` to decide how firmly to state a
// number, so this is a correctness property, not a cosmetic one.
{
  const generic = decodeCapacity('QQ036ZZ', 'hvac', undefined);
  ok(!generic || generic.confidence !== 'high',
    'unanchored generic capacity match never claims high confidence', generic);
  ok(!generic || generic.generic === true,
    'unanchored generic capacity match is flagged generic:true', generic);
}

// A brand we DO hold nomenclature for, given a model that fits none of its
// rules, must decline rather than fall through to the blind scan. Knowing
// how Carrier writes a model number and seeing a string that isn't one is
// evidence AGAINST a coincidental digit run being the capacity.
{
  const r = decodeCapacity('CARRIERWIDGET036X', 'hvac', 'Carrier');
  ok(r === null, 'known-nomenclature brand declines rather than blind-scanning', r);
}

// The regression this rule exists for: a 20-ton commercial Carrier rooftop
// used to decode as 2 tons via the shared 2-digit grid.
{
  const r = decodeCapacity('48TCDD24A1G6-0A0A0', 'hvac', 'Carrier');
  ok(r && r.value === 20, '48TC size 24 is 20 tons, not 2', r);
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

// 7b) Real field nameplates (2026-07 decoder-accuracy pass) — each of these
// serials was cross-checked BY HAND against the printed "MFG DATE" / "DATE
// OF MANUFACTURE" field on the same physical plate, so these aren't just
// internally-consistent regex matches, they're independently confirmed
// correct decodes.
const traneField = [
  // TWA120A300FB, printed MFG. DATE 05/2005 -> week 18 of 2005 (early May).
  ['51835S9AD', 'Trane', 'hvac', 2005],
  // 4TTR3036E1000AA (Trane XR13), printed MFR DATE 8/2014 -> week 34 (Aug).
  ['14341UTM3F', 'Trane', 'hvac', 2014],
  // 2A7A1024A1000AA (American Standard "Allegiance 11"), printed MFR DATE
  // 12/2004 -> week 50 (mid-December).
  ['4504K4Y5F', 'Trane', 'hvac', 2004],
];
for (const [serial, brand, cat, year] of traneField) {
  const r = decodeYearFromSerial(serial, brand, cat);
  ok(r && r.year === year, `${brand} field serial "${serial}" -> ${year}`, r);
}
// Carrier field nameplates, same treatment (printed "DATE OF MANUFACTURE").
const carrierField = [
  ['3022E17964', 'Carrier', 'hvac', 2022], // 25HCE460A500, printed JUL 2022
  ['2722F14427', 'Carrier', 'hvac', 2022], // FB4CNP061, printed JUL 2022
];
for (const [serial, brand, cat, year] of carrierField) {
  const r = decodeYearFromSerial(serial, brand, cat);
  ok(r && r.year === year, `${brand} field serial "${serial}" -> ${year}`, r);
}

// 8) Brand detection from model nomenclature (fallback when OCR misses the
// brand text). Narrow by design: a false brand match picks the wrong serial
// rules, which is worse than no brand at all.
const modelDet = [
  ['4TTR4036A1000AA', 'hvac', 'Trane'],
  ['GSX130241', 'hvac', 'Goodman'],
  ['ZZQQ999', 'hvac', null],
  // Confirmed from real field nameplates during the 2026-07 decoder-accuracy
  // pass — each of these previously matched NO brand at all via nomenclature.
  ['GSC130361GB', 'hvac', 'Goodman'],                 // Goodman GSC single-stage AC
  ['13HPX-048-230-18', 'hvac', 'Lennox'],              // Lennox HPX heat pump line
  ['14HPX-060-230-19', 'hvac', 'Lennox'],
  ['2A7A1024A1000AA', 'hvac', 'Trane'],                // Trane/American Standard "Allegiance"
];
for (const [model, cat, want] of modelDet) {
  ok(detectBrandFromModel(model, cat) === want,
    `detectBrandFromModel "${model}" -> ${want}`, detectBrandFromModel(model, cat));
}

// 8b) Capacity still decodes correctly for the newly-recognized model
// families above — brand detection without a correct capacity read is only
// half the fix.
ok(decodeCapacity('GSC130361GB', 'hvac', 'Goodman')?.value === 3,
  'Goodman GSC130361GB -> 3 tons', decodeCapacity('GSC130361GB', 'hvac', 'Goodman'));
ok(decodeCapacity('13HPX-048-230-18', 'hvac', 'Lennox')?.value === 4,
  'Lennox 13HPX-048 -> 4 tons', decodeCapacity('13HPX-048-230-18', 'hvac', 'Lennox'));

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

// 17b) NEW — cross-family aliases are not borrowed across categories.
//
// "general electric" is claimed by GE (Electrical, family ABB) and by Rheem
// (Water Heater), which sells GE-branded heaters. Both are 16 characters, so
// the 5+ character cross-category gate passed them equally and catalog order
// picked Rheem. A GE load centre photographed while the app was tagged for
// anything other than electrical therefore reported Rheem — and Rheem has
// serial rules where GE (Electrical) has none, so the panel also acquired a
// manufacture year, an age, a remaining life, and a place on the replacement
// schedule. Blank is the correct answer when the printed word cannot identify
// the maker on its own.
{
  const gePanel = 'MODEL NO TQL21100\nGENERAL ELECTRIC\nSERIAL NO 0819ABC\n120/240V 200A';
  ok(detectBrand(gePanel, 'electrical') === 'GE (Electrical)',
    'GE panel in its own category resolves to GE', detectBrand(gePanel, 'electrical'));
  ok(detectBrand(gePanel, 'waterheater') === 'Rheem (Water Heater)',
    'GE in the water-heater category is a Rheem-built heater, in-category', detectBrand(gePanel, 'waterheater'));
  for (const cat of ['hvac', 'vav', 'backflow']) {
    ok(detectBrand(gePanel, cat) === null,
      `GE panel is not borrowed into ${cat} on an alias two families claim`, detectBrand(gePanel, cat));
  }
  // The gate must not close on ordinary cross-category borrowing, which is
  // load-bearing: water heaters live in mechanical rooms and get scanned
  // under an HVAC tag constantly.
  const bw = detectBrandInfo('MODEL M4TW50T\nBRADFORD WHITE\nSER MJ12345678', 'hvac');
  ok(bw.name === 'Bradford White' && bw.outOfCategory === true,
    'single-family alias still falls back across categories, and says so', bw);
}


// 15) Capacity/electrical cross-check.
//
// An independent second opinion on a decoded tonnage using a DIFFERENT
// field on the same plate. Every capacity decode reads the model number,
// so a bad nomenclature rule has nothing to contradict it — which is how a
// 20-ton rooftop came back as 2 tons with full confidence. Must fire on
// gross mismatches and stay quiet on real machines, including the awkward
// ones (strip heat raises MCA a long way at a fixed tonnage).
{
  const gross = sanityCheckCapacity({ tons: 2, volts: 208, phase: 3, rla: 30 });
  ok(gross && gross.ok === false && gross.direction === 'capacity-too-small',
    'cross-check flags a 2-ton decode on a 20-ton electrical rating', gross);

  const right = sanityCheckCapacity({ tons: 20, volts: 208, phase: 3, rla: 30 });
  ok(right && right.ok === true, 'cross-check stays quiet on a consistent 20-ton plate', right);

  const stripHeat = sanityCheckCapacity({ tons: 3, volts: 230, phase: 1, mca: 44 });
  ok(stripHeat && stripHeat.ok === true,
    'cross-check stays quiet on a 3-ton with auxiliary electric heat', stripHeat);

  const huge = sanityCheckCapacity({ tons: 50, volts: 230, phase: 1, mca: 32 });
  ok(huge && huge.ok === false && huge.direction === 'capacity-too-large',
    'cross-check flags a 50-ton decode on a residential electrical rating', huge);

  ok(sanityCheckCapacity({ tons: 5, volts: null, phase: null, mca: null }) === null,
    'cross-check says nothing without electrical data', 'null expected');
  ok(sanityCheckCapacity({ tons: 5, volts: 999, phase: 3, mca: 20 }) === null,
    'cross-check says nothing for an unrecognised supply voltage', 'null expected');
}

// 16) Brand ranking: unit brand beats component brand.
//
// A condensing unit photographed with its compressor label in frame used to
// report the COMPRESSOR maker as the equipment brand, because ranking was
// by alias length alone and "copeland" is longer than "lennox". Everything
// downstream then applied the wrong serial rules.
{
  const plate = 'LENNOX INDUSTRIES\nMODEL XC13-036-230\nSERIAL 5811A12345\nCOMPRESSOR\nCOPELAND\nZR40KC-PFV-230';
  ok(detectBrand(plate, 'hvac') === 'Lennox',
    'unit brand wins over an in-frame compressor label', detectBrand(plate, 'hvac'));
}

// 17) Brand aliases survive plate punctuation.
//
// Real plates print "A. O. SMITH" — periods AND spaces. Neither substring
// nor word-boundary matching bridged that to the "a.o. smith" alias, so the
// brand came back null and the whole chain below it (serial rules, year,
// condition assessment) went dark.
for (const form of ['A. O. SMITH', 'A.O. SMITH', 'AO SMITH', 'A O Smith']) {
  const got = detectBrand(`${form}\nWATER HEATER\nMODEL DEL-52`, 'waterheater');
  ok(!!got && /smith/i.test(got), `brand alias matches punctuated form "${form}"`, got);
}

// ── summary (must stay last so every block above is counted) ──
console.log(`\nDecode DB v${DECODE_DB_VERSION}`);
console.log(`${stats.total} brands, ${stats.withRules} with verified serial rules, ${stats.rules} rules, ${stats.examples} declared examples`);
console.log(bad.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
