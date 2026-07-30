// Decoder COVERAGE harness.
// Run:  node src/data/decoderCoverage.test.mjs
// Env:  VERBOSE=1 for full lists, STRICT=1 to exit non-zero on any finding
//
// Distinct from the two suites that already exist:
//   decodeDB.test.mjs      — every declared example round-trips (correctness)
//   nameplateAccuracy.mjs  — 56 plates, precision of what is asserted
//
// Both answer "is what we test correct?". Neither answers "what is not tested
// at all?" — and a suite at 100% has stopped finding things, which is a fact
// about the suite rather than the decoder. This measures the shape of the
// untested region and the failure modes that only appear off the corpus.
//
// Five checks, ordered by what a wrong result costs the client:
//
//   1 CONTAMINATION  a serial decodes to a DIFFERENT year under another
//                    brand's rules. Reachable whenever brand is inferred
//                    rather than read, and terminal when the plate has no
//                    printed date to contradict it.
//   2 COLLISION      one alias claimed by two unrelated manufacturers.
//   3 UNTESTED RULE  a rule with no declared examples — invisible to
//                    decodeDB.test.mjs, which iterates `examples`.
//   4 CORPUS GAP     catalog brands no fixture plate ever exercises.
//   5 REACHABILITY   an alias printed on a plate that fails to reach its
//                    own brand, in-category and cross-category.

import { DECODE_DB } from './decodeDB.js';
import {
  detectBrand, detectBrandInfo, decodeYearFromSerial, catalogStats,
} from './hvacDecode.js';
import { CORPUS, CORPUS2, CORPUS3, CORPUS4, CORPUS5, CORPUS6 } from './nameplateCorpus.mjs';

const VERBOSE = !!process.env.VERBOSE;
const STRICT = !!process.env.STRICT;
const THIS_YEAR = new Date().getFullYear();

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const CATS = [...new Set(DECODE_DB.map((b) => b.category))];
const RULED = DECODE_DB.filter((b) => (b.serialRules || []).length);
const findings = [];
const rec = (sev, kind, msg, rows = []) => findings.push({ sev, kind, msg, rows });

const bar = (t) => `\n${'═'.repeat(72)}\n${t}\n${'═'.repeat(72)}`;
const plateFor = (alias) => [
  'MODEL NO XY-1234', String(alias).toUpperCase(),
  'SERIAL NO 3216E54321', '208/230V 3PH 60HZ',
].join('\n');

/* ─────────────────── 1. cross-brand serial contamination ─────────────────── */
//
// Every serial the DB declares an answer for, fed to every OTHER brand that
// has rules. A hit means: if the brand is wrong, the year is confidently
// wrong too — and brand is inferred, not read, on any plate where the maker's
// name is absent, abbreviated, obscured, or belongs to a component.
//
// Round 3 made a printed MFG date outrank the serial decode, so on a plate
// carrying both, contamination now surfaces as a yearConflict finding rather
// than a wrong year. That mitigation does not reach a plate with no printed
// date, where the serial decode is the only source and nothing can contradict
// it. Those plates are the reason this check is first.

const examples = [];
for (const b of DECODE_DB) {
  for (const r of b.serialRules || []) {
    for (const [serial, exp] of r.examples || []) {
      examples.push({ serial, owner: b.name, cat: b.category, year: exp.year, ruleId: r.id });
    }
  }
}

const contamination = [];
for (const b of RULED) {
  for (const t of examples) {
    if (t.owner === b.name) continue;
    const r = decodeYearFromSerial(t.serial, b.name, b.category);
    if (!r || r.year == null || t.year == null) continue;
    if (r.year === t.year) continue;
    contamination.push({
      serial: t.serial, trueOwner: t.owner, trueYear: t.year,
      claimedBy: b.name, claimsYear: r.year, conf: r.confidence,
      drift: Math.abs(r.year - t.year),
      future: r.year > THIS_YEAR + 1,
    });
  }
}
const highConf = contamination.filter((c) => c.conf === 'high');
const future = contamination.filter((c) => c.future);

