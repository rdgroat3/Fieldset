// Service-life mapping harness.
// Run:  node src/data/serviceLife.test.mjs
//
// The open item this closes: the `equipmentType` ids written by DecoderScreen
// were never exercised by a fixture, so invented ids fell back to
// `generic_hvac` silently and the mapping for water heaters and boilers was
// unverified end to end.
//
// That matters because the chain is short and it ships: equipmentType →
// median service life → RUL → REPLACE/PLAN/MONITOR/OK → a line on the
// replacement schedule the survey was commissioned to produce. A silent
// fallback does not look like an error at any point along it; it looks like a
// condenser's 18-year median quietly applied to a cast-iron boiler.

import {
  SERVICE_LIFE, EQUIPMENT_TYPE_OPTIONS, classifyEquipment, guessEquipmentType,
  assessCondition, refrigerantFlag,
} from './serviceLife.js';

let pass = 0, fail = 0;
const bad = [];
const ok = (cond, label, got) => {
  cond ? pass++ : (fail++, bad.push(`FAIL  ${label}\n      got: ${JSON.stringify(got)}`));
};

const IDS = new Set(Object.keys(SERVICE_LIFE));
const THIS_YEAR = new Date().getFullYear();

/* 1 ── Every id the classifier can emit either has a service-life entry or is
       deliberately excluded. `backflow_preventer` is the one exclusion: the
       published figures for backflow assemblies disagree by 4-5x, so
       assessCondition returns null rather than print a confident number. Any
       OTHER id without an entry is a typo that would silently become
       generic_hvac. */
const DELIBERATELY_UNMAPPED = new Set(['backflow_preventer']);

const PROBES = [
  'rooftop unit RTU', 'split system condenser', 'packaged air conditioner',
  'window air conditioner', 'PTAC unit', 'water cooled package',
  'heat pump', 'reciprocating chiller', 'centrifugal chiller',
  'absorption chiller', 'air cooled chiller', 'gas furnace',
  'steel boiler', 'cast iron boiler', 'electric boiler', 'unit heater',
  'air handling unit', 'fan coil unit', 'VAV terminal box',
  'centrifugal fan', 'axial fan', 'cooling tower', 'air cooled condenser',
  'evaporative condenser', 'circulating pump', 'motor',
  'water heater 50 gal', 'tankless water heater', 'backflow preventer RPZ',
  '', 'unlabelled equipment',
];
const CATEGORIES = ['hvac', 'waterheater', 'electrical', 'vav', 'backflow', undefined];

const emitted = new Set();
for (const text of PROBES) {
  for (const category of CATEGORIES) {
    emitted.add(classifyEquipment({ text, category }).typeId);
  }
}
for (const id of emitted) {
  ok(IDS.has(id) || DELIBERATELY_UNMAPPED.has(id),
    `classifier id "${id}" has a service-life entry (or is deliberately unmapped)`, id);
}

/* 2 ── …and the exclusion is honoured rather than falling through. */
ok(assessCondition(2005, 'backflow_preventer') === null,
  'backflow_preventer yields no assessment rather than a borrowed median',
  assessCondition(2005, 'backflow_preventer'));

/* 3 ── An unrecognized id is substituted VISIBLY.
       This is the case a stored record from an older build hits. The returned
       object must not claim a type it did not apply. */
{
  const r = assessCondition(2010, 'water_heater');   // not an id — the real
                                                     // ones are _tank/_tankless
  ok(r.typeId === 'generic_hvac', 'unknown id reports the entry actually used', r.typeId);
  ok(r.typeFallback === 'water_heater', 'unknown id is named in typeFallback', r.typeFallback);
  ok(r.typeLabel === SERVICE_LIFE.generic_hvac.label,
    'label matches the entry applied, not the id requested', r.typeLabel);

  const good = assessCondition(2010, 'water_heater_tank');
  ok(good.typeId === 'water_heater_tank', 'a real id is honoured', good.typeId);
  ok(good.typeFallback === null, 'a real id records no fallback', good.typeFallback);
  ok(good.median === SERVICE_LIFE.water_heater_tank.years,
    'a real id uses its own median, not the generic one', good.median);
  ok(good.median !== SERVICE_LIFE.generic_hvac.years,
    'water heater and generic HVAC medians actually differ, so the test above bites',
    [good.median, SERVICE_LIFE.generic_hvac.years]);
}

/* 4 ── Water heaters and boilers specifically — the two the open item named.
       Each must classify to its own entry from ordinary plate text. */
for (const [text, category, want] of [
  ['A.O. SMITH 50 GAL WATER HEATER', 'waterheater', 'water_heater_tank'],
  ['NAVIEN TANKLESS WATER HEATER', 'waterheater', 'water_heater_tankless'],
  ['WEIL-McLAIN CAST IRON BOILER', 'hvac', 'boiler_cast_iron'],
  ['ELECTRIC BOILER 45 KW', 'hvac', 'boiler_electric'],
]) {
  const got = classifyEquipment({ text, category }).typeId;
  ok(got === want, `"${text}" classifies as ${want}`, got);
  const cond = assessCondition(THIS_YEAR - 5, got);
  ok(cond && cond.typeId === got && cond.typeFallback === null,
    `${want} survives into assessCondition without substitution`, cond);
}

