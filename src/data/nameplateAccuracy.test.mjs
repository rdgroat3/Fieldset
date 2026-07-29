// Nameplate decode ACCURACY harness.
// Run:  node src/data/nameplateAccuracy.test.mjs
// Env:  JUNK=1 to list candidate-list pollution, VERBOSE=1 for per-plate detail
//
// Distinct from nameplateSmart.test.mjs, which pins individual behaviours.
// This one measures the thing that actually matters to a surveyor: over a
// corpus of realistic plates, how often does the tool assert something the
// plate does not say, and how much junk sits in the list it offers?
// Exits non-zero on ANY wrong assertion.

// Decoder accuracy harness.
//
// Scores three things separately, because they fail differently and cost
// differently:
//
//   CORRECT  — the auto-assigned field matches the plate.
//   MISSING  — the field was left blank when the plate had a value.
//              Costs the surveyor thirty seconds of typing.
//   WRONG    — the field was auto-assigned something the plate does not say.
//              Costs the client's trust, because it ships to a report.
//
// WRONG is weighted as the thing to drive to zero. A blank field is visibly
// blank; a confidently wrong model number is not.

import { parseNameplateText } from './nomenclature.js';
import { extractSmart } from './nameplateSmart.js';
import { CORPUS, CORPUS2, CORPUS3, CORPUS4, CORPUS5 } from './nameplateCorpus.mjs';
const ALL = [...CORPUS, ...CORPUS2, ...CORPUS3, ...CORPUS4, ...CORPUS5];

const flatText = (blocks) =>
  blocks.flatMap((b) => b.lines.map((l) => l.text)).join('\n');

const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');

let correct = 0, missing = 0, wrong = 0;
const problems = [];

const check = (id, field, got, want) => {
  const g = norm(got), w = norm(want);
  if (want === null || want === undefined) {
    if (!g) { correct++; return; }
    wrong++; problems.push(`WRONG   ${id}.${field}: got "${got}" — plate has no ${field}`);
    return;
  }
  if (!g) { missing++; problems.push(`MISSING ${id}.${field}: expected "${want}"`); return; }
  if (g === w) { correct++; return; }
  wrong++; problems.push(`WRONG   ${id}.${field}: got "${got}" want "${want}"`);
};

console.log('='.repeat(72));
let candTop1 = 0, candTop3 = 0, candJunk = 0, candTotal = 0;
for (const plate of ALL) {
  const text = flatText(plate.blocks);
  const parsed = parseNameplateText(text, plate.category, plate.blocks);
  const e = plate.expect;

  if ('model' in e) check(plate.id, 'model', parsed.model, e.model);
  if ('serial' in e) check(plate.id, 'serial', parsed.serial, e.serial);
  if ('make' in e) check(plate.id, 'make', parsed.make, e.make);
  if ('year' in e) check(plate.id, 'year', parsed.year ? parseInt(parsed.year, 10) : null, e.year);
  if (e.capacityIsTons === false && /ton/i.test(parsed.capacity || '')) {
    wrong++; problems.push(`WRONG   ${plate.id}.capacity: fabricated tonnage "${parsed.capacity}"`);
  }
  if (e.serialNotEqual) {
    if (norm(parsed.serial) === norm(e.serialNotEqual)) {
      wrong++; problems.push(`WRONG   ${plate.id}.serial: mis-paired "${parsed.serial}"`);
    } else correct++;
  }
  if (e.modelOneOf) {
    if (!parsed.model) { missing++; problems.push(`MISSING ${plate.id}.model`); }
    else if (e.modelOneOf.map(norm).includes(norm(parsed.model))) correct++;
    else { wrong++; problems.push(`WRONG   ${plate.id}.model: spliced/invented "${parsed.model}"`); }
  }

  // CANDIDATE QUALITY — this is what the "Best Guesses" list shows, and it
  // is what the user actually complained about. A correct auto-assign with
  // three junk options under it is still a bad screen.
  {
    const smart = extractSmart({ text, blocks: plate.blocks }, plate.category, parsed.make || null);
    for (const field of ['model', 'serial']) {
      const want = e[field];
      if (!want) continue;
      const list = (smart.candidates?.[field] || []).map((c) => norm(c.value));
      candTotal++;
      if (list[0] === norm(want)) candTop1++;
      if (list.slice(0, 3).includes(norm(want))) candTop3++;
      const junk = list.slice(0, 3).filter((v) => v && v !== norm(want));
      if (junk.length) {
        candJunk += junk.length;
        if (process.env.JUNK) console.log(`  junk ${plate.id}.${field}: ${junk.join(', ')}`);
      }
    }
  }

  if (process.env.VERBOSE) {
    const smart = extractSmart({ text, blocks: plate.blocks }, plate.category, parsed.make || null);
    console.log(`\n--- ${plate.id} (${plate.note})`);
    console.log(`    make=${parsed.make} model=${parsed.model} serial=${parsed.serial} year=${parsed.year} cap=${parsed.capacity}`);
    for (const k of ['model', 'serial']) {
      const top = (smart.candidates?.[k] || []).slice(0, 4)
        .map((c) => `${c.value}(${Math.round(c.score)})`).join('  ');
      console.log(`    ${k} candidates: ${top}`);
    }
  }
}

console.log('='.repeat(72));
for (const p of problems) console.log(p);
const total = correct + missing + wrong;
console.log('='.repeat(72));
console.log(`correct ${correct}/${total}   missing ${missing}   WRONG ${wrong}`);
console.log(`precision (of fields asserted): ${(correct / Math.max(1, correct + wrong) * 100).toFixed(1)}%`);
console.log(`candidate list: top-1 ${candTop1}/${candTotal}  top-3 ${candTop3}/${candTotal}  junk in top-3: ${candJunk}`);

if (wrong > 0) { console.error(`\n${wrong} wrong assertion(s) — decoder accuracy regression.`); process.exit(1); }
