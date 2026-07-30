// ─────────────────────────────────────────────────────────────────────────
// EQUIPMENT DECODE DATABASE  (version below)
//
// The flagship decode engine's data layer. Every brand is expressed as DATA
// — aliases, the equipment category, ordered serial-date rules, and the
// source each rule came from — so adding or fixing a rule is a data edit,
// not code surgery. A tiny interpreter (hvacDecode.js) reads this.
//
// DESIGN PRINCIPLES (correctness-first):
//  1. Every rule carries a `confidence` and a `source`. Nothing is asserted
//     without provenance.
//  2. The same manufacturer can appear under multiple categories with
//     different rules (e.g. Rheem HVAC vs Rheem water heater use different
//     serial formats). Decoding is therefore category-aware.
//  3. Ambiguous legacy formats are rated 'low' and annotated, never
//     hard-coded to one guess.
//  4. Known real-world examples live with each rule (`examples`) and are run
//     by the test harness, so validation against field photos is a data edit.
//  5. A brand with NO verified public serial scheme gets `serialRules: []`
//     plus a `plateNote`. Coverage without accuracy is a liability: a wrong
//     year silently corrupts a condition assessment, whereas "no rule, read
//     the plate" costs the surveyor ten seconds. We never invent a regex to
//     make the catalog look bigger. ~half this catalog is rule-free BY DESIGN.
//
// FIELD-MAP GRAMMAR (how a regex match becomes a date):
//   Each serial rule has `test` (RegExp) and `map` naming capture groups:
//     yearFull:<g>      4-digit year, used as-is
//     yearShort:<g>     2-digit year, windowed (>50 => 19xx else 20xx)
//     year2000:<g>      1- or 2-digit year, always 20xx
//     yearDigits:[a,b]  two SEPARATE single-digit groups concatenated into a
//                       2-digit 20xx year (York/JCI post-2004: N[0]G[6] => 06)
//     yorkYear:<g>      York/JCI pre-2004 21-year letter cycle (A=1971/1992…)
//     traneYear:<g>     Trane 1983-2001 year letter (W=1983 … Z=2001)
//     bwYear:<g>        Bradford White 20-year letter cycle (A=1984/2004…)
//     monthNum:<g>      numeric month
//     monthStd:<g>      month LETTER, A..M skipping I  (HVAC/Rheem/BW months)
//     monthYork:<g>     York/JCI pre-2004 month letter, A..H then K,L,M,N
//                       (skips BOTH I and J — NOT the same map as monthStd)
//     monthAlpha:<g>    month LETTER, straight A=1 .. L=12
//     julianDay:<g>     day-of-year 1..366, converted to a calendar month
//     week:<g>          week number (1..53)
//
//   Capacity map extras:
//     kbtu:<g>          raw kBTU/h value (tons = kbtu/12) — compressor
//                       nomenclature, not limited to the standard code grid
//
//   Rule extras:
//     confidence        confidence in the YEAR (the field that drives RUL)
//     monthConfidence   optional, LOWER confidence in the month specifically,
//                       for schemes where the year is corroborated but the
//                       month letter map is contested between sources.
//
//   Rules are SCORED, not first-match-wins: every rule is evaluated and the
//   highest-confidence plausible result wins, with the losers returned as
//   `alternates` so the surveyor sees the ambiguity instead of trusting a
//   coin flip. See hvacDecode.js.
// ─────────────────────────────────────────────────────────────────────────

export const DECODE_DB_VERSION = '2026.07.3';

export const CATEGORIES = {
  hvac: 'HVAC / Refrigeration',
  waterheater: 'Water Heater',
  electrical: 'Electrical Gear',
};

// Capacity codes shared by essentially all US HVAC model numbers:
// nnn = thousands of BTU/h; /12 = nominal tons. (high confidence)
export const HVAC_CAPACITY_CODES = {
  '006': 0.5, '009': 0.75, '012': 1, '018': 1.5, '024': 2, '030': 2.5,
  '036': 3, '042': 3.5, '048': 4, '054': 4.5, '060': 5, '072': 6,
  '090': 7.5, '102': 8.5, '120': 10, '150': 12.5, '180': 15, '210': 17.5,
  '240': 20, '300': 25, '360': 30, '420': 35, '450': 37.5, '480': 40,
  '540': 45, '600': 50,
  // "+1" variants: some manufacturers' commercial/legacy SKUs use one more
  // than the round code for the same nominal tonnage rather than the round
  // number itself — confirmed against manufacturer spec sheets, not a
  // rounding guess:
  //   ICP CHS091/121 (commercial split heat pump spec sheet, position-by-
  //     position nomenclature table: 091=7.5 tons, 121=10 tons)
  //   Bryant/Payne FB4C061 (fan coil product data — 061 is the top of the
  //     "018 thru 061" size range that's 060 in other FB4C literature; same
  //     5-ton class, later SKU revision)
  '061': 5, '091': 7.5, '121': 10,
};

// Two-digit capacity codes (tens of kBTU/h) used mid-model by several brands.
export const HVAC_CAPACITY_CODES_2 = {
  '18': 1.5, '24': 2, '30': 2.5, '36': 3, '42': 3.5, '48': 4, '54': 4.5, '60': 5,
};

// Common residential/commercial water-heater tank sizes (US gallons), used to
// pull capacity out of a model number with reasonable confidence.
// 6 confirmed directly off a field nameplate (A.O. Smith EJC 6 200 point-of-
// use heater, "CAPACITY US GAL: 6.0" printed on the plate) — the table
// previously started at 20, so every small point-of-use/lavatory heater
// (break rooms, remote restrooms — a common MEP survey find) decoded to
// nothing. Other small POU sizes (2.5, 10, 15, 19 gal) are common on this
// model line too but aren't added here without a plate to confirm against;
// add them as they turn up in the field rather than guessing the set.
export const WH_GALLON_SIZES = [6, 20, 28, 30, 38, 40, 47, 48, 50, 55, 65, 66, 74, 75, 80, 98, 100, 119];

// Bradford White 20-year year-letter cycle (skips I,O,Q,R,U,V). A = 1984/2004…
export const BW_YEAR_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'S', 'T', 'W', 'X', 'Y', 'Z'];

// York / Johnson Controls pre-2004 year letters. 21-year cycle starting 1971,
// skipping I, O, Q, U, Z. The cycle repeats (A = 1971 OR 1992), which is why
// every pre-2004 York date is inherently ambiguous and rated 'low'.
export const YORK_YEAR_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'R', 'S', 'T', 'V', 'W', 'X', 'Y'];

// Trane 1983-2001 year letters. NOTE S=1986 / Z=2001: some secondary sources
// publish these swapped (S=2001, Z=1986). We follow the Building Intelligence
// Center, which states Trane stopped using year letters after 2001 "represented
// by the letter Z" — that corroborates Z=2001 and breaks the tie. The rule is
// rated 'medium' because the disagreement between sources is real.
export const TRANE_YEAR_LETTERS = {
  W: 1983, X: 1984, Y: 1985, S: 1986, B: 1987, C: 1988, D: 1989, E: 1990,
  F: 1991, G: 1992, H: 1993, J: 1994, K: 1995, L: 1996, M: 1997, N: 1998,
  P: 1999, R: 2000, Z: 2001,
};

// Shorthand for the (large) set of brands we can identify and classify but
// for which no serial-date scheme is publicly verified. Honest by design.
const plateOnly = (name, category, aliases, plateNote, extra = {}) => ({
  name, category, aliases, sources: [], serialRules: [], plateNote, ...extra,
});

const PLATE_DATE = 'Nameplate typically prints the manufacture date directly - read it from the plate.';
const NO_SCHEME = 'No publicly verified serial-to-date scheme. Read the MFG date on the plate, or call the manufacturer with the serial.';