/* 4b ── Boiler subtype adjacency, across realistic multi-line OCR.
       These exist because the first version of the boiler rules used `\s`,
       which matches newlines. Flat OCR text puts every line adjacent to every
       other, so "BURNHAM GAS BOILER" followed by "ELECTRICAL RATING 120V" on
       the next line classified as an ELECTRIC boiler — a 15-year median on a
       24-year unit, reaching REPLACE nine years early. A wrong subtype is
       worse than no subtype, so anything the plate does not state adjacently
       stays steel and the surveyor corrects it in the picker. */
for (const [text, want] of [
  ['BURNHAM GAS BOILER\nELECTRICAL RATING 120V 60HZ\nINPUT 105 MBH', 'boiler_steel'],
  ['PEERLESS BOILER\nELECTRIC SUPPLY 120V', 'boiler_steel'],
  ['LOCHINVAR BOILER\nGAS FIRED', 'boiler_steel'],
  ['WEIL-McLAIN BOILER\nHEAT EXCHANGER: CAST IRON', 'boiler_steel'],
  ['WEIL-McLAIN CAST IRON BOILER', 'boiler_cast_iron'],
  ['CAST-IRON SECTIONAL BOILER', 'boiler_cast_iron'],
  ['ELECTRIC BOILER 45 KW', 'boiler_electric'],
  ['BOILER (ELECTRIC) 30KW', 'boiler_electric'],
]) {
  const got = classifyEquipment({ text, category: 'hvac' }).typeId;
  ok(got === want, `${JSON.stringify(text.replace(/\n/g, ' | '))} -> ${want}`, got);
}

/* 5 ── Every SERVICE_LIFE entry is well formed and offered in the UI picker.
       EQUIPMENT_TYPE_OPTIONS is derived from SERVICE_LIFE, so a surveyor can
       only ever select a mapped id — this pins that they stay in step. */
for (const [id, v] of Object.entries(SERVICE_LIFE)) {
  ok(typeof v.label === 'string' && v.label.length > 0, `${id} has a label`, v);
  ok(Number.isFinite(v.years) && v.years > 0 && v.years < 100,
    `${id} has a plausible median service life`, v.years);
}
ok(EQUIPMENT_TYPE_OPTIONS.length === Object.keys(SERVICE_LIFE).length,
  'the picker offers exactly the mapped types', EQUIPMENT_TYPE_OPTIONS.length);
ok(!EQUIPMENT_TYPE_OPTIONS.some((o) => DELIBERATELY_UNMAPPED.has(o.id)),
  'the picker does not offer a type with no service life', EQUIPMENT_TYPE_OPTIONS);

/* 6 ── Priority buckets are ordered and reachable. A median that never
       produces REPLACE, or one that produces it immediately, means the RUL
       arithmetic has drifted. */
{
  const id = 'rtu';
  const yrs = SERVICE_LIFE[id].years;
  const fresh = assessCondition(THIS_YEAR - 1, id);
  const midlife = assessCondition(THIS_YEAR - Math.round(yrs * 0.6), id);
  const past = assessCondition(THIS_YEAR - (yrs + 5), id);
  ok(fresh.priority === 'ok', 'a one-year-old unit is OK', fresh.priority);
  ok(midlife.priority === 'monitor' || midlife.priority === 'plan',
    'a 60%-of-life unit is MONITOR or PLAN', midlife.priority);
  ok(past.priority === 'replace', 'a unit past its median is REPLACE', past.priority);
  ok(past.rul < 0, 'RUL stays signed past the median (the CSV sorts on it)', past.rul);
}

/* 7 ── No year, no assessment. Round 3 established that a missing year must
       not be inferred; it must also not be silently treated as new. */
ok(assessCondition(null, 'rtu') === null, 'no year yields no assessment', assessCondition(null, 'rtu'));
ok(assessCondition(0, 'rtu') === null, 'year 0 yields no assessment', assessCondition(0, 'rtu'));

/* 8 ── Refrigerant flags fire on the phase-out gases. */
ok(!!refrigerantFlag('REFRIGERANT R-22', 2005), 'R-22 is flagged', refrigerantFlag('REFRIGERANT R-22', 2005));
ok(!!refrigerantFlag('REFRIGERANT R-410A', 2015), 'R-410A is flagged', refrigerantFlag('REFRIGERANT R-410A', 2015));

/* 9 ── The back-compat wrapper agrees with the classifier it wraps. */
for (const text of ['rooftop unit', 'cast iron boiler', 'tankless water heater']) {
  ok(guessEquipmentType(text, 'hvac') === classifyEquipment({ text, category: 'hvac' }).typeId,
    `guessEquipmentType agrees with classifyEquipment for "${text}"`, guessEquipmentType(text, 'hvac'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (bad.length) { console.log('\n' + bad.join('\n\n')); process.exit(1); }
