// ─────────────────────────────────────────────────────────────────────────
// SERVICE LIFE & CONDITION ASSESSMENT ENGINE
//
// Turns a decoded manufacture year into an engineering judgment:
//   age  ->  remaining useful life (RUL)  ->  replacement priority
//
// This is the wedge. Competitors decode a date and stop. This closes the loop
// from "what is it / how old" to "what should you do about it" — the core of a
// Facility Condition Assessment.
//
// DATA SOURCE: ASHRAE median service-life estimates (ASHRAE Owning &
// Operating Costs database / Equipment Life Expectancy chart), the industry-
// standard reference. Values are MEDIANS — half of units exceed them, half
// don't — so every output is a planning estimate, not a prediction of failure.
// We say so in the label, the same way the decoder states confidence.
// ─────────────────────────────────────────────────────────────────────────

export const SERVICE_LIFE_SOURCE =
  'ASHRAE median service life (Owning & Operating Costs database / Equipment Life Expectancy chart)';

// Median service life in years, keyed by an equipment-type id.
// Values corroborated across multiple published copies of the ASHRAE chart.
export const SERVICE_LIFE = {
  // Cooling / packaged
  rtu:                 { years: 15, label: 'Rooftop Unit (packaged)' },
  split_ac:            { years: 15, label: 'Split-System AC' },
  package_ac:          { years: 15, labeledAs: 'Packaged AC' , label: 'Packaged AC' },
  window_ac:           { years: 10, label: 'Window AC' },
  ptac:                { years: 10, label: 'PTAC / Through-wall' },
  water_cooled_pkg:    { years: 15, label: 'Water-Cooled Package' },
  // Heat pumps
  heat_pump_res:       { years: 15, label: 'Heat Pump (residential)' },
  heat_pump_comm:      { years: 19, label: 'Heat Pump (commercial WSHP)' },
  // Chillers
  chiller_recip:       { years: 20, label: 'Reciprocating Chiller' },
  chiller_centrifugal: { years: 25, label: 'Centrifugal Chiller' },
  chiller_absorption:  { years: 23, label: 'Absorption Chiller' },
  chiller_air_cooled:  { years: 20, label: 'Air-Cooled Chiller' },
  // Heating
  furnace:             { years: 18, label: 'Furnace' },
  boiler_steel:        { years: 24, label: 'Boiler (steel)' },
  boiler_cast_iron:    { years: 30, label: 'Boiler (cast iron)' },
  boiler_electric:     { years: 15, label: 'Boiler (electric)' },
  unit_heater:         { years: 13, label: 'Unit Heater' },
  // Air handling / distribution
  air_handler:         { years: 20, label: 'Air Handler / Fan Coil' },
  fan_coil:            { years: 20, label: 'Fan Coil Unit' },
  vav_box:             { years: 20, label: 'VAV Box' },
  fan_centrifugal:     { years: 25, label: 'Centrifugal Fan' },
  fan_axial:           { years: 20, label: 'Axial Fan' },
  // Heat rejection
  cooling_tower_metal: { years: 20, label: 'Cooling Tower (galv. metal)' },
  air_cooled_cond:     { years: 20, label: 'Air-Cooled Condenser' },
  evap_cond:           { years: 20, label: 'Evaporative Condenser' },
  // Pumps / motors
  pump:                { years: 15, label: 'Pump' },
  motor:               { years: 18, label: 'Electric Motor' },
  // Plumbing / DHW
  water_heater_tank:   { years: 11, label: 'Water Heater (tank)' },
  water_heater_tankless:{ years: 18, label: 'Water Heater (tankless)' },
  // Fallback bucket
  generic_hvac:        { years: 18, label: 'HVAC Equipment (generic)' },
};

// ── Automatic equipment-type classification ──────────────────────────────
// Layers three signals, strongest first, so it can auto-select the type AND
// tell the user what it based the call on:
//   1. Nameplate TEXT keywords (strongest — plates often say the type outright)
//   2. Model-number PREFIX nomenclature (brand-encoded product family)
//   3. Category default (weakest fallback)
// Returns { typeId, confidence, basis } — never silently guesses without
// saying so, same honesty discipline as the decoder.