export const DECODE_DB = [
  // ══════════════════════════ HVAC — MAJORS ══════════════════════════
  {
    name: 'Carrier',
    category: 'hvac',
    family: 'Carrier Global',
    // 'cac/bdp' etc.: many Bryant/Payne-family fan coils and air handlers are
    // stamped "CAC/BDP" (Carrier Air Conditioning / Bryant Day & Payne — the
    // corporate manufacturing designation) instead of a retail brand word.
    // Confirmed against a real fan-coil nameplate reading "CAC/BDP" with the
    // exact same Indianapolis address ("7310 W. Morris St") that appears on
    // this brand's own Carrier-branded units — before this alias, that
    // nameplate matched NO brand at all: no text alias, no model prefix.
    aliases: ['carrier', 'bryant', 'payne', 'day & night', 'day and night',
      'cac/bdp', 'cac-bdp', 'cac bdp'],
    // Carrier product families: 24=AC, 25=HP, 38=condenser, 40=fan coil,
    // 48=packaged gas/elec, 50=packaged elec, 58/59=furnace.
    // FB4C = Bryant/Payne "Comfort" fan coil (see capacityRules below) — a
    // completely different naming convention from the numeric-family codes,
    // which is why it needs its own prefix entry rather than fitting the
    // pattern above.
    //
    // The trailing `\d` is load-bearing and was missing. `^(?:24|...)[A-Z]{2,3}`
    // with nothing after it matches "50HZ" and "24VAC" — a family code plus
    // two or three letters and then end-of-token. Both are ordinary lines on
    // any Carrier plate (line frequency; control-circuit voltage), and the
    // measured result was that a plate cropped to its ratings table returned
    // "50HZ" as the MODEL, scored above the auto-assign threshold.
    //
    // Every real Carrier model in this family carries a numeric size/series
    // field immediately after the letter group — 48TCED08…, 38MURAQ24AA3,
    // 24ACC636A003, 25HCB636A003. Requiring at least one digit there costs
    // nothing in recall and removes the entire class of two-letter rating
    // suffixes in one edit. The isRatingToken filter in nameplateSmart.js
    // catches these independently; both exist because a prefix this
    // permissive would keep finding new ways to be wrong.
    modelPrefixes: [/^(?:24|25|38|40|48|50|58|59)[A-Z]{2,4}\d/, /^FB4C[A-Z]{0,2}\d/],
    capacityRules: [
      // ── Carrier 48TC WeatherMaker commercial packaged rooftop ──
      //
      // Ordered FIRST because it must win over carrier-cap2 below, and
      // because getting this wrong is expensive: without it, a 20-ton
      // 48TCDD24A1G6 fell through to the generic 2-digit scan, which read
      // the "24" against the standard kBTU/12 grid and reported 2 TONS on
      // the condition report. Off by a factor of ten, presented with no
      // hedge.
      //
      // The 48TC size field is NOT the kBTU/12 grid — it is a platform-
      // local index. Both halves of the range are transcribed directly
      // from Carrier's own Model Number Nomenclature pages:
      //
      //   3-15 ton platform (Form 48TC-04-16-03PD):
      //     04=3  05=4  06=5  07=6  08=7.5  09=8.5  12=10  14=12.5  16=15
      //   15-27.5 ton platform (Product Data C09248, form 48TC-16PD):
      //     17=15  20=17.5  24=20  28=25  30=27.5
      //
      // Corroborated independently: Carrier's 48TC*D09 service literature
      // is titled 8.5 ton, and the C09248 AHRI cooling rating table lists
      // sizes 17/20/24/28 at 15/17.5/20/25 nominal tons.
      //
      // 16 and 17 both map to 15 tons. That is not a typo — they are the
      // top of the small platform and the bottom of the large one, two
      // different cabinets at the same nominal capacity.
      //
      // NOTE: size 30 is printed as 27.5 tons on the nomenclature page and
      // in the "COOLING CAPACITIES ... 27.5 TONS 48TC*D30" table, but as
      // 30 tons in that same document's AHRI summary table. Two of three
      // say 27.5, so 27.5 is used. Anything decoding to a 30 should be
      // eyeballed against the plate.
      //
      // Position: 48TC + heat-size letter + refrig-system letter + NN.
      // 48TCED08... -> E (medium gas heat), D (2-stage cooling), 08.
      //
      // Deliberately NOT extended to the 50TC electric-cooling sibling.
      // It is very likely the same scale, but "very likely" is how wrong
      // numbers get into reports — no Carrier 50TC nomenclature page was
      // checked, so 50TC stays undecoded until one is.
      {
        id: 'carrier-48tc-size',
        test: /^48TC[A-Z]{2}(\d{2})/,
        map: { table: 1 },
        table: {
          '04': 3, '05': 4, '06': 5, '07': 6, '08': 7.5, '09': 8.5,
          '12': 10, '14': 12.5, '16': 15,
          '17': 15, '20': 17.5, '24': 20, '28': 25, '30': 27.5,
        },
        confidence: 'high',
        note: 'Carrier 48TC WeatherMaker nominal cooling size code (platform index, not kBTU/12)',
        examples: [['48TCED08A2A5-0A0A0', 7.5], ['48TCDD24A1G6-0A0A0', 20], ['48TCAD09A2A6', 8.5]],
      },
      { id: 'carrier-cap2', test: /^(?:24|25|38|48|50)[A-Z]{2,3}\d?(\d{2})[A-Z0-9]/, map: { tons2: 1 },
        confidence: 'high', note: 'Carrier capacity field (2-digit kBTU/h)',
        examples: [['24ACC636A003', 3], ['24ABB330A003', 2.5]] },
      // FB4CNP061 -> "061" nominal size code, verified against Bryant/Payne
      // FB4C fan-coil product data (018 thru 061 size range; the standard
      // 018/024/030/036/042/048/060 = 1.5-5 ton grid, with 061 as the top-
      // of-line "+1" SKU for the same 5-ton class).
      { id: 'carrier-fb4c-cap3', test: /^FB4C[A-Z]{2}(\d{3})/, map: { tons3: 1 },
        confidence: 'high', note: 'Bryant/Payne FB4C fan coil nominal size code',
        examples: [['FB4CNP018L00', 1.5], ['FB4CNP036L00', 3], ['FB4CNP061', 5]] },
    ],
    sources: [
      'https://texastempmasters.com/blog/carrier-serial-number-age',
      'https://www.building-center.org/carrier-hvac-age/',
    ],
    serialRules: [
      // Full-shape anchored: WWYY + one plant letter + 5 digits (10 chars
      // total), matching both declared examples exactly. The prior version
      // only tested the leading 4 digits with no length or tail
      // constraint, so ANY digit-leading noise token (a pressure spec, a
      // stray timestamp fragment, price text) would pass and "decode" to
      // a plausible-looking year — that's a false-positive generator, not
      // real evidence, and it was outscoring genuine geometry-paired
      // serials in practice. Real Carrier serials have a specific shape;
      // require it.
      { id: 'carrier-wwyy', test: /^(\d{2})(\d{2})[A-Z]\d{5}$/, map: { week: 1, yearShort: 2 },
        confidence: 'high', note: 'WWYY (week+year) + plant letter + 5-digit sequence',
        examples: [['3216E54321', { year: 2016, week: 32 }], ['2714X12345', { year: 2014, week: 27 }]] },
    ],
  },
  {
    // Split out from Carrier. ICP has been Carrier-owned since 1999 but its
    // plants kept their own nomenclature; folding them into Carrier's WWYY
    // rule (as this DB previously did) silently mis-dates ICP gear.
    name: 'ICP (Heil / Tempstar / Comfortmaker)',
    category: 'hvac',
    family: 'Carrier Global',
    aliases: ['international comfort products', 'international comfort', 'icp', 'heil',
      'heil-quaker', 'tempstar', 'comfortmaker', 'arcoaire', 'keeprite', 'keep rite'],
    // CHS = commercial split-system heat pump (see capacityRules). RCS/RAS/
    // RGH/RAH/RHH are commercial rooftop lines confirmed present in the field
    // (an accessory-data plate photographed alongside a CHS unit references
    // "RCS/RAS072-150" and "RGH/RAH036-304"/"RHH036-155" by name) — added
    // here for brand detection even though their capacity-field convention
    // hasn't been independently verified yet, so no capacityRule references
    // them. Confirm against a real nameplate before trusting a tonnage read
    // on one of these.
    modelPrefixes: [/^(?:N4A|N4H|NXA|NXH|H4A|H4H|T4A|T4H|C4A|C4H|R4A|R4H|PA[BCD]|PG[BCD]|PH[BCD]|CHS|RCS|RAS|RGH|RAH|RHH)/],
    capacityRules: [
      // CHS072/091/121HAA0A00A -- verified position-by-position against the
      // manufacturer spec sheet's own "MODEL NOMENCLATURE" table (position
      // 4-6 = nominal cooling capacity, direct lookup not a /12 formula:
      // 072=6, 091=7.5, 121=10 tons). Source: ICP CHS commercial split-
      // system heat pump product data, form 506 14 3401 02.
      { id: 'icp-chs-cap3', test: /^CHS(\d{3})/, map: { tons3: 1 },
        confidence: 'high', note: 'ICP CHS commercial split-system heat pump nominal capacity',
        examples: [['CHS072HAA0A00A', 6], ['CHS091HAA0A00A', 7.5], ['CHS121HAA0A00A', 10]] },
    ],
    sources: ['https://www.shareddocs.com/hvac/docs/1011/Public/0A/ICP_Nomenclature.pdf'],
    serialRules: [
      { id: 'icp-letter-wwyy', test: /^[A-Z](\d{2})(\d{2})/, map: { week: 1, yearShort: 2 },
        confidence: 'low', note: 'ICP plant letter + week/year - field order varies by era and plant, confirm against the plate',
        examples: [['E031136011', { year: 2011, week: 3 }]] },
    ],
  },
  {
    name: 'Trane',
    category: 'hvac',
    family: 'Trane Technologies',
    aliases: ['trane', 'american standard', 'ameristar', 'ingersoll rand', 'ingersoll-rand'],
    // [234]A[67]A\d: the older "Allegiance" split-system A/C and heat-pump
    // line (2A6A/2A7A/3A6A/3A7A/4A6A/4A7A — tonnage-class digit, A/HP
    // indicator, generation digit, A, then the capacity/voltage run).
    // Confirmed from a real field nameplate ("2A7A1024A1000AA", American
    // Standard/Trane "Allegiance 11", MFR DATE 12/2004) that matched NONE
    // of the three prefixes below — all three assume a newer model shape
    // starting with T or a 4A6/4A7 pair, not this older 2-digit-led family.
    modelPrefixes: [/^[24]T[A-Z]{2}\d/, /^T[TW][ABDEHRSX]\d/, /^4A[67][A-Z]/, /^[234]A[67]A\d/],
    capacityRules: [
      { id: 'trane-cap3', test: /^\d[A-Z]{3}\d(\d{3})/, map: { tons3: 1 },
        confidence: 'high', note: 'Trane capacity field (kBTU/h)',
        examples: [['4TTR4036A1000AA', 3], ['4TWR3060A1000AA', 5]] },
      { id: 'trane-cap3-comm', test: /^[A-Z]{3}(\d{3})/, map: { tons3: 1 },
        confidence: 'medium', note: 'Trane commercial capacity field (kBTU/h)',
        examples: [['TTA090A300CA', 7.5]] },
    ],
    sources: [
      'https://www.building-center.org/trane-hvac-age/',
      'https://www.pickhvac.com/hvac/age-serial-number/trane/',
      'https://www.howtolookatahouse.com/Blog/Entries/2018/6/how-can-i-tell-the-age-of-a-trane-furnace-from-the-serial-number.html',
    ],
    serialRules: [
      // ── The 2002-2009 (YWW) vs 2010+ (YYWW) split is the most dangerous
      // ambiguity in this DB. A serial beginning "2102…" is 2002-week-10
      // under the old style and 2021-week-02 under the new one. Both parse.
      // Both yield a plausible year. Length breaks the tie: the 2002-2009
      // style runs 9 characters, the 2010+ style runs 10.
      // These rules are LENGTH-ANCHORED for exactly that reason — do not
      // relax the anchors without re-reading this comment.
      { id: 'trane-yyww-10', test: /^(\d{2})(\d{2})[A-Z0-9]{6}$/, map: { year2000: 1, week: 2 },
        confidence: 'high', note: 'YYWW (year+week), 2010+ 10-character style',
        examples: [['10161KEDAA', { year: 2010, week: 16 }], ['130313596L', { year: 2013, week: 3 }]] },
      { id: 'trane-ywwd-9', test: /^([2-9])(\d{2})[A-Z0-9]{6}$/, map: { year2000: 1, week: 2 },
        confidence: 'high', note: 'YWW (single year digit + week), 2002-2009 9-character style',
        examples: [['91531S41F', { year: 2009, week: 15 }]] },
      { id: 'trane-letter-year', test: /^([A-Z])(\d{2})/, map: { traneYear: 1, week: 2 },
        confidence: 'medium', note: 'year letter + week, 1983-2001 style (the S/Z year mapping is contested between published sources)',
        examples: [['B50632891', { year: 1987, week: 50 }], ['Z12345678', { year: 2001, week: 12 }]] },
      // Loose fallback for the many off-length variants Trane has shipped over
      // 40 years. Deliberately 'low' so the scorer ranks it below the anchored
      // rules whenever one of those matches.
      { id: 'trane-yyww-loose', test: /^(\d{2})(\d{2})/, map: { year2000: 1, week: 2 },
        confidence: 'low', note: 'YYWW assumed - serial length matches no known Trane style, confirm against the plate',
        // 7 chars: too short for trane-yyww-10 (10) and trane-ywwd-9 (9), so
        // only the fallback can match. Pins the fallback's field order, which
        // is the opposite of Carrier's WWYY on an identically shaped serial.
        examples: [['1842XYZ', { year: 2018, week: 42 }]] },
    ],
  },
  {
    name: 'York',
    category: 'hvac',
    family: 'Johnson Controls',
    aliases: ['york', 'johnson controls', 'luxaire', 'coleman', 'champion', 'fraser-johnston',
      'fraser johnston', 'evcon', 'guardian', 'moncrief', 'red t', 'tempmaster',
      'unitary products', 'revolv', 'borg-warner', 'borg warner'],
    modelPrefixes: [/^(?:YC[A-Z]|YZ[A-Z]|YH[A-Z]|YXV|YFD|YZE|YZF|TCGD)/],
    capacityRules: [
      { id: 'york-cap3', test: /^[A-Z]{2,4}(\d{3})/, map: { tons3: 1 },
        confidence: 'medium', note: 'York capacity field (kBTU/h)',
        examples: [['YCD120', 10]] },
    ],
    sources: [
      'https://www.building-center.org/york-hvac-age/',
      'https://www.pickhvac.com/hvac/age-serial-number/york/',
      'https://www.building-center.org/coleman-hvac-age/',
    ],
    serialRules: [
      // Post-Oct-2004: Letter Digit Letter Digit + 6 digits. Year = chars 2
      // and 4 CONCATENATED (N0G6… => "0"+"6" => 2006). Month = char 3.
      { id: 'york-2004', test: /^[A-Z](\d)([A-M])(\d)\d{6}$/, map: { yearDigits: [1, 3], monthStd: 2 },
        confidence: 'high', note: 'plant + interleaved year/month/year, Oct-2004 onward (also Coleman, Luxaire, Champion, Evcon)',
        examples: [['N0G6653823', { year: 2006, month: 7 }], ['W1G4123456', { year: 2014, month: 7 }]] },
      // Pre-2004: plant letter, month letter, year letter. The year letter
      // cycles every 21 years, so this is genuinely ambiguous — we surface
      // both candidates rather than pick one and pretend.
      { id: 'york-pre2004', test: /^[A-Z]([A-N])([A-Y])[A-Z0-9]/, map: { monthYork: 1, yorkYear: 2 },
        confidence: 'low', note: '21-year letter cycle, pre-2004 style - both candidate years shown; the building era usually breaks the tie',
        examples: [['EBHM062202', { yearIn: [1978, 1999], month: 2 }]] },
    ],
  },
  {
    // 'daikin' here = residential Daikin, built by Goodman and sharing its
    // nomenclature — NOT Daikin Applied/McQuay commercial gear, which has
    // its own entry below.
    name: 'Goodman',
    category: 'hvac',
    family: 'Daikin Industries',
    aliases: ['goodman', 'amana', 'daikin', 'janitrol', 'quietflex'],
    modelPrefixes: [
      // GSC/GSZ/GSX etc.: Goodman's single-stage split AC/HP condenser
      // families (GSC13/GSC16 = 13/16 SEER single-stage AC). GSC was
      // missing here — confirmed from a real field nameplate
      // ("GSC130361GB") that otherwise matched no Goodman prefix at all.
      /^(?:GSX|GSZ|GSH|GSC|SSX|SSZ|ASX|ASZ|DSX|DSZ|VSX|VSZ)[A-Z]?\d/,
      /^(?:GMEC|GMVC|GMSS|GMES|GCES|GCVC|CAPF|CAPT|CHPF|ARUF|AMST|AMVT|ASPT)/,
    ],
    capacityRules: [
      { id: 'goodman-cap3', test: /^[A-Z]{3,4}\d{2}(\d{3})/, map: { tons3: 1 },
        confidence: 'high', note: 'Goodman capacity field (kBTU/h)',
        examples: [['GSX130241', 2], ['GSXC160601', 5]] },
    ],
    sources: [
      'https://hvacpricingguide.com/hvac-age-decoder/',
      'https://www.electrical-forensics.com/HVAC/AirConditionerDateCodes.html',
    ],
    serialRules: [
      // Modern Goodman/Amana format is confirmed 10 characters, all-digit,
      // by multiple independent sources (both DB examples match exactly).
      // The prior version only tested the leading 4 digits with no length
      // or tail constraint, letting any digit-leading noise token
      // "decode" to a plausible year — the same false-positive shape as
      // the Carrier bug this was fixed alongside. Older/legacy Goodman
      // formats (Julian day, letter-prefixed) are real but different
      // schemes this rule was never meant to cover; a genuinely
      // off-format serial should fall through to the low-confidence
      // fallback rather than be force-fit here.
      { id: 'goodman-yymm', test: /^(\d{2})(\d{2})\d{6}$/, map: { year2000: 1, monthNum: 2 },
        confidence: 'high', note: 'YYMM (year+month), 10-digit modern format',
        examples: [['0606111539', { year: 2006, month: 6 }], ['1806123456', { year: 2018, month: 6 }]] },
      // Loose fallback for legacy/off-length Goodman serials (Julian day
      // codes, letter-prefixed plant codes, etc). Deliberately 'low' so
      // it never outranks the anchored rule above or a labeled/geometry
      // pick — an honest low-confidence guess, not a false-high claim.
      { id: 'goodman-yymm-loose', test: /^(\d{2})(\d{2})/, map: { year2000: 1, monthNum: 2 },
        confidence: 'low', note: 'YYMM assumed - serial length matches no known modern Goodman style, confirm against the plate',
        // Letters after the date block: goodman-yymm requires 10 straight
        // digits, so this reaches the fallback.
        examples: [['1907AB123', { year: 2019, month: 7 }]] },
    ],
  },
  {
    name: 'Rheem',
    category: 'hvac',
    family: 'Rheem Manufacturing',
    aliases: ['rheem', 'ruud', 'weatherking', 'weather king'],
    modelPrefixes: [/^(?:RA\d{2}|RP\d{2}|RH\d{2}|UA\d{2}|UP\d{2}|RGRM|RHKL|RHMV|RCBA)/],
    sources: [
      'https://hvacpricingguide.com/rheem-hvac-age-decoder/',
      'https://builderbuddy.com/blog/determine-the-age-of-your-heat-pump-ac-or-furnace/',
    ],
    serialRules: [
      { id: 'rheem-hvac-myy', test: /^([A-M])(\d{2})/i, map: { monthStd: 1, year2000: 2 },
        confidence: 'high', note: 'month-letter + YY',
        examples: [['F181234567', { year: 2018, month: 6 }]] },
      { id: 'rheem-hvac-wwyy', test: /^[A-Z](\d{2})(\d{2})/i, map: { week: 1, yearShort: 2 },
        confidence: 'low', note: 'older letter + week/year style',
        // Leading W is outside rheem-hvac-myy's [A-M] month letters, so the
        // older style is reached rather than shadowed by the month rule.
        examples: [['W2517ABCDE', { year: 2017, week: 25 }]] },
    ],
  },
  {
    name: 'Lennox',
    category: 'hvac',
    family: 'Lennox International',
    aliases: ['lennox'],
    // \d{2}HPX: Lennox's single-stage heat pump line (13HPX/14HPX/16HPX —
    // the leading number is the SEER/HSPF tier, not a brand-unrelated
    // digit). Confirmed from two real field nameplates ("13HPX-048-230-18",
    // "14HPX-060-230-19") that otherwise matched no Lennox prefix at all —
    // every existing entry here assumed the model starts with a LETTER.
    modelPrefixes: [/^(?:ML\d{2}|XC\d{2}|XP\d{2}|EL\d{3}|SL\d{2}|SLP\d{2}|CBX\d{2}|CBA\d{2}|\d{2}HPX)/],
    capacityRules: [
      { id: 'lennox-cap3', test: /-(\d{3})-/, map: { tons3: 1 },
        confidence: 'high', note: 'Lennox hyphen-delimited capacity field (kBTU/h)',
        examples: [['ML14XC1-030-230', 2.5], ['XC16-048-230', 4]] },
    ],
    sources: [
      'https://www.building-center.org/lennox-hvac-age/',
      'https://www.lennox.com/lib/legacy-res/pdfs/lennox_model_and_serial_nomenclature.pdf',
    ],
    serialRules: [
      // Ten characters: PP YY M ##### — plant(2), year(2), month letter(1).
      // Used exclusively since 1973, so the year half is solid. The month
      // LETTER map is where sources diverge: some publish A..L straight,
      // others A..M skipping I. We decode the year at high confidence and
      // explicitly de-rate the month rather than silently pick a map.
      { id: 'lennox-style1', test: /^\d{2}(\d{2})([A-M])\d{5}$/, map: { yearShort: 1, monthAlpha: 2 },
        confidence: 'high', monthConfidence: 'low',
        note: 'plant + YY + month letter (1973-present). Year is solid; the month letter map is inconsistent between published sources - read the plate MFG date if the month matters',
        examples: [['1606B13871', { year: 2006 }], ['5899L17212', { year: 1999 }]] },
    ],
  },
  {
    // Lennox International's Allied Air brands. Listed separately because
    // published guidance for these does NOT reliably match Lennox's own
    // Style 1 (at least one source reports Armstrong Air using a Goodman-like
    // YYMM instead). Rather than guess which, identify the brand and defer.
    name: 'Allied Air (Armstrong / AirEase / Concord / Ducane)',
    category: 'hvac',
    family: 'Lennox International',
    aliases: ['allied air', 'armstrong air', 'airease', 'aire-flo', 'aire flo', 'concord',
      'ducane', 'magic-pak', 'magic pak', 'allied commercial'],
    sources: ['https://www.building-center.org/lennox-hvac-age/'],
    serialRules: [],
    plateNote: 'Lennox International family. Published serial guidance conflicts between the Lennox plant style and a Goodman-style YYMM - read the MFG date on the plate.',
  },
  {
    // Nortek Global / Nordyne. Sources conflict badly on field positions
    // (BiC reads week/year from positions 9-12 of a hyphenated serial; other
    // decoders read year at 4-5 and month at 6-7). Not resolvable from public
    // sources without ground-truth plates — deliberately no rule.
    name: 'Nortek Global (Nordyne)',
    category: 'hvac',
    family: 'Nortek Global HVAC',
    aliases: ['nordyne', 'nortek', 'nortek global', 'intertherm', 'miller', 'mammoth',
      'manmouth', 'frigidaire', 'gibson', 'kelvinator', 'tappan', 'westinghouse',
      'philco', 'broan', 'airtemp'],
    sources: [
      'https://www.building-center.org/nordyne-hvac-age/',
      'http://www.hvacdecoder.com/nordyne-serial-number-decoder.html',
    ],
    serialRules: [],
    plateNote: 'Published serial-position guidance conflicts between sources for this family. Read the MFG date on the plate rather than trusting a decode.',
  },

  // ══════════════════ HVAC — DUCTLESS / VRF / IMPORT ══════════════════
  {
    // RESEARCHED 2026-07: published Mitsubishi serial guidance is
    // contradictory (first-two-digits-year vs digits-2-5-YYWW vs
    // letter+YY+MM), and a documented field case shows the YYWW reading
    // returning 2000 for a visibly ~5-year-old unit. Deliberately no rule
    // until ground-truth plates settle it.
    name: 'Mitsubishi Electric',
    category: 'hvac',
    family: 'Mitsubishi Electric',
    aliases: ['mitsubishi', 'mitsubishi electric', 'mr. slim', 'mr slim', 'city multi', 'kumo cloud', 'metus'],
    modelPrefixes: [/^(?:MSZ|MUZ|MSY|MUY|MXZ|MLZ|SEZ|SVZ|PKA|PUZ|PUY|PLA|PCA|PVA|PEAD|PURY|PUMY|PKFY|PEFY|PLFY|PDFY)/],
    sources: [],
    serialRules: [],
    plateNote: 'Published serial-date guidance for Mitsubishi conflicts between sources. Read the MFG date on the plate.',
  },
  {
    name: 'Fujitsu General',
    category: 'hvac',
    family: 'Fujitsu General',
    aliases: ['fujitsu', 'fujitsu general', 'halcyon'],
    modelPrefixes: [/^(?:AOU|ASU|AUU|ABU|AGU|ARU|AOY|ASY)/],
    sources: [],
    serialRules: [],
    plateNote: PLATE_DATE,
  },
  plateOnly('LG', 'hvac', ['lg electronics', 'lg air', 'lg hvac', 'multi v', 'art cool', 'artcool'], PLATE_DATE,
    { family: 'LG Electronics', modelPrefixes: [/^(?:LSU\d|LSN\d|LMU\d|LMN\d|ARUN|ARNU|LAU\d|LAN\d)/] }),
  plateOnly('Samsung', 'hvac', ['samsung', 'dvm s', 'wind-free', 'wind free'], PLATE_DATE,
    { family: 'Samsung', modelPrefixes: [/^(?:AR\d{2}|AJ\d{3}|AM\d{3})/] }),
  plateOnly('Bosch / Buderus', 'hvac', ['bosch', 'buderus', 'bosch thermotechnology'], PLATE_DATE,
    { family: 'Robert Bosch', modelPrefixes: [/^(?:BOVA|BOVB|BVA\d|IDS\d)/] }),
  plateOnly('MRCOOL', 'hvac', ['mrcool', 'mr cool', 'diy series'], PLATE_DATE, { family: 'MRCOOL' }),
  plateOnly('Haier / GE Appliances', 'hvac', ['haier', 'ge appliances', 'gea hvac'], PLATE_DATE, { family: 'Haier' }),
  plateOnly('Midea', 'hvac', ['midea'], PLATE_DATE, { family: 'Midea' }),
  plateOnly('Gree', 'hvac', ['gree'], PLATE_DATE, { family: 'Gree' }),
  plateOnly('Panasonic', 'hvac', ['panasonic', 'whispergreen', 'whisperceiling'], PLATE_DATE, { family: 'Panasonic' }),
  plateOnly('Toshiba Carrier', 'hvac', ['toshiba carrier', 'toshiba'], PLATE_DATE, { family: 'Carrier Global' }),
  plateOnly('Sanyo', 'hvac', ['sanyo'], PLATE_DATE,
    { family: 'Panasonic', notes: 'Legacy brand; HVAC line absorbed into Panasonic (~2012). Any Sanyo unit in the field is aging out.' }),
  plateOnly('Senville', 'hvac', ['senville'], PLATE_DATE, { family: 'Senville' }),
  plateOnly('Pioneer (Mini-Split)', 'hvac', ['pioneer mini', 'pioneer wys', 'pioneer diamante'], PLATE_DATE, { family: 'Parker Davis HVAC' }),
  plateOnly('Blueridge', 'hvac', ['blueridge'], PLATE_DATE, { family: 'Alpine Home Air' }),

  // ══════════════════ HVAC — COMMERCIAL / APPLIED ══════════════════
  {
    // Commercial line (chillers, AHUs) — DISTINCT nomenclature from the
    // Goodman-built residential "Daikin" line aliased above. Kept separate so
    // a McQuay/Daikin Applied unit doesn't get misread against Goodman's rules.
    name: 'Daikin Applied (McQuay)',
    category: 'hvac',
    family: 'Daikin Industries',
    aliases: ['daikin applied', 'mcquay', 'mc quay', 'snyder general', 'snydergeneral'],
    sources: [],
    serialRules: [],
    plateNote: PLATE_DATE,
  },
  plateOnly('AAON', 'hvac', ['aaon', 'aaonaire'], PLATE_DATE,
    { family: 'AAON', notes: 'AAON directs serial lookups to a local rep; no public serial-date scheme (researched 2026-07).' }),
  plateOnly('Bard', 'hvac', ['bard', 'bard manufacturing'], PLATE_DATE,
    { family: 'Bard', modelPrefixes: [/^(?:W\d{2}A|WA\d{2}|QW\d{2}|W3[LH])/] }),
  plateOnly('Liebert (Vertiv)', 'hvac', ['liebert', 'vertiv'], PLATE_DATE,
    { family: 'Vertiv', notes: 'Precision cooling for IT/data/server rooms.' }),
  plateOnly('Reznor', 'hvac', ['reznor'], NO_SCHEME, { noTonnage: true, family: 'Nortek Global HVAC' }),
  plateOnly('Modine', 'hvac', ['modine'], PLATE_DATE, { noTonnage: true, family: 'Modine' }),
  plateOnly('Marvair', 'hvac', ['marvair'], PLATE_DATE, { family: 'Airxcel' }),
  plateOnly('First Co', 'hvac', ['first co', 'first company'], PLATE_DATE, { family: 'First Co' }),
  plateOnly('WaterFurnace', 'hvac', ['waterfurnace', 'water furnace'], PLATE_DATE, { family: 'NIBE' }),
  plateOnly('ClimateMaster', 'hvac', ['climatemaster', 'climate master'], PLATE_DATE, { family: 'LSB Industries' }),
  plateOnly('Friedrich', 'hvac', ['friedrich'], PLATE_DATE,
    { family: 'Friedrich', modelPrefixes: [/^(?:PDE|PDH|PZE|PZH)\d{3}/] }),
  plateOnly('Multistack', 'hvac', ['multistack'], PLATE_DATE, { family: 'Multistack' }),
  plateOnly('Smardt', 'hvac', ['smardt'], PLATE_DATE, { family: 'Smardt' }),
  plateOnly('Dunham-Bush', 'hvac', ['dunham-bush', 'dunham bush'], PLATE_DATE, { family: 'Dunham-Bush' }),
  plateOnly('Nortek Air Solutions', 'hvac', ['nortek air solutions', 'temtrol', 'huntair', 'governair', 'ventrol', 'mammoth ahu'], PLATE_DATE,
    { noTonnage: true, family: 'Nortek Air Solutions', notes: 'Custom air handlers (Temtrol / Huntair / Governair / Ventrol).' }),
  plateOnly('Munters', 'hvac', ['munters'], PLATE_DATE, { noTonnage: true, family: 'Munters', notes: 'Desiccant dehumidification / DOAS.' }),
  plateOnly('Desert Aire', 'hvac', ['desert aire', 'desertaire'], PLATE_DATE, { noTonnage: true, family: 'Desert Aire' }),
  plateOnly('Dectron', 'hvac', ['dectron'], PLATE_DATE, { noTonnage: true, family: 'Dectron', notes: 'Pool/natatorium dehumidification.' }),
  plateOnly('Seresco', 'hvac', ['seresco'], PLATE_DATE, { noTonnage: true, family: 'Seresco', notes: 'Pool/natatorium dehumidification.' }),

  // ══════════════════ HVAC — HEAT REJECTION / AIR MOVING ══════════════════
  plateOnly('Baltimore Aircoil (BAC)', 'hvac', ['baltimore aircoil', 'baltimore air coil'], PLATE_DATE, { noTonnage: true, family: 'BAC' }),
  plateOnly('Marley (SPX)', 'hvac', ['marley cooling', 'spx cooling'], PLATE_DATE, { noTonnage: true, family: 'SPX' }),
  plateOnly('Evapco', 'hvac', ['evapco'], PLATE_DATE, { noTonnage: true, family: 'Evapco' }),
  plateOnly('Delta Cooling Towers', 'hvac', ['delta cooling'], PLATE_DATE, { noTonnage: true, family: 'Delta Cooling Towers' }),
  plateOnly('Greenheck', 'hvac', ['greenheck'], PLATE_DATE, { noTonnage: true, family: 'Greenheck' }),
  plateOnly('Loren Cook', 'hvac', ['loren cook', 'cook fan'], PLATE_DATE, { noTonnage: true, family: 'Loren Cook' }),
  plateOnly('PennBarry', 'hvac', ['pennbarry', 'penn barry', 'penn ventilation'], PLATE_DATE, { noTonnage: true, family: 'PennBarry' }),
  plateOnly('Twin City Fan', 'hvac', ['twin city fan', 'twin city'], PLATE_DATE, { noTonnage: true, family: 'Twin City' }),
  plateOnly('CaptiveAire', 'hvac', ['captiveaire', 'captive aire'], PLATE_DATE, { noTonnage: true, family: 'CaptiveAire' }),
  plateOnly('Soler & Palau', 'hvac', ['soler & palau', 'soler and palau', 's&p fan'], PLATE_DATE, { noTonnage: true, family: 'Soler & Palau' }),
  plateOnly('Fantech', 'hvac', ['fantech'], PLATE_DATE, { noTonnage: true, family: 'Systemair' }),
  plateOnly('Big Ass Fans', 'hvac', ['big ass fans', 'bigassfans', 'haiku fan'], PLATE_DATE, { noTonnage: true, family: 'Big Ass Fans' }),
  plateOnly('New York Blower', 'hvac', ['new york blower', 'nyb fan'], PLATE_DATE, { noTonnage: true, family: 'New York Blower' }),
  plateOnly('Hartzell', 'hvac', ['hartzell'], PLATE_DATE, { noTonnage: true, family: 'Hartzell Air Movement' }),
  plateOnly('Aerovent', 'hvac', ['aerovent'], PLATE_DATE, { noTonnage: true, family: 'Twin City Fan' }),
  plateOnly('RenewAire', 'hvac', ['renewaire', 'renew aire'], PLATE_DATE, { noTonnage: true, family: 'Soler & Palau', notes: 'ERV/HRV energy recovery.' }),

  // ══════════════════ HVAC — UNIT HEATERS / RADIANT / AIR CURTAINS ══════════════════
  plateOnly('Sterling HVAC', 'hvac', ['sterling hvac', 'sterling heater'], PLATE_DATE, { noTonnage: true, family: 'Mestek' }),
  plateOnly('Detroit Radiant', 'hvac', ['detroit radiant', 're-verber-ray', 'reverber-ray', 'reverberray'], PLATE_DATE, { noTonnage: true, family: 'Detroit Radiant' }),
  plateOnly('Roberts-Gordon', 'hvac', ['roberts-gordon', 'roberts gordon', 'corayvac'], PLATE_DATE, { noTonnage: true, family: 'Roberts-Gordon' }),
  plateOnly('Space-Ray', 'hvac', ['space-ray', 'space ray'], PLATE_DATE, { noTonnage: true, family: 'Gas Fired Products' }),
  plateOnly('Berner', 'hvac', ['berner'], PLATE_DATE, { noTonnage: true, family: 'Berner International', notes: 'Air curtains.' }),
  plateOnly('Mars Air', 'hvac', ['mars air'], PLATE_DATE, { noTonnage: true, family: 'Mars Air Systems', notes: 'Air curtains.' }),
  plateOnly('Cambridge Air', 'hvac', ['cambridge air', 'cambridge engineering'], PLATE_DATE, { noTonnage: true, family: 'Cambridge Air Solutions', notes: 'Direct-fired makeup air.' }),
  plateOnly('Marley Engineered (QMark / Berko)', 'hvac', ['qmark', 'berko', 'marley engineered'], PLATE_DATE, { noTonnage: true, family: 'Marley Engineered Products', notes: 'Electric unit/wall/baseboard heaters.' }),
  plateOnly('Chromalox', 'hvac', ['chromalox'], PLATE_DATE, { noTonnage: true, family: 'Spirax-Sarco', notes: 'Electric heat.' }),
  plateOnly('Indeeco', 'hvac', ['indeeco'], PLATE_DATE, { noTonnage: true, family: 'Indeeco', notes: 'Electric duct/unit heat.' }),
  plateOnly('TPI (Markel)', 'hvac', ['tpi corporation', 'markel heater', 'fostoria'], PLATE_DATE, { noTonnage: true, family: 'TPI Corporation' }),
  plateOnly('Aprilaire', 'hvac', ['aprilaire', 'april aire'], PLATE_DATE, { noTonnage: true, family: 'Madison Industries', notes: 'Humidifiers / IAQ.' }),
  plateOnly('DriSteem', 'hvac', ['dristeem', 'dri-steem'], PLATE_DATE, { noTonnage: true, family: 'Research Products', notes: 'Steam humidification.' }),
  plateOnly('Condair (Nortec)', 'hvac', ['condair', 'nortec'], PLATE_DATE, { noTonnage: true, family: 'Condair Group' }),

  // ══════════════════ HVAC / REFRIGERATION — COMPRESSORS ══════════════════
  // A compressor plate frequently survives when the unit's own plate is gone,
  // painted over, or sun-bleached — and Copeland documents its own date code.
  // NOTE: compressor nominal capacity approximates, but is not identical to,
  // the SYSTEM's nominal tonnage. The capacity rule is rated accordingly.
  {
    name: 'Copeland',
        // A COMPONENT brand, not a unit brand. Compressors carry their own
    // nameplate inside the cabinet, and a surveyor photographing a
    // condensing unit routinely captures both in one frame. The compressor
    // label must never win brand detection over the unit label — it selects
    // the wrong serial rules and reports the compressor's build date as the
    // equipment's manufacture date, which is often years apart and always
    // the wrong number for a service-life assessment.
    componentBrand: true,
    category: 'hvac',
    family: 'Copeland (Emerson)',
    aliases: ['copeland', 'copeland scroll', 'emerson climate'],
    modelPrefixes: [/^Z[RPBSFHWO]D?\d{2,3}K/, /^(?:CR|RS)\d{2}K/, /^[2-9]D[A-Z]\d/],
    capacityRules: [
      { id: 'copeland-kbtu', test: /^Z[RPBSFHWO]D?(\d{2,3})K/, map: { kbtu: 1 },
        confidence: 'medium', note: 'Copeland scroll nominal capacity (kBTU/h) - approximates, may not equal, system tonnage',
        examples: [['ZR40KC-PFV-230', 3.3], ['ZP31K5E-PFV', 2.6]] },
    ],
    sources: [
      'https://copeland.custhelp.com/app/answers/detail/a_id/4983',
      'https://www.electrical-forensics.com/HVAC/HVAC_CompressorDateCodes.html',
    ],
    serialRules: [
      // Manufacturer-documented: 8-9 char serial, first two digits = year,
      // third char = month letter (straight alphabet, C=March). An 'N' in
      // place of the first year digit marks a no-warranty/salvage unit and
      // is intentionally not decodable.
      { id: 'copeland-yym', test: /^(\d{2})([A-L])\d{4,6}[A-Z]{0,3}$/, map: { yearShort: 1, monthAlpha: 2 },
        confidence: 'high', note: 'YY + month letter (Copeland-documented)',
        examples: [['01D1020HL', { year: 2001, month: 4 }], ['03C12345', { year: 2003, month: 3 }]] },
    ],
  },
  {
    name: 'Bristol Compressors',
        // A COMPONENT brand, not a unit brand. Compressors carry their own
    // nameplate inside the cabinet, and a surveyor photographing a
    // condensing unit routinely captures both in one frame. The compressor
    // label must never win brand detection over the unit label — it selects
    // the wrong serial rules and reports the compressor's build date as the
    // equipment's manufacture date, which is often years apart and always
    // the wrong number for a service-life assessment.
    componentBrand: true,
    category: 'hvac',
    family: 'Bristol Compressors',
    aliases: ['bristol', 'bristol compressors'],
    sources: ['https://www.electrical-forensics.com/HVAC/HVAC_CompressorDateCodes.html'],
    serialRules: [
      // Julian day (1-3) + year (4-5) + plant digit (0 or 2) + sequence.
      { id: 'bristol-jjjyy', test: /^([0-3]\d{2})(\d{2})[02]\d{4,6}/, map: { julianDay: 1, yearShort: 2 },
        confidence: 'medium', note: 'Julian day + YY (reciprocating compressors; Bristol ceased production 2018)',
        examples: [['19597011199', { year: 1997, month: 7 }]] },
    ],
  },
  {
    name: 'Tecumseh',
        // A COMPONENT brand, not a unit brand. Compressors carry their own
    // nameplate inside the cabinet, and a surveyor photographing a
    // condensing unit routinely captures both in one frame. The compressor
    // label must never win brand detection over the unit label — it selects
    // the wrong serial rules and reports the compressor's build date as the
    // equipment's manufacture date, which is often years apart and always
    // the wrong number for a service-life assessment.
    componentBrand: true,
    category: 'hvac',
    family: 'Tecumseh Products',
    aliases: ['tecumseh'],
    sources: ['https://www.electrical-forensics.com/HVAC/HVAC_CompressorDateCodes.html'],
    serialRules: [
      // 5-char DATE CODE stamp (separate from the serial): month letter +
      // day + YY. H2995 = Aug 29, 1995.
      { id: 'tecumseh-mddyy', test: /^([A-L])([0-3]\d)(\d{2})$/, map: { monthAlpha: 1, yearShort: 3 },
        confidence: 'medium', note: '5-character DATE CODE stamp (month letter + day + YY) - enter the date code, not the serial',
        examples: [['H2995', { year: 1995, month: 8 }]] },
    ],
  },
  {
    name: 'Scroll Technologies (Millennium)',
    category: 'hvac',
    family: 'Carlyle / Bristol JV',
    aliases: ['scroll technologies', 'millennium compressor', 'millenium compressor'],
    sources: ['https://www.electrical-forensics.com/HVAC/HVAC_CompressorDateCodes.html'],
    serialRules: [
      { id: 'scrolltech-swwyy', test: /^S(\d{2})(\d{2})[A-Z]\d{4,6}$/, map: { week: 1, yearShort: 2 },
        confidence: 'medium', note: 'S + week + YY + plant letter',
        examples: [['S3497K05252', { year: 1997, week: 34 }]] },
    ],
  },
  plateOnly('Carlyle', 'hvac', ['carlyle'], PLATE_DATE,
    { noTonnage: true, family: 'Carrier Global', modelPrefixes: [/^0[56][DEGTMNK]/],
      notes: 'Carrier compressor division (06D/06E semi-hermetics).' }),
  plateOnly('Danfoss', 'hvac', ['danfoss', 'turbocor'], PLATE_DATE,
    { noTonnage: true, family: 'Danfoss', notes: 'Compressors (incl. Turbocor oil-free), drives, and controls.' }),

  // ══════════════════ REFRIGERATION — COMMERCIAL / GROCERY / KITCHEN ══════════════════
  plateOnly('Hussmann', 'hvac', ['hussmann'], PLATE_DATE, { noTonnage: true, family: 'Panasonic', notes: 'Display cases / refrigeration racks.' }),
  plateOnly('Heatcraft (Bohn / Larkin / Chandler)', 'hvac', ['heatcraft', 'bohn', 'larkin', 'chandler refrigeration', 'climate control refrigeration'], PLATE_DATE,
    { noTonnage: true, family: 'Lennox International' }),
  plateOnly('True Manufacturing', 'hvac', ['true manufacturing', 'true refrigeration', 'true mfg'], PLATE_DATE, { noTonnage: true, family: 'True Manufacturing' }),
  plateOnly('Master-Bilt', 'hvac', ['master-bilt', 'master bilt', 'masterbilt'], PLATE_DATE, { noTonnage: true, family: 'Standex' }),
  plateOnly('Kysor Warren', 'hvac', ['kysor warren', 'kysor/warren'], PLATE_DATE, { noTonnage: true, family: 'Epta Group' }),
  plateOnly('Russell', 'hvac', ['russell refrigeration', 'russell coil'], PLATE_DATE, { noTonnage: true, family: 'HTPG' }),
  plateOnly('Gaylord', 'hvac', ['gaylord industries', 'gaylord hood'], PLATE_DATE, { noTonnage: true, family: 'Gaylord Industries', notes: 'Kitchen ventilation hoods.' }),
  plateOnly('Halton', 'hvac', ['halton'], PLATE_DATE, { noTonnage: true, family: 'Halton Group', notes: 'Kitchen ventilation hoods.' }),
  plateOnly('Accurex', 'hvac', ['accurex'], PLATE_DATE, { noTonnage: true, family: 'Greenheck', notes: 'Kitchen ventilation.' }),

  // ══════════════════ HVAC — TERMINAL / DISTRIBUTION ══════════════════
  plateOnly('Titus', 'hvac', ['titus'], PLATE_DATE, { noTonnage: true, family: 'Air Distribution Technologies' }),
  plateOnly('Price', 'hvac', ['price industries'], PLATE_DATE, { noTonnage: true, family: 'Price' }),
  plateOnly('Nailor', 'hvac', ['nailor'], PLATE_DATE, { noTonnage: true, family: 'Nailor' }),
  plateOnly('Krueger', 'hvac', ['krueger'], PLATE_DATE, { noTonnage: true, family: 'Air Distribution Technologies' }),
  plateOnly('Metalaire', 'hvac', ['metalaire', 'metal aire'], PLATE_DATE, { noTonnage: true, family: 'Metal Industries' }),
  plateOnly('Carnes', 'hvac', ['carnes'], PLATE_DATE, { noTonnage: true, family: 'Carnes' }),
  plateOnly('Tuttle & Bailey', 'hvac', ['tuttle & bailey', 'tuttle and bailey'], PLATE_DATE, { noTonnage: true, family: 'Air Distribution Technologies' }),
  plateOnly('Anemostat', 'hvac', ['anemostat'], PLATE_DATE, { noTonnage: true, family: 'Mestek' }),

  // ══════════════════ HVAC — HYDRONIC / BOILERS ══════════════════
  plateOnly('Weil-McLain', 'hvac', ['weil-mclain', 'weil mclain', 'weilmclain'], NO_SCHEME,
    { noTonnage: true, family: 'Marley-Wylain', modelPrefixes: [/^(?:CGA|CGI|EG-|GV\d|WGO|WTGO|SGO|LGB|ECO|EVG|WM97)/],
      notes: 'Weil-McLain uses CP numbers for date of manufacture; decoding requires contacting the manufacturer.' }),
  plateOnly('Burnham', 'hvac', ['burnham', 'u.s. boiler', 'us boiler'], NO_SCHEME, { noTonnage: true, family: 'Burnham Holdings' }),
  plateOnly('Peerless', 'hvac', ['peerless boiler', 'peerless heater'], NO_SCHEME, { noTonnage: true, family: 'Burnham Holdings' }),
  plateOnly('Lochinvar', 'hvac', ['lochinvar'], PLATE_DATE,
    { noTonnage: true, family: 'A.O. Smith', modelPrefixes: [/^(?:EBP|KBN|KHN|CDN|SNA|SNR|WHN|CGN|CBN|RBN|RGN)/] }),
  plateOnly('Raypak', 'hvac', ['raypak'], PLATE_DATE, { noTonnage: true, family: 'Rheem Manufacturing' }),
  plateOnly('Laars', 'hvac', ['laars'], PLATE_DATE, { noTonnage: true, family: 'Bradford White' }),
  plateOnly('Slant/Fin', 'hvac', ['slant/fin', 'slant fin', 'slantfin'], NO_SCHEME, { noTonnage: true, family: 'Slant/Fin' }),
  plateOnly('Cleaver-Brooks', 'hvac', ['cleaver-brooks', 'cleaver brooks'], PLATE_DATE, { noTonnage: true, family: 'Cleaver-Brooks' }),
  plateOnly('AERCO', 'hvac', ['aerco'], PLATE_DATE, { noTonnage: true, family: 'Watts Water' }),
  plateOnly('Bryan Boilers', 'hvac', ['bryan boiler', 'bryan steam'], PLATE_DATE, { noTonnage: true, family: 'Bryan Steam' }),
  plateOnly('RBI', 'hvac', ['rbi boiler'], PLATE_DATE, { noTonnage: true, family: 'Mestek' }),
  plateOnly('Thermo Pride', 'hvac', ['thermo pride', 'thermopride'], NO_SCHEME,
    { noTonnage: true, family: 'Thermo Products', notes: 'Manufacturer states there is no dating system in their serial numbers.' }),
  plateOnly('New Yorker', 'hvac', ['new yorker boiler'], NO_SCHEME,
    { noTonnage: true, family: 'New Yorker', notes: 'Sequential serial numbers; production date is printed on the data plate.' }),
  plateOnly('Fulton', 'hvac', ['fulton boiler', 'fulton heating'], PLATE_DATE, { noTonnage: true, family: 'Fulton' }),
  plateOnly('Miura', 'hvac', ['miura'], PLATE_DATE, { noTonnage: true, family: 'Miura', notes: 'Modular on-demand steam boilers.' }),
  plateOnly('Patterson-Kelley', 'hvac', ['patterson-kelley', 'patterson kelley'], PLATE_DATE, { noTonnage: true, family: 'Harsco' }),
  plateOnly('Viessmann', 'hvac', ['viessmann'], PLATE_DATE, { noTonnage: true, family: 'Viessmann (Carrier Global)' }),
  plateOnly('Triangle Tube', 'hvac', ['triangle tube', 'prestige boiler'], PLATE_DATE, { noTonnage: true, family: 'ACV' }),
  plateOnly('NTI', 'hvac', ['nti boiler', 'ny thermal'], PLATE_DATE, { noTonnage: true, family: 'NY Thermal' }),
  plateOnly('HTP', 'hvac', ['htp boiler', 'heat transfer products'], PLATE_DATE, { noTonnage: true, family: 'HTP (Ariston)' }),
  plateOnly('Smith Cast Iron', 'hvac', ['smith cast iron', 'smith boiler'], PLATE_DATE, { noTonnage: true, family: 'Mestek' }),

  // ══════════════════ HVAC — PUMPS / MOTORS ══════════════════
  plateOnly('Bell & Gossett', 'hvac', ['bell & gossett', 'bell and gossett', 'b&g'], PLATE_DATE, { noTonnage: true, family: 'Xylem' }),
  plateOnly('Taco', 'hvac', ['taco comfort', 'taco pump'], PLATE_DATE, { noTonnage: true, family: 'Taco' }),
  plateOnly('Grundfos', 'hvac', ['grundfos'], PLATE_DATE, { noTonnage: true, family: 'Grundfos' }),
  plateOnly('Armstrong Fluid', 'hvac', ['armstrong fluid', 'armstrong pump'], PLATE_DATE, { noTonnage: true, family: 'Armstrong Fluid Technology' }),
  plateOnly('Goulds', 'hvac', ['goulds'], PLATE_DATE, { noTonnage: true, family: 'Xylem' }),
  plateOnly('Wilo', 'hvac', ['wilo'], PLATE_DATE, { noTonnage: true, family: 'Wilo' }),
  plateOnly('Aurora Pump', 'hvac', ['aurora pump'], PLATE_DATE, { noTonnage: true, family: 'Pentair' }),
  plateOnly('PACO Pumps', 'hvac', ['paco pump', 'paco pumps'], PLATE_DATE, { noTonnage: true, family: 'Grundfos' }),
  plateOnly('Peerless Pump', 'hvac', ['peerless pump'], PLATE_DATE, { noTonnage: true, family: 'Grundfos' }),
  plateOnly('Zoeller', 'hvac', ['zoeller'], PLATE_DATE, { noTonnage: true, family: 'Zoeller', notes: 'Sump/sewage/effluent pumps.' }),
  plateOnly('Liberty Pumps', 'hvac', ['liberty pump', 'liberty pumps'], PLATE_DATE, { noTonnage: true, family: 'Liberty Pumps' }),
  plateOnly('Little Giant', 'hvac', ['little giant'], PLATE_DATE, { noTonnage: true, family: 'Franklin Electric', notes: 'Condensate/sump pumps.' }),
  plateOnly('Ebara', 'hvac', ['ebara'], PLATE_DATE, { noTonnage: true, family: 'Ebara' }),

  // ══════════════════════ WATER HEATERS ══════════════════════
  {
    name: 'Rheem (Water Heater)',
    category: 'waterheater',
    family: 'Rheem Manufacturing',
    aliases: ['rheem', 'ruud', 'richmond', 'general electric', 'ge', 'vanguard', 'weatherking', 'weather king'],
    modelPrefixes: [/^(?:XE|XG|XP|PRO|GHE|ELD|RTGH|RTG)/],
    sources: [
      'https://waterheaterrescue.ca/wp-content/uploads/2017/08/Water-Heater-Age-Decoder.pdf',
      'https://fastwaterheater.com/blog/find-your-water-tank-age-based-on-the-brand/',
    ],
    serialRules: [
      // Rheem's own two examples don't even agree on internal shape
      // (one all-digit, one digit-letter-digit) — multiple independent
      // sources confirm Rheem genuinely varies serial format by plant/era
      // even within the "modern" MMYY-prefixed style, so this can't be
      // anchored to one exact character pattern without rejecting real,
      // validly-different serials (a false-negative trade that's worse
      // than the false-positive it would fix). What IS consistent across
      // every documented modern Rheem format is total length: 10-11
      // characters. Bounding length (without constraining what's inside
      // it) still blocks the actual failure mode seen in the field —
      // short noise fragments and long unrelated digit runs "decoding"
      // to a plausible month/year — while staying honest about the
      // brand's real format variability.
      { id: 'rheem-wh-mmyy', test: /^(\d{2})(\d{2})[A-Z0-9]{6,7}$/, map: { monthNum: 1, yearShort: 2 },
        confidence: 'high', note: 'MMYY (month+year), 10-11 char modern format',
        examples: [['0884810488', { year: 1984, month: 8 }], ['1291A39968', { year: 1991, month: 12 }]] },
      { id: 'rheem-wh-mmyy-loose', test: /^(\d{2})(\d{2})/, map: { monthNum: 1, yearShort: 2 },
        confidence: 'low', note: 'MMYY assumed - serial length matches no known modern Rheem style, confirm against the plate',
        // MMYY here vs YYWW on A.O. Smith's identically shaped fallback: the
        // same four digits mean different things, which is the whole reason
        // a mis-attributed brand produces a confident wrong year.
        examples: [['0819ABC', { year: 2019, month: 8 }]] },
    ],
  },
  {
    name: 'A.O. Smith (Water Heater)',
    category: 'waterheater',
    family: 'A.O. Smith',
    aliases: ['a.o. smith', 'ao smith', 'a o smith', 'state', 'reliance', 'american water heater',
      'american', 'us craftmaster', 'craftmaster', 'whirlpool', 'kenmore', 'gsw', 'glascote', 'perma-glas'],
    // EJC added: A.O. Smith's point-of-use/lavatory water heater line, seen
    // in the field (model "EJC 6 200"). Not adding State Industries' "EN6"
    // family here — "EN" alone is too short/generic a prefix for a fallback
    // match and risks false-positiving on unrelated brands; that unit's
    // brand still detects fine from the plate text itself.
    modelPrefixes: [/^(?:GCV|GPV|GDHE|ENT|ENS|FPSH|BTH|DVE|DRE|HYB|XCV|EJC)/],
    sources: [
      'https://fastwaterheater.com/water-heaters/water-heater-model-numbers-rating-plates/',
      'https://kcwaterheater.com/how-old-is-my-water-heater/',
    ],
    serialRules: [
      // Multiple independent sources confirm the modern (2008+) A.O.
      // Smith format is 10-13 characters total, YYWW + plant
      // code/sequence — both DB examples are 10 chars with a plant
      // letter at position 5. Anchoring length (loosely, to match the
      // documented 10-13 range) blocks the same false-positive shape as
      // the Carrier/Goodman fix: a bare 4-digit prefix test let any
      // digit-leading noise token "decode" to a plausible year/week.
      { id: 'aosmith-yyww', test: /^(\d{2})(\d{2})[A-Z0-9]{6,9}$/, map: { year2000: 1, week: 2 },
        confidence: 'high', note: 'YYWW (year+week), 10-13 char modern format',
        examples: [['1512A00000', { year: 2015, week: 12 }], ['1220A00000', { year: 2012, week: 20 }]] },
      { id: 'aosmith-yyww-loose', test: /^(\d{2})(\d{2})/, map: { year2000: 1, week: 2 },
        confidence: 'low', note: 'YYWW assumed - serial length matches no known modern A.O. Smith style, confirm against the plate',
        examples: [['1533AB', { year: 2015, week: 33 }]] },
    ],
  },
  {
    name: 'Bradford White',
    category: 'waterheater',
    family: 'Bradford White',
    aliases: ['bradford white', 'bradford-white', 'jetglas'],
    modelPrefixes: [/^(?:RG1|RG2|M-I|M-2|MI\d|UDS|LE\d|TW\d|RE\d|EF\d)/],
    sources: [
      'https://www.modernpi.com/wp-content/uploads/2026/05/2011916121457_WaterHeaterSerialNumberDecoder.pdf',
      'https://hotwatersolutionsnw.org/how-to-determine-the-age-of-your-water-heater/',
    ],
    serialRules: [
      { id: 'bw-letters', test: /^([A-Z])([A-M])/i, map: { bwYear: 1, monthStd: 2 },
        confidence: 'low', note: '20-year letter cycle (A=1984 or 2004…) - building age breaks the tie',
        examples: [['CJ1234567', { yearIn: [1986, 2006, 2026], month: 9 }]] },
    ],
  },
  {
    name: 'Navien',
    category: 'waterheater',
    family: 'KD Navien',
    aliases: ['navien'],
    modelPrefixes: [/^(?:NPE|NCB|NPN|NFC|NFB|NHB)/],
    sources: ['https://builderbuddy.com/blog/determine-the-age-of-your-water-heater/'],
    serialRules: [
      { id: 'navien-yyyy', test: /\d{4}(20[0-3]\d)/, map: { yearFull: 1 },
        confidence: 'low', note: 'Navien embeds a 4-digit year mid-serial; position varies',
        examples: [['12342019ABC', { year: 2019 }]] },
    ],
  },
  {
    name: 'Rinnai',
    category: 'waterheater',
    family: 'Rinnai',
    aliases: ['rinnai'],
    modelPrefixes: [/^(?:RU\d|RUC|RUR|RL\d|CU\d{3}|V\d{2})/],
    sources: ['https://builderbuddy.com/blog/determine-the-age-of-your-heat-pump-ac-or-furnace/'],
    serialRules: [
      { id: 'rinnai-yy', test: /^(\d{2})\d{6,}/, map: { year2000: 1 },
        confidence: 'medium', note: 'first two digits are the year of manufacture',
        examples: [['1912345678', { year: 2019 }]] },
    ],
  },
  plateOnly('Noritz', 'waterheater', ['noritz'], PLATE_DATE,
    { family: 'Noritz', modelPrefixes: [/^(?:NRC|NCC|NR\d{2}|EZ\d{2})/] }),
  plateOnly('Takagi', 'waterheater', ['takagi'], PLATE_DATE, { family: 'A.O. Smith' }),
  plateOnly('Lochinvar (Water Heater)', 'waterheater', ['lochinvar'], PLATE_DATE, { family: 'A.O. Smith' }),
  plateOnly('Bosch (Water Heater)', 'waterheater', ['bosch', 'buderus'], PLATE_DATE, { family: 'Robert Bosch' }),
  plateOnly('Eemax', 'waterheater', ['eemax'], PLATE_DATE, { family: 'Rheem Manufacturing' }),
  plateOnly('Chronomite', 'waterheater', ['chronomite'], PLATE_DATE, { family: 'Chronomite' }),
  plateOnly('PVI', 'waterheater', ['pvi industries', 'pvi water'], PLATE_DATE, { family: 'Watts Water' }),
  plateOnly('Stiebel Eltron', 'waterheater', ['stiebel eltron', 'stiebel'], PLATE_DATE, { family: 'Stiebel Eltron' }),
  plateOnly('Bock', 'waterheater', ['bock water'], PLATE_DATE, { family: 'Bock Water Heaters' }),
  plateOnly('Hubbell (Water Heater)', 'waterheater', ['hubbell water', 'hubbell heater'], PLATE_DATE, { family: 'Hubbell' }),
  plateOnly('Vaughn', 'waterheater', ['vaughn'], PLATE_DATE, { family: 'Vaughn Thermal' }),
  plateOnly('Intellihot', 'waterheater', ['intellihot'], PLATE_DATE, { family: 'Intellihot' }),

  // ══════════════════════ ELECTRICAL ══════════════════════
  // Panelboards/breakers generally do NOT encode a decodable manufacture date
  // in any standard way. These entries exist for brand detection + rating
  // extraction, and are honest that year is not derivable from the serial.
  // Several carry a `hazard` note — obsolete gear a surveyor should call out
  // regardless of age.
  {
    // Square D serials are NOT date-coded, but Schneider documents a separate
    // DATE CODE stamp: a 5-digit number on the blue deadfront label (YY WW D,
    // day 1=Monday) used since 1956, and a 4-digit YYWW laser-etch on newer
    // QO/HOM breaker faces. The rules below decode that date code — enter it
    // in the serial field. Pre-1970 codes fall outside the engine's
    // plausibility window and won't decode.
    name: 'Square D',
    category: 'electrical',
    family: 'Schneider Electric',
    aliases: ['square d', 'square-d', 'schneider electric', 'schneider'],
    modelPrefixes: [/^(?:QOB|NQOD|NQ\d|NF\d|HCM|QMB)/],
    sources: [
      'https://www.se.com/us/en/faqs/FA125869/',
      'https://www.se.com/us/en/faqs/FA125241/',
    ],
    serialRules: [
      { id: 'squared-yywwd', test: /^(\d{2})(\d{2})[1-7]$/, map: { yearShort: 1, week: 2 },
        confidence: 'medium', note: '5-digit deadfront DATE CODE (YY WW day-of-week) - enter the date code, not the serial',
        examples: [['97171', { year: 1997, week: 17 }]] },
      { id: 'squared-yyww', test: /^(\d{2})(\d{2})$/, map: { yearShort: 1, week: 2 },
        confidence: 'low', note: '4-digit breaker-face date code (YYWW), laser-etched near the handle',
        examples: [['0925', { year: 2009, week: 25 }]] },
    ],
    plateNote: 'Serial numbers are not date-coded. Look for the 5-digit date code on the blue deadfront label (YY WW D) or the 4-digit YYWW etch on the breaker face.',
  },
  plateOnly('Eaton', 'electrical', ['eaton', 'cutler-hammer', 'cutler hammer'], NO_SCHEME,
    { family: 'Eaton', modelPrefixes: [/^(?:BR\d|CH\d|POW-R|PRL\d)/] }),
  plateOnly('Siemens', 'electrical', ['siemens', 'i-t-e', 'ite panel'], NO_SCHEME,
    { family: 'Siemens', modelPrefixes: [/^(?:P[1-5]\d|EQ\d|HED\d|ED\d)/] }),
  plateOnly('GE (Electrical)', 'electrical', ['general electric', 'ge electrical'], NO_SCHEME,
    { family: 'ABB', notes: 'GE Industrial Solutions was acquired by ABB in 2018; newer GE-branded gear may be ABB-built.' }),
  plateOnly('ABB', 'electrical', ['abb', 'asea brown boveri'], NO_SCHEME, { family: 'ABB' }),
  plateOnly('Federal Pacific', 'electrical', ['federal pacific', 'fpe', 'stab-lok', 'stab lok'], NO_SCHEME,
    { family: 'Federal Pacific', hazard: 'Stab-Lok panels have a documented history of breakers failing to trip. Flag for evaluation regardless of decoded age.' }),
  plateOnly('Zinsco', 'electrical', ['zinsco', 'sylvania-zinsco', 'gte sylvania'], NO_SCHEME,
    { family: 'Zinsco', hazard: 'Zinsco panels have a documented history of breakers failing to trip. Flag for evaluation regardless of decoded age.' }),
  plateOnly('Challenger', 'electrical', ['challenger panel', 'challenger electric'], NO_SCHEME,
    { family: 'Challenger', hazard: 'Some Challenger panels are subject to known breaker-failure concerns. Flag for evaluation.' }),
  plateOnly('Murray', 'electrical', ['murray panel', 'murray electric'], NO_SCHEME, { family: 'Siemens' }),
  plateOnly('Pushmatic (Bulldog)', 'electrical', ['pushmatic', 'bulldog electric'], NO_SCHEME,
    { family: 'ITE / Siemens (legacy)', hazard: 'Obsolete panel line; breakers are no longer manufactured and grease-packed mechanisms stiffen with age. Flag for evaluation.' }),
  plateOnly('Wadsworth', 'electrical', ['wadsworth'], NO_SCHEME,
    { family: 'Wadsworth (defunct)', hazard: 'Obsolete panel manufacturer (defunct ~1980s); replacement breakers are scarce. Flag for evaluation.' }),
  plateOnly('Crouse-Hinds', 'electrical', ['crouse-hinds', 'crouse hinds'], NO_SCHEME, { family: 'Eaton' }),
  plateOnly('Acme Electric', 'electrical', ['acme electric', 'acme transformer'], PLATE_DATE, { family: 'Hubbell', notes: 'Dry-type transformers.' }),
  plateOnly('Hammond Power', 'electrical', ['hammond power', 'hammond transformer'], PLATE_DATE, { family: 'Hammond Power Solutions' }),
  plateOnly('Sola HD', 'electrical', ['sola hd', 'sola hevi-duty', 'sola transformer'], PLATE_DATE, { family: 'Emerson' }),
  plateOnly('Jefferson Electric', 'electrical', ['jefferson electric'], PLATE_DATE, { family: 'Jefferson Electric', notes: 'Transformers.' }),
  plateOnly('Yaskawa', 'electrical', ['yaskawa'], PLATE_DATE, { family: 'Yaskawa', notes: 'Variable frequency drives.' }),
  plateOnly('WEG', 'electrical', ['weg motor', 'weg drive', 'weg electric'], PLATE_DATE, { family: 'WEG', notes: 'Motors and drives.' }),
  plateOnly('APC', 'electrical', ['apc ups', 'american power conversion', 'smart-ups'], PLATE_DATE, { family: 'Schneider Electric', notes: 'UPS equipment.' }),
  plateOnly('Milbank', 'electrical', ['milbank'], NO_SCHEME, { family: 'Milbank' }),
  plateOnly('Generac', 'electrical', ['generac'], PLATE_DATE, { family: 'Generac' }),
  plateOnly('Kohler', 'electrical', ['kohler power', 'kohler generator'], PLATE_DATE, { family: 'Kohler' }),
  plateOnly('Cummins / Onan', 'electrical', ['cummins', 'onan'], PLATE_DATE, { family: 'Cummins' }),
  plateOnly('Caterpillar', 'electrical', ['caterpillar', 'cat generator'], PLATE_DATE, { family: 'Caterpillar' }),
  plateOnly('ASCO', 'electrical', ['asco'], PLATE_DATE, { family: 'Schneider Electric' }),
  plateOnly('Russelectric', 'electrical', ['russelectric'], PLATE_DATE, { family: 'Siemens' }),

  // ══════════════════════════ VAV / AIR TERMINALS ══════════════════════════
  // New category. No tonnage/gallons here — the decodable field is inlet
  // size (inches) or, for fan-powered/reheat boxes, heater kW; both are read
  // directly off the plate in nomenclature.js rather than decoded from a
  // model code. None of these manufacturers encode a date into the serial
  // the way HVAC compressors do, as far as verified — every plate seen so
  // far just prints "DATE:" directly, which is what PLATE_DATE describes.
  plateOnly('Redd-i', 'vav', ['redd-i', 'reddi'], PLATE_DATE,
    { family: 'TPI Corp', notes: 'VAV terminal units and fan-powered/reheat boxes. Confirmed from field nameplates (MVA-series standard VAV, SRFHE-series fan-powered reheat) — Gray, TN.' }),
  plateOnly('Titus', 'vav', ['titus hvac', 'titus air'], PLATE_DATE, { family: 'Titus (Envirotech)' }),
  plateOnly('Price Industries', 'vav', ['price industries', 'price hvac'], PLATE_DATE, { family: 'Price Industries' }),
  plateOnly('Krueger', 'vav', ['krueger hvac', 'krueger air'], PLATE_DATE, { family: 'Air System Components' }),
  plateOnly('Nailor', 'vav', ['nailor industries', 'nailor'], PLATE_DATE, { family: 'Nailor Industries' }),
  plateOnly('Metal Industries', 'vav', ['metal industries'], PLATE_DATE, { family: 'Metal Industries' }),
  plateOnly('Anemostat', 'vav', ['anemostat'], PLATE_DATE, { family: 'Mestek' }),
  plateOnly('Greenheck', 'vav', ['greenheck'], PLATE_DATE, { family: 'Greenheck', notes: 'Fans, dampers, louvers — not VAV boxes specifically, but shares this category for lack of a tonnage/gallons field.' }),
  plateOnly('Loren Cook', 'vav', ['loren cook', 'cook fan'], PLATE_DATE, { family: 'Loren Cook Company', notes: 'Fans.' }),

  // ══════════════════════════ BACKFLOW PREVENTERS ══════════════════════════
  // New category, brand/alias detection only for now — deliberately no
  // fabricated serial-to-date scheme. Decodable field is nominal pipe size +
  // assembly type (RPZ/DC/PVB), both read directly off the plate. If a test
  // tag with an inspection date is present, that's a separate compliance
  // record, not a manufacture-date decode, and isn't something this pipeline
  // reads yet.
  plateOnly('Watts', 'backflow', ['watts backflow', 'watts regulator', 'watts water'], NO_SCHEME, { family: 'Watts Water Technologies' }),
  plateOnly('Febco', 'backflow', ['febco'], NO_SCHEME, { family: 'Watts Water Technologies' }),
  plateOnly('Wilkins', 'backflow', ['wilkins', 'zurn wilkins'], NO_SCHEME, { family: 'Zurn' }),
  plateOnly('Ames', 'backflow', ['ames fire', 'ames backflow'], NO_SCHEME, { family: 'Watts Water Technologies' }),
  plateOnly('Conbraco / Apollo', 'backflow', ['conbraco', 'apollo backflow', 'apollo valves'], NO_SCHEME, { family: 'Aalberts (Conbraco)' }),
  plateOnly('Cla-Val', 'backflow', ['cla-val', 'cla val'], NO_SCHEME, { family: 'Cla-Val' }),
];