if (contamination.length) {
  rec('HIGH', 'CONTAMINATION',
    `${contamination.length} of ${examples.length} known serials decode to a different year under another brand's rules ` +
    `(${highConf.length} at high confidence, ${future.length} implausibly in the future)`,
    contamination.sort((a, b) => b.drift - a.drift).map((c) =>
      `${c.serial.padEnd(13)} ${c.trueOwner} ${c.trueYear} → claimed by ${c.claimedBy} as ${c.claimsYear} [${c.conf}]${c.future ? ' ← FUTURE' : ''}`));
}

/* ─────────────────────────── 2. alias collisions ─────────────────────────── */
//
// Deliberate sibling entries (Rheem hvac / Rheem waterheater) share aliases on
// purpose and share a `family`. A collision ACROSS families is two unrelated
// manufacturers competing for one printed word, resolved by catalog order.

const owners = new Map();
for (const b of DECODE_DB) {
  for (const a of b.aliases) {
    const k = norm(a);
    if (!owners.has(k)) owners.set(k, []);
    owners.get(k).push(b);
  }
}
// A cross-family collision is data, not yet a defect. What matters is whether
// the ambiguous alias can be BORROWED across categories, because that is the
// path where an unrelated maker's serial rules get applied. Probe the real
// matcher rather than trusting that the gate is still in place.
const crossFamily = [];
const sameFamily = [];
const leaking = [];
for (const [k, list] of owners) {
  if (new Set(list.map((b) => b.name)).size < 2) continue;
  const fams = [...new Set(list.map((b) => b.family || '—'))];
  const alias = list[0].aliases.find((a) => norm(a) === k) || k;
  const row = `${k} → ${[...new Set(list.map((b) => `${b.name} (${b.category}, ${b.family || '—'})`))].join('  vs  ')}`;
  if (fams.length <= 1) { sameFamily.push(row); continue; }
  crossFamily.push(row);
  // Categories none of the claimants own: borrowing there is unresolvable.
  const owned = new Set(list.map((b) => b.category));
  for (const c of CATS) {
    if (owned.has(c)) continue;
    const got = detectBrandInfo(plateFor(alias), c);
    if (got.name) leaking.push(`${k} borrowed into ${c} as ${got.name}`);
  }
}
if (leaking.length) {
  rec('HIGH', 'COLLISION',
    `${leaking.length} cross-family aliases are still borrowed across categories — ` +
    `the borrowing brand's serial rules will be applied to another maker's serial`,
    leaking);
} else if (crossFamily.length) {
  rec('INFO', 'COLLISION',
    `${crossFamily.length} aliases claimed by unrelated manufacturers — contained: ` +
    `the cross-family gate blocks borrowing them into a category neither owns, so each ` +
    `resolves only inside a category one of them actually holds`,
    crossFamily);
}
if (sameFamily.length && VERBOSE) {
  rec('INFO', 'COLLISION', `${sameFamily.length} same-family alias overlaps (deliberate sibling entries)`, sameFamily);
}

/* ───────────────────────── 3. rules without examples ─────────────────────── */
//
// decodeDB.test.mjs iterates `examples`. A rule declaring none contributes
// zero assertions and cannot fail — it is untested inside a green suite.

const noExamples = [];
for (const b of DECODE_DB) {
  for (const r of b.serialRules || []) {
    if (!(r.examples || []).length) noExamples.push(`${b.name} [${r.id}]  conf=${r.confidence}`);
  }
}
if (noExamples.length) {
  const loose = noExamples.filter((s) => /loose/.test(s)).length;
  rec('HIGH', 'UNTESTED RULE',
    `${noExamples.length} serial rules declare no examples and are therefore unasserted` +
    (loose ? ` — ${loose} of them are the permissive \`-loose\` fallbacks, the rules most able to fire on another maker's serial` : ''),
    noExamples);
}

/* ──────────────────────────── 4. corpus gap ──────────────────────────────── */