// (1) Text keywords found on the nameplate / OCR.
const TEXT_RULES = [
  [/tankless|condensing tankless/i, 'water_heater_tankless'],
  [/water\s*heater|water\s*htr|\bd\.?h\.?w\b/i, 'water_heater_tank'],
  [/roof\s*-?\s*top|\brtu\b|packaged?\s*(gas|unit|roof|electric)/i, 'rtu'],
  [/air\s*handler|\bahu\b|fan\s*coil|\bfcu\b/i, 'air_handler'],
  [/heat\s*pump/i, 'heat_pump_res'],
  [/\bfurnace\b/i, 'furnace'],
  // Boilers, most specific first — TEXT_RULES returns on the first match.
  //
  // `boiler_cast_iron` (30 yr) and `boiler_electric` (15 yr) were defined in
  // SERVICE_LIFE but unreachable: the single /\bboiler\b/ rule below caught
  // every boiler and sent it to steel (24 yr). Both directions cost real
  // money on the schedule. A cast-iron sectional reads six years older than
  // it is and hits REPLACE while it still has life — Weil-McLain sectionals
  // routinely run past forty. An electric boiler reads nine years younger
  // and stays "within service life" five years after it wasn't.
  //
  // Deliberately requiring the words ADJACENT rather than anywhere in the
  // blob. "ELECTRIC" appears on the ratings block of practically every plate
  // including gas boilers, and a loose match would pull those to a 15-year
  // median — trading a known small error for an unknown larger one. Adjacent
  // or nothing: a boiler whose plate does not say which kind it is stays
  // steel, which is what the surveyor can correct in the type picker.
  // `\s` matches newlines, and the first version of these rules used it: a
  // Burnham GAS boiler whose next OCR line read "ELECTRICAL RATING 120V"
  // classified as an ELECTRIC boiler and took a 15-year median instead of 24,
  // arriving at REPLACE nine years early. Flat OCR text puts every line
  // adjacent to every other, so adjacency across a newline is not adjacency
  // at all. `[^\S\r\n]` is horizontal whitespace only, and the reverse forms
  // additionally require punctuation — "BOILER (ELECTRIC)" is a real plate
  // legend, "BOILER\nELECTRIC SUPPLY" is two unrelated fields.
  [/cast[^\S\r\n]?-?[^\S\r\n]?iron[^\S\r\n]+(sectional[^\S\r\n]+)?boiler|boiler[^\S\r\n]*[(,-][^\S\r\n]*cast[^\S\r\n]?-?[^\S\r\n]?iron/i, 'boiler_cast_iron'],
  [/electric(?:al)?[^\S\r\n]+boiler|boiler[^\S\r\n]*[(,-][^\S\r\n]*electric/i, 'boiler_electric'],
  [/\bboiler\b/i, 'boiler_steel'],
  [/centrifugal\s*chiller|chiller.*centrifugal/i, 'chiller_centrifugal'],
  [/\bchiller\b/i, 'chiller_air_cooled'],
  [/cooling\s*tower/i, 'cooling_tower_metal'],
  [/\bvav\b/i, 'vav_box'],
  [/\bptac\b|packaged\s*terminal|through[-\s]the[-\s]wall/i, 'ptac'],
  [/backflow|reduced\s*pressure\s*zone|\brpz\b|double\s*check\s*valve|\bdcva\b|vacuum\s*breaker|\bpvb\b/i, 'backflow_preventer'],
  [/condens(ing|er)\s*unit|\bcondenser\b/i, 'split_ac'],
  [/mini[-\s]?split|split[-\s]system/i, 'split_ac'],
  [/window/i, 'window_ac'],
  [/\bpump\b/i, 'pump'],
];

// (2) Model-number prefix nomenclature. Carrier family first two digits are
// well documented; a small conservative Trane set follows. Keys are tested as
// anchored prefixes against the cleaned model string.
const CARRIER_FAMILY = /carrier|bryant|payne|heil|tempstar|comfortmaker|icp|day|arcoaire|keeprite/i;
const CARRIER_PREFIX = {
  '48': 'rtu', '50': 'rtu', '38': 'split_ac', '24': 'split_ac',
  '25': 'heat_pump_res', '58': 'furnace', '59': 'furnace',
  '40': 'air_handler', '30': 'chiller_air_cooled', '19': 'chiller_centrifugal',
};
const TRANE_FAMILY = /trane|american\s*standard/i;
const TRANE_RULES = [
  [/^\dT[TW]R/i, 'split_ac'],       // 4TTR split AC (R); refined below for HP
  [/^\dTWR|^\dTWX/i, 'heat_pump_res'],
  [/\b(YCD|YHC|YSC|TSC|TSD|THC|WSC|WHC)/i, 'rtu'],
  [/\b(TUD|TUE|TUH|TUX|TDC|TDD|GAF|GMV)/i, 'furnace'],
  [/\b(4TEE|TEM|TAM|4TXC|GAM)/i, 'air_handler'],
];

function typeFromModel(model, make) {
  const m = String(model || '').toUpperCase().replace(/\s+/g, '');
  const brand = String(make || '');
  if (!m) return null;
  if (CARRIER_FAMILY.test(brand) || CARRIER_PREFIX[m.slice(0, 2)]) {
    const t = CARRIER_PREFIX[m.slice(0, 2)];
    if (t) return t;
  }
  if (TRANE_FAMILY.test(brand)) {
    for (const [re, id] of TRANE_RULES) if (re.test(m)) return id;
  }
  return null;
}

// Main entry: auto-classify from everything we know.
export function classifyEquipment({ text = '', model = '', make = '', capacity = '', category } = {}) {
  const blob = `${text} ${make} ${model} ${capacity}`;

  // 1) Text keywords — strongest.
  for (const [re, id] of TEXT_RULES) {
    if (re.test(blob)) return { typeId: id, confidence: 'high', basis: 'nameplate text' };
  }
  // 2) Model prefix nomenclature.
  const byModel = typeFromModel(model, make);
  if (byModel) return { typeId: byModel, confidence: 'medium', basis: 'model prefix' };
  // 3) Capacity hint: gallons => water heater.
  if (/\bgal(lon)?s?\b/i.test(capacity)) return { typeId: 'water_heater_tank', confidence: 'medium', basis: 'capacity (gallons)' };
  // 4) Category default — the surveyor's own category selection is a
  // reasonable last resort when neither the text nor the model number
  // named the equipment explicitly (e.g. a fan-powered box's plate cropped
  // to just the electrical data table, with no "VAV" text visible at all).
  if (category === 'waterheater') return { typeId: 'water_heater_tank', confidence: 'low', basis: 'category default' };
  if (category === 'vav') return { typeId: 'vav_box', confidence: 'low', basis: 'category default' };
  if (category === 'backflow') return { typeId: 'backflow_preventer', confidence: 'low', basis: 'category default' };
  return { typeId: 'generic_hvac', confidence: 'low', basis: 'default (unclassified)' };
}

// Back-compat thin wrapper (older callers pass a text blob + category).
export function guessEquipmentType(text, category) {
  return classifyEquipment({ text: String(text || ''), category }).typeId;
}

export const EQUIPMENT_TYPE_OPTIONS = Object.entries(SERVICE_LIFE)
  .map(([id, v]) => ({ id, label: v.label, years: v.years }));

// ── Refrigerant phase-out flags ──────────────────────────────────────────
// R-22 (HCFC): production/import banned in the US since 2020; servicing is
// costly and supply is dwindling. R-410A is being phased down under the AIM
// Act (2025+ new equipment moving to A2L refrigerants like R-454B/R-32).
export function refrigerantFlag(text, year) {
  const t = String(text || '').toUpperCase();
  if (/\bR-?22\b|HCFC-?22/.test(t)) {
    return { level: 'high', code: 'R-22', note: 'R-22 is phased out (US ban since 2020) — servicing costly, supply limited' };
  }
  // Units made ~2010 or earlier commonly used R-22 even if the plate is unread.
  if (year && year <= 2010 && !/R-?410|R-?454|R-?32|R-?407/.test(t)) {
    return { level: 'medium', code: 'R-22?', note: 'Likely R-22 era (pre-2011) — confirm refrigerant; phase-out affects service cost' };
  }
  if (/\bR-?410A?\b/.test(t)) {
    return { level: 'low', code: 'R-410A', note: 'R-410A being phased down under the AIM Act (new equipment moving to A2L)' };
  }
  return null;
}

// ── The core calculation ─────────────────────────────────────────────────
// Given a manufacture year and an equipment type, return age, median life,
// remaining useful life, percent-of-life consumed, and a priority bucket.
export function assessCondition(year, typeId = 'generic_hvac') {
  if (!year) return null;
  // 'backflow_preventer' is intentionally NOT in SERVICE_LIFE: published
  // lifespan claims for backflow assemblies range from ~5 years (RPZ
  // internals needing rebuild) to 20-25 years (the housing, well
  // maintained) with no ASHRAE-equivalent consensus figure the rest of this
  // table is built on — sources disagree by 4-5x. Silently falling back to
  // generic_hvac's number here would print a specific, confident-looking
  // year that's really just a condenser's service life mislabeled onto a
  // check valve assembly. No banner is more honest than a wrong one.
  if (typeId === 'backflow_preventer') return null;
  const now = new Date().getFullYear();
  const age = now - year;
  // An unrecognized id falls back to generic_hvac — but it used to be echoed
  // back in `typeId` while the label and median came from generic_hvac, so
  // the returned object disagreed with itself: typeId 'water_heater' (not a
  // real id; the real ones are water_heater_tank/_tankless) alongside "HVAC
  // Equipment (generic)" and an 18-year median. Anything reading typeId saw a
  // specific equipment type that had not actually been applied.
  //
  // Report what was used, and name what was asked for separately, so a stored
  // record carrying a retired id from an older build is visibly substituted
  // rather than quietly averaged into a condenser's service life.
  const known = Object.prototype.hasOwnProperty.call(SERVICE_LIFE, typeId);
  const resolvedId = known ? typeId : 'generic_hvac';
  const entry = SERVICE_LIFE[resolvedId];
  const median = entry.years;
  const rul = median - age;                 // can be negative (past median)
  const pct = Math.round((age / median) * 100);

  let priority, summary;
  if (rul <= 0) {
    priority = 'replace';
    summary = `Past median service life (${age} yr vs ${median} yr) — replacement candidate`;
  } else if (rul <= 3) {
    priority = 'plan';
    summary = `Near end of life (${rul} yr of ${median} remaining) — budget for replacement`;
  } else if (pct >= 50) {
    priority = 'monitor';
    summary = `Mid-life (${age} yr of ${median}) — monitor condition`;
  } else {
    priority = 'ok';
    summary = `Within service life (${age} yr of ${median})`;
  }

  return {
    age, median, rul, pct,
    priority,           // 'replace' | 'plan' | 'monitor' | 'ok'
    typeId: resolvedId,
    typeLabel: entry.label,
    // null when the requested id was honoured; otherwise the unrecognized id
    // that was asked for, available for the report to disclose.
    typeFallback: known ? null : typeId,
    summary,
  };
}

export const PRIORITY_META = {
  replace: { label: 'REPLACE', color: '#e5484d', rank: 0 },
  plan:    { label: 'PLAN',    color: '#d29922', rank: 1 },
  monitor: { label: 'MONITOR', color: '#5b8def', rank: 2 },
  ok:      { label: 'OK',      color: '#3fb950', rank: 3 },
};