// ─────────────────────────────────────────────────────────────────────────
// CONFIRMED FIELD MODELS — real model numbers read directly off physical
// nameplates during field-photo review sessions (2026-07 decoder-accuracy
// pass), not synthesized or guessed. Used ONLY as a fuzzy-match anchor
// corpus (nameplateSmart.js) so a token that's one or two characters off
// from an already-confirmed real model — the kind of OCR insertion/deletion
// error the O/0-I/1-G/6-Z/2 substitution repair can't fix — still surfaces
// as a low-confidence candidate instead of nothing. This list does NOT
// create or imply any capacity/serial decode rule by itself; it exists
// purely to catch "the model is corrupted but we've genuinely seen this
// exact model before" as a distinct, honestly-labeled signal.
export const CONFIRMED_FIELD_MODELS = [
  { brand: 'ICP (Heil / Tempstar / Comfortmaker)', category: 'hvac', model: 'N4A336AKB200' },
  { brand: 'ICP (Heil / Tempstar / Comfortmaker)', category: 'hvac', model: 'CHS121HAA0A00AA' },
  { brand: 'ICP (Heil / Tempstar / Comfortmaker)', category: 'hvac', model: 'NAC236AKA1' },
  { brand: 'Goodman', category: 'hvac', model: 'GSC130361GB' },
  { brand: 'Lennox', category: 'hvac', model: '13HPX-048-230-18' },
  { brand: 'Lennox', category: 'hvac', model: '14HPX-060-230-19' },
  { brand: 'Lennox', category: 'hvac', model: 'XC16S048-230-04' },
  { brand: 'Trane', category: 'hvac', model: '2A7A1024A1000AA' },
  { brand: 'Trane', category: 'hvac', model: 'TWA120A300FB' },
  { brand: 'Trane', category: 'hvac', model: '4TTR3036E1000AA' },
  { brand: 'Carrier', category: 'hvac', model: '25HCE460A500' },
  { brand: 'Carrier', category: 'hvac', model: 'FB4CNP061' },
  { brand: 'A.O. Smith (Water Heater)', category: 'waterheater', model: 'EJC6200' },
  { brand: 'A.O. Smith (Water Heater)', category: 'waterheater', model: 'EN6-40-DORS110' },
  { brand: 'Redd-i', category: 'vav', model: 'MVA-12' },
  { brand: 'Redd-i', category: 'vav', model: 'SRFHE1500-12' },
];