const plates = [...CORPUS, ...CORPUS2, ...CORPUS3, ...CORPUS4, ...CORPUS5, ...CORPUS6];
const corpusText = plates.map((p) => JSON.stringify(p)).join('\n').toUpperCase();
const untouched = { };
let touched = 0;
for (const b of DECODE_DB) {
  if (b.aliases.some((a) => corpusText.includes(a.toUpperCase()))) touched += 1;
  else (untouched[b.category] ||= []).push(b.name);
}
const untouchedTotal = DECODE_DB.length - touched;
rec(untouchedTotal > DECODE_DB.length * 0.5 ? 'HIGH' : 'MED', 'CORPUS GAP',
  `${untouchedTotal} of ${DECODE_DB.length} catalog brands (${((untouchedTotal / DECODE_DB.length) * 100).toFixed(0)}%) ` +
  `never appear in any of the ${plates.length} fixture plates`,
  Object.entries(untouched).map(([c, l]) => {
    const total = DECODE_DB.filter((b) => b.category === c).length;
    return `${c.padEnd(12)} ${String(l.length).padStart(3)}/${total} untouched` +
      (VERBOSE ? `\n              ${l.join(', ')}` : '');
  }));

/* ───────────────────────── 5. alias reachability ─────────────────────────── */
//
// In-category: the alias printed on a plate must reach its own brand.
// Cross-category: the round-3 fallback, which requires a 5+ character alias.
// Short-name brands are unreachable when mis-tagged — deliberate, but the
// affected list should be visible rather than implicit.

let hit = 0; const unreachable = [];
for (const b of DECODE_DB) {
  for (const a of b.aliases) {
    const got = detectBrand(plateFor(a), b.category);
    if (got === b.name) hit += 1;
    else unreachable.push(`${b.name} (${b.category}) alias "${a}" → ${got || 'nothing'}`);
  }
}
const aliasTotal = DECODE_DB.reduce((n, b) => n + b.aliases.length, 0);
if (unreachable.length) {
  rec('HIGH', 'REACHABILITY', `${unreachable.length}/${aliasTotal} aliases fail to reach their own brand in-category`, unreachable);
}

const shortBlind = [];
for (const b of DECODE_DB) {
  const longest = Math.max(...b.aliases.map((a) => norm(a).length));
  if (longest >= 5) continue;
  const other = CATS.find((c) => c !== b.category);
  const info = detectBrandInfo(plateFor(b.aliases[0]), other);
  if (!info.name) shortBlind.push(`${b.name} (${b.category}) — longest alias ${longest} chars`);
}
if (shortBlind.length) {
  rec('INFO', 'REACHABILITY',
    `${shortBlind.length} brands have no alias of 5+ characters and so cannot cross-category fall back — ` +
    `mis-tagged, they return no brand, therefore no serial rule, therefore no year`,
    shortBlind);
}

/* ──────────────────────────────── report ─────────────────────────────────── */

const stats = catalogStats();
console.log(bar('DECODER COVERAGE'));
console.log(`catalog ${stats.version} · ${stats.total} brands · ${stats.aliases} aliases · ` +
  `${stats.rules} rules on ${stats.withRules} brands · ${stats.plateOnly} plate-only · ${stats.examples} examples`);
console.log(`corpus ${plates.length} plates · brands exercised ${touched}/${stats.total} ` +
  `(${((touched / stats.total) * 100).toFixed(0)}%) · aliases reachable ${hit}/${aliasTotal}`);

const order = { HIGH: 0, MED: 1, INFO: 2 };
findings.sort((a, b) => order[a.sev] - order[b.sev]);
for (const f of findings) {
  console.log(bar(`${f.sev}  ${f.kind}`));
  console.log(f.msg);
  if (f.rows.length) {
    const show = VERBOSE ? f.rows : f.rows.slice(0, 12);
    console.log('\n' + show.map((r) => '  ' + r).join('\n'));
    if (show.length < f.rows.length) console.log(`  … ${f.rows.length - show.length} more (VERBOSE=1)`);
  }
}

const high = findings.filter((f) => f.sev === 'HIGH').length;
console.log(bar(`${findings.length} findings · ${high} high severity`));
if (!VERBOSE) console.log('VERBOSE=1 for full lists.');
if (STRICT && high) process.exit(1);
