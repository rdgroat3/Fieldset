// Realistic nameplate corpus for measuring decoder accuracy.
//
// Each plate is written the way ML Kit actually returns it: bordered-table
// cells as separate lines with frames, column-interleaved reading order, and
// the electrical-ratings block that occupies most of the physical plate area
// on real equipment. That ratings block is the point — it is the single
// biggest source of junk candidates, and a corpus without it flatters the
// decoder badly.
//
// `expect` records what the plate ACTUALLY says. `null` means the field is
// genuinely absent and asserting anything is a failure.

const L = (text, left, top, width = 130, height = 22) => ({
  text, frame: { left, top, width, height },
});

// Standard electrical-ratings block found on nearly every HVAC plate.
// Deliberately included in most fixtures: these lines are the noise the
// field extractor has to survive.
const elecBlock = (y0) => [
  L('VOLTS', 40, y0, 70), L('208/230', 200, y0, 110),
  L('PHASE', 40, y0 + 30, 70), L('1', 200, y0 + 30, 30),
  L('HERTZ', 40, y0 + 60, 70), L('50HZ', 200, y0 + 60, 60),
  L('MIN CKT AMPACITY', 40, y0 + 90, 190), L('24.5', 250, y0 + 90, 60),
  L('MAX FUSE', 40, y0 + 120, 110), L('40', 200, y0 + 120, 40),
  L('REFRIGERANT', 40, y0 + 150, 150), L('R-410A', 220, y0 + 150, 90),
  L('FACTORY CHARGE', 40, y0 + 180, 170), L('8.19 LBS', 240, y0 + 180, 90),
  L('DESIGN PRESSURE', 40, y0 + 210, 190), L('4826 KPA', 250, y0 + 210, 100),
];

export const CORPUS = [
  {
    id: 'carrier-48tc-rtu',
    note: 'Carrier commercial rooftop, bordered table, control-voltage note present',
    category: 'hvac',
    blocks: [{ lines: [
      L('CARRIER CORPORATION', 40, 10, 300),
      L('MODEL NO.', 40, 50, 120), L('48TCED08A2A5-0A0A0', 200, 50, 230),
      L('SERIAL NO.', 40, 80, 120), L('3014X12345', 200, 80, 160),
      L('CONTROL CIRCUIT', 40, 110, 170), L('24VAC', 220, 110, 80),
      ...elecBlock(150),
    ] }],
    expect: { make: 'Carrier', model: '48TCED08A2A5-0A0A0', serial: '3014X12345', year: 2014 },
  },
  {
    id: 'trane-split',
    note: 'Trane split AC, stacked label/value cells',
    category: 'hvac',
    blocks: [{ lines: [
      L('TRANE', 40, 10, 120),
      L('MODEL', 40, 50, 90),
      L('4TTR4036A1000AA', 40, 75, 220),
      L('SERIAL', 40, 110, 90),
      L('14304ABCDE', 40, 135, 180),
      ...elecBlock(175),
    ] }],
    // 14304ABCDE is a valid Trane 10-char YYWW serial: 14 -> 2014, week 30.
    // The original fixture asserted year:null and was simply wrong.
    expect: { make: 'Trane', model: '4TTR4036A1000AA', serial: '14304ABCDE', year: 2014 },
  },
  {
    id: 'york-rtu-glued-label',
    note: 'York, OCR glued the serial label to its value (SERIAL71604246)',
    category: 'hvac',
    blocks: [{ lines: [
      L('YORK INTERNATIONAL', 40, 10, 300),
      L('MODEL NUMBER', 40, 50, 170), L('D1EE060N06525C', 240, 50, 200),
      L('SERIAL71604246', 40, 80, 220),
      ...elecBlock(120),
    ] }],
    expect: { make: 'York', model: 'D1EE060N06525C', serial: '71604246', year: null },
  },
  {
    id: 'ao-smith-wh',
    note: 'A.O. Smith water heater, combined MODEL/SERIAL header row',
    category: 'waterheater',
    blocks: [{ lines: [
      L('A. O. SMITH', 40, 10, 200),
      L('WATER HEATER', 40, 35, 200),
      L('MODEL          SERIAL', 40, 70, 320),
      L('DEL-52          1425A123456', 40, 95, 320),
      L('CAPACITY', 40, 130, 110), L('50 GALLONS', 200, 130, 140),
      L('INPUT', 40, 160, 80), L('4500 W', 200, 160, 90),
    ] }],
    expect: { make: 'A.O. Smith (Water Heater)', model: 'DEL-52', serial: '1425A123456' },
  },
  {
    id: 'no-brand-peeled',
    note: 'Brand sticker peeled off; only nomenclature can identify it',
    category: 'hvac',
    blocks: [{ lines: [
      L('MODEL', 40, 20, 90), L('4TTR3036A1000AA', 200, 20, 220),
      L('SERIAL', 40, 50, 90), L('9224ABCDE', 200, 50, 160),
      ...elecBlock(90),
    ] }],
    expect: { model: '4TTR3036A1000AA', serial: '9224ABCDE' },
  },
  {
    id: 'ratings-only-crop',
    note: 'Plate cropped to the electrical table only. NOTHING should be asserted.',
    category: 'hvac',
    blocks: [{ lines: [
      L('ELECTRICAL RATINGS', 40, 10, 240),
      ...elecBlock(50),
      L('LRA', 40, 300, 60), L('112', 200, 300, 50),
      L('RLA', 40, 330, 60), L('18.9', 200, 330, 60),
    ] }],
    expect: { model: null, serial: null, year: null },
  },
  {
    id: 'agency-listing-noise',
    note: 'Certification block only — UL/CSA/AHRI file numbers must not become candidates',
    category: 'hvac',
    blocks: [{ lines: [
      L('UL 1995', 40, 10, 110),
      L('CSA C22.2', 40, 40, 130),
      L('AHRI 210/240', 40, 70, 160),
      L('ETL 3068422', 40, 100, 150),
      L('MADE IN USA', 40, 130, 150),
      L('ASSEMBLED IN MEXICO', 40, 160, 240),
    ] }],
    expect: { model: null, serial: null, year: null },
  },
  {
    id: 'goodman-with-mfg-date',
    note: 'Printed manufacture date field alongside a serial',
    category: 'hvac',
    blocks: [{ lines: [
      L('GOODMAN', 40, 10, 150),
      L('MODEL', 40, 45, 90), L('GSX130361BA', 200, 45, 190),
      L('SERIAL', 40, 75, 90), L('1502123456', 200, 75, 170),
      L('MFG DATE', 40, 105, 120), L('03/2015', 200, 105, 110),
      ...elecBlock(145),
    ] }],
    expect: { make: 'Goodman', model: 'GSX130361BA', serial: '1502123456', year: 2015 },
  },
  {
    id: 'ocr-confusion-trane',
    note: 'OCR read Trane model with G->6 and Z->2 confusion',
    category: 'hvac',
    blocks: [{ lines: [
      L('TRANE', 40, 10, 120),
      L('MODEL NO', 40, 45, 120), L('2A7A1024A1000AA', 200, 45, 220),
      L('SERIAL NO', 40, 75, 120), L('R21234567', 200, 75, 170),
      ...elecBlock(115),
    ] }],
    expect: { make: 'Trane', model: '2A7A1024A1000AA' },
  },
  {
    id: 'product-no-decoy',
    note: 'Carrier plate printing BOTH Product No. and Model No. — classic mis-pair trap',
    category: 'hvac',
    blocks: [{ lines: [
      L('BRYANT', 40, 10, 130),
      L('PRODUCT NO.', 40, 45, 150), L('38MURAQ24AA3', 220, 45, 200),
      L('MODEL NO.', 40, 75, 130), L('38MURAQ24AA3', 220, 75, 200),
      L('SERIAL NO.', 40, 105, 130), L('4013E56789', 220, 105, 170),
      ...elecBlock(145),
    ] }],
    expect: { make: 'Carrier', model: '38MURAQ24AA3', serial: '4013E56789' },
  },
  {
    id: 'panelboard-squared',
    note: 'Square D panelboard — electrical gear, must never report tonnage',
    category: 'electrical',
    blocks: [{ lines: [
      L('SQUARE D COMPANY', 40, 10, 260),
      L('PANELBOARD', 40, 40, 160),
      L('CAT NO', 40, 70, 100), L('NQOD442L225', 180, 70, 190),
      L('VOLTS', 40, 100, 80), L('208Y/120', 180, 100, 130),
      L('MAIN BUS', 40, 130, 120), L('225A', 200, 130, 80),
    ] }],
    expect: { model: 'NQOD442L225', capacityIsTons: false },
  },
  {
    id: 'vav-terminal',
    note: 'VAV box — inlet size and printed date, no serial decode exists',
    category: 'vav',
    blocks: [{ lines: [
      L('AIR TERMINAL UNIT', 40, 10, 240),
      L('MODEL', 40, 45, 90), L('SDV-08', 200, 45, 120),
      L('INLET SIZE', 40, 75, 130), L('8', 200, 75, 40),
      L('PRIMARY CFM', 40, 105, 150), L('FIELD SET', 220, 105, 130),
      L('DATE', 40, 135, 70), L('11/22/13', 180, 135, 120),
    ] }],
    expect: { year: 2013 },
  },
  {
    id: 'tilted-plate',
    note: 'Whole plate rotated ~8 degrees in frame (ladder shot)',
    category: 'hvac',
    blocks: [{ lines: [
      { text: 'LENNOX', frame: { left: 40, top: 10, width: 120, height: 22 }, cornerPoints: [{x:40,y:10},{x:160,y:27},{x:160,y:49},{x:40,y:32}] },
      { text: 'MODEL NO', frame: { left: 40, top: 50, width: 120, height: 22 }, cornerPoints: [{x:40,y:50},{x:160,y:67},{x:160,y:89},{x:40,y:72}] },
      { text: 'XC13-036-230', frame: { left: 200, top: 72, width: 190, height: 22 }, cornerPoints: [{x:200,y:72},{x:390,y:99},{x:390,y:121},{x:200,y:94}] },
      { text: 'SERIAL NO', frame: { left: 40, top: 90, width: 120, height: 22 }, cornerPoints: [{x:40,y:90},{x:160,y:107},{x:160,y:129},{x:40,y:112}] },
      { text: '5811A12345', frame: { left: 200, top: 112, width: 170, height: 22 }, cornerPoints: [{x:200,y:112},{x:370,y:136},{x:370,y:158},{x:200,y:134}] },
    ] }],
    expect: { make: 'Lennox', model: 'XC13-036-230', serial: '5811A12345' },
  },
  {
    id: 'screenshot-chrome',
    note: 'Photo of a screen; UI chrome and a timestamp leaked into the scan',
    category: 'hvac',
    blocks: [{ lines: [
      L('2024-03-15 14:22', 40, 10, 200),
      L('IMG_20240315', 40, 40, 190),
      L('MODEL', 40, 75, 90), L('RAKA-036JAZ', 200, 75, 180),
      L('SERIAL', 40, 105, 90), L('W231512345', 200, 105, 180),
      L('100% BATTERY', 40, 135, 180),
    ] }],
    expect: { model: 'RAKA-036JAZ', serial: 'W231512345' },
  },
  {
    id: 'unit-heater-modine',
    note: 'Modine unit heater — noTonnage brand, must not fabricate tons',
    category: 'hvac',
    blocks: [{ lines: [
      L('MODINE MANUFACTURING', 40, 10, 300),
      L('MODEL', 40, 45, 90), L('HD-060', 200, 45, 120),
      L('SERIAL', 40, 75, 90), L('1234567890', 200, 75, 170),
      L('INPUT BTU/HR', 40, 105, 160), L('60000', 220, 105, 110),
    ] }],
    expect: { model: 'HD-060', capacityIsTons: false },
  },
];

// ── Second wave: adversarial plates ──────────────────────────────────────
// Everything here is a shape that produced a wrong field or a junk candidate
// in real use, or an obvious decoy the first wave didn't cover.
export const CORPUS2 = [
  {
    id: 'part-number-decoy',
    note: 'P/N and CAT NO decoys sitting above the real MODEL',
    category: 'hvac',
    blocks: [{ lines: [
      L('RHEEM MANUFACTURING', 40, 10, 300),
      L('P/N', 40, 45, 60), L('AS-61234-02', 160, 45, 180),
      L('CAT NO', 40, 75, 100), L('7842B', 180, 75, 110),
      L('MODEL', 40, 105, 90), L('RAKA-036JAZ', 200, 105, 180),
      L('SERIAL', 40, 135, 90), L('W231512345', 200, 135, 180),
      ...elecBlock(175),
    ] }],
    expect: { make: 'Rheem', model: 'RAKA-036JAZ', serial: 'W231512345' },
  },
  {
    id: 'compressor-brand-bleed',
    note: 'Unit is Lennox; a Copeland compressor label is in the same photo',
    category: 'hvac',
    blocks: [{ lines: [
      L('LENNOX INDUSTRIES', 40, 10, 280),
      L('MODEL NO', 40, 45, 120), L('XC13-036-230', 200, 45, 190),
      L('SERIAL NO', 40, 75, 120), L('5811A12345', 200, 75, 180),
      L('COMPRESSOR', 40, 200, 150),
      L('COPELAND', 40, 230, 140),
      L('ZR40KC-PFV-230', 40, 260, 200),
      ...elecBlock(300),
    ] }],
    expect: { make: 'Lennox', model: 'XC13-036-230', serial: '5811A12345' },
  },
  {
    id: 'barcode-digits',
    note: 'Barcode number printed under the serial — long digit run decoy',
    category: 'hvac',
    blocks: [{ lines: [
      L('GOODMAN MFG', 40, 10, 220),
      L('MODEL', 40, 45, 90), L('GSX140361KA', 200, 45, 190),
      L('SERIAL', 40, 75, 90), L('1802345678', 200, 75, 180),
      L('012345678905', 40, 130, 220),
      ...elecBlock(170),
    ] }],
    expect: { make: 'Goodman', model: 'GSX140361KA', serial: '1802345678' },
  },
  {
    id: 'serial-above-label',
    note: 'Value sits ABOVE its label (upside-down plate photographed level)',
    category: 'hvac',
    blocks: [{ lines: [
      L('YORK', 40, 10, 100),
      L('D1EE060N06525C', 40, 45, 210),
      L('MODEL NUMBER', 40, 72, 170),
      L('71604246', 40, 110, 150),
      L('SERIAL NUMBER', 40, 137, 180),
      ...elecBlock(180),
    ] }],
    // Values above labels are not something we claim to handle. Leaving the
    // fields blank is the correct outcome; asserting the wrong pairing is not.
    expect: { serialNotEqual: 'D1EE060N06525C' },
  },
  {
    id: 'boiler-weil-mclain',
    note: 'Cast-iron boiler — no tonnage, MBH input decoy',
    category: 'hvac',
    blocks: [{ lines: [
      L('WEIL-McLAIN', 40, 10, 200),
      L('MODEL', 40, 45, 90), L('EG-45', 200, 45, 110),
      L('SERIAL', 40, 75, 90), L('CP1234567', 200, 75, 170),
      L('INPUT MBH', 40, 105, 140), L('299', 220, 105, 70),
      L('AGA RATING', 40, 135, 150), L('036', 220, 135, 70),
    ] }],
    expect: { model: 'EG-45', capacityIsTons: false },
  },
  {
    id: 'pump-bell-gossett',
    note: 'Pump — impeller diameter and GPM look like capacity codes',
    category: 'hvac',
    blocks: [{ lines: [
      L('BELL & GOSSETT', 40, 10, 220),
      L('MODEL', 40, 45, 90), L('1510-3BD', 200, 45, 150),
      L('IMPELLER', 40, 75, 120), L('7.25', 200, 75, 90),
      L('GPM', 40, 105, 70), L('060', 180, 105, 70),
      L('RPM', 40, 135, 70), L('1750', 180, 135, 90),
    ] }],
    expect: { model: '1510-3BD', capacityIsTons: false },
  },
  {
    id: 'ocr-zero-oh-serial',
    note: 'Carrier serial with O read for 0 — repair pass must recover it',
    category: 'hvac',
    blocks: [{ lines: [
      L('CARRIER', 40, 10, 130),
      L('MODEL NO.', 40, 45, 120), L('38MURAQ24AA3', 200, 45, 200),
      L('SERIAL NO.', 40, 75, 120), L('3O14X12345', 200, 75, 170),
      ...elecBlock(115),
    ] }],
    expect: { make: 'Carrier', model: '38MURAQ24AA3' },
  },
  {
    id: 'mitsubishi-minisplit',
    note: 'Mini-split indoor unit, model contains a slash',
    category: 'hvac',
    blocks: [{ lines: [
      L('MITSUBISHI ELECTRIC', 40, 10, 290),
      L('MODEL', 40, 45, 90), L('MSZ-FH12NA', 200, 45, 180),
      L('SERIAL', 40, 75, 90), L('7X123456', 200, 75, 150),
      L('REFRIGERANT', 40, 105, 150), L('R410A', 220, 105, 90),
      L('KG', 40, 135, 50), L('1.15', 160, 135, 70),
    ] }],
    expect: { model: 'MSZ-FH12NA', serial: '7X123456' },
  },
  {
    id: 'label-only-no-values',
    note: 'Labels legible, values completely burned off. Assert nothing.',
    category: 'hvac',
    blocks: [{ lines: [
      L('MODEL NO.', 40, 45, 120),
      L('SERIAL NO.', 40, 75, 120),
      L('MFG DATE', 40, 105, 120),
      ...elecBlock(145),
    ] }],
    expect: { model: null, serial: null, year: null },
  },
  {
    id: 'address-block',
    note: 'Manufacturer address block — street numbers must not become codes',
    category: 'hvac',
    blocks: [{ lines: [
      L('CARRIER CORPORATION', 40, 10, 300),
      L('7310 W. MORRIS ST', 40, 40, 250),
      L('INDIANAPOLIS IN 46231', 40, 70, 280),
      L('MODEL NO.', 40, 105, 120), L('40RUAQ12A2A5', 220, 105, 200),
      L('SERIAL NO.', 40, 135, 120), L('2216A98765', 220, 135, 180),
      ...elecBlock(175),
    ] }],
    expect: { make: 'Carrier', model: '40RUAQ12A2A5', serial: '2216A98765' },
  },
  {
    id: 'daikin-applied-ahu',
    note: 'Air handler, long dashed model, unit tag decoy',
    category: 'hvac',
    blocks: [{ lines: [
      L('DAIKIN APPLIED', 40, 10, 220),
      L('UNIT TAG', 40, 45, 120), L('AHU-3', 200, 45, 100),
      L('MODEL', 40, 75, 90), L('CAH-014-GDAC', 200, 75, 200),
      L('SERIAL', 40, 105, 90), L('FTNU123456', 200, 105, 190),
      ...elecBlock(145),
    ] }],
    expect: { model: 'CAH-014-GDAC', serial: 'FTNU123456' },
  },
  {
    id: 'two-column-bleed',
    note: 'Two plates side by side; right column belongs to a different unit',
    category: 'hvac',
    blocks: [{ lines: [
      L('MODEL', 40, 45, 90), L('GSX130361BA', 190, 45, 190),
      L('MODEL', 520, 45, 90), L('GSX140481KA', 670, 45, 190),
      L('SERIAL', 40, 75, 90), L('1502123456', 190, 75, 180),
      L('SERIAL', 520, 75, 90), L('1907654321', 670, 75, 180),
    ] }],
    // Ambiguous by construction. Requirement: whatever it picks must be a
    // real value from the plate, never a splice of the two columns.
    expect: { modelOneOf: ['GSX130361BA', 'GSX140481KA'] },
  },
];

// ── Third wave: shapes the first 27 plates never exercised ───────────────
//
// The first two waves were written from bugs already seen. At 100% precision
// they had stopped finding anything, which is a property of the corpus and
// not of the decoder. This wave is written the other way round: pick plate
// shapes that are common in the field and absent from the fixtures, and
// find out what breaks.
//
// Coverage added here:
//   - a model number OCR'd as two lines (wide plates wrap constantly)
//   - a printed manufacture date that CONTRADICTS the serial decode
//   - month-name and week-number date formats
//   - agency file numbers (UL/ETL/CSA) sitting next to the serial
//   - non-tonnage capacity units (MBH, kW, GPM, CFM) as fabrication bait
//   - labels themselves damaged by OCR confusion, not just values
//   - TYPE / CAT NO as the only model-ish field (panels, diffusers, pumps)
//   - equipment classes with no HVAC tonnage at all: fans, pumps, gensets,
//     boilers, CRAC units, diffusers
export const CORPUS3 = [
  {
    id: 'model-wrapped-two-lines',
    note: 'Wide plate: model wrapped onto a second OCR line below the first',
    category: 'hvac',
    blocks: [{ lines: [
      L('CARRIER CORPORATION', 40, 10, 300),
      L('MODEL NO.', 40, 50, 120), L('48TCED08A2A5', 200, 50, 200),
      L('-0A0A0', 200, 74, 90),
      L('SERIAL NO.', 40, 108, 120), L('3014X12345', 200, 108, 160),
      ...elecBlock(148),
    ] }],
    // Either the first segment alone or the rejoined whole is defensible.
    // A splice that invents characters is not.
    expect: {
      make: 'Carrier',
      serial: '3014X12345',
      modelOneOf: ['48TCED08A2A5', '48TCED08A2A5-0A0A0'],
    },
  },
  {
    id: 'printed-date-beats-serial',
    note: 'Printed MFG DATE 03/2018 contradicts a Carrier serial decoding to 2009',
    category: 'hvac',
    blocks: [{ lines: [
      L('CARRIER', 40, 10, 140),
      L('MODEL NO.', 40, 45, 120), L('38AUZA08A0A6-0A0A0', 200, 45, 240),
      L('SERIAL NO.', 40, 75, 120), L('1409X12345', 200, 75, 160),
      L('MFG DATE', 40, 105, 110), L('03/2018', 200, 105, 110),
      ...elecBlock(145),
    ] }],
    // A date the manufacturer printed in words outranks a rule inferred from
    // the serial. Replacement units get reserialised; the printed date is the
    // one a surveyor can defend to a client.
    expect: { make: 'Carrier', serial: '1409X12345', year: 2018 },
  },
  {
    id: 'date-month-name',
    note: 'Manufacture date written as a month name, not digits',
    category: 'hvac',
    blocks: [{ lines: [
      L('TRANE', 40, 10, 120),
      L('MODEL NO.', 40, 45, 120), L('TWE036C140A1', 200, 45, 200),
      L('SERIAL NO.', 40, 75, 120), L('12345ABCD', 200, 75, 170),
      L('MANUFACTURED', 40, 105, 170), L('SEP 2015', 220, 105, 120),
      ...elecBlock(145),
    ] }],
    expect: { make: 'Trane', model: 'TWE036C140A1', year: 2015 },
  },
  {
    id: 'date-week-number',
    note: 'Date code given as week + year',
    category: 'hvac',
    blocks: [{ lines: [
      L('GREENHECK', 40, 10, 180),
      L('MODEL', 40, 45, 90), L('SWB-124-4-X', 200, 45, 180),
      L('SERIAL', 40, 75, 90), L('15-123456', 200, 75, 150),
      L('DATE CODE', 40, 105, 120), L('WK 38 2015', 210, 105, 140),
      L('CFM', 40, 140, 60), L('4200', 160, 140, 80),
      L('RPM', 40, 170, 60), L('1140', 160, 170, 80),
    ] }],
    expect: { make: 'Greenheck', model: 'SWB-124-4-X', serial: '15-123456', year: 2015, capacityIsTons: false },
  },
  {
    id: 'agency-file-number-decoy',
    note: 'UL file number and CSA number bracketing the real serial',
    category: 'hvac',
    blocks: [{ lines: [
      L('YORK INTERNATIONAL', 40, 10, 280),
      L('UL FILE NO.', 40, 45, 140), L('E123456', 210, 45, 130),
      L('MODEL NO.', 40, 75, 120), L('ZF078N12N4AAA1A', 200, 75, 230),
      L('SERIAL NO.', 40, 105, 120), L('N1M1234567', 200, 105, 180),
      L('CSA FILE', 40, 135, 110), L('LR54321', 200, 135, 130),
      ...elecBlock(175),
    ] }],
    expect: { make: 'York', model: 'ZF078N12N4AAA1A', serial: 'N1M1234567' },
  },
  {
    id: 'ocr-damaged-labels',
    note: 'Zero-for-O and l-for-I confusion in the LABELS, not the values',
    category: 'hvac',
    blocks: [{ lines: [
      L('GOODMAN MANUFACTURING', 40, 10, 320),
      L('M0DEL N0.', 40, 45, 130), L('GSX160481FA', 200, 45, 190),
      L('SERlAL N0.', 40, 75, 130), L('1806123456', 200, 75, 180),
      ...elecBlock(115),
    ] }],
    expect: { make: 'Goodman', model: 'GSX160481FA', serial: '1806123456' },
  },
  {
    id: 'mbh-input-not-tons',
    note: 'Gas-fired makeup air: MBH input is the only capacity on the plate',
    category: 'hvac',
    blocks: [{ lines: [
      L('REZNOR', 40, 10, 150),
      L('MODEL', 40, 45, 90), L('RBL-400', 200, 45, 140),
      L('SERIAL', 40, 75, 90), L('BEB12345H', 200, 75, 170),
      L('INPUT', 40, 105, 80), L('400 MBH', 190, 105, 120),
      L('OUTPUT', 40, 135, 100), L('320 MBH', 200, 135, 120),
      L('MANIFOLD PRESSURE', 40, 165, 200), L('3.5 IN WC', 260, 165, 130),
    ] }],
    expect: { make: 'Reznor', model: 'RBL-400', serial: 'BEB12345H', capacityIsTons: false },
  },
  {
    id: 'pump-gpm-head',
    note: 'Base-mounted pump: TYPE is the model field, GPM/head/HP decoys',
    category: 'hvac',
    blocks: [{ lines: [
      L('GRUNDFOS', 40, 10, 170),
      L('TYPE', 40, 45, 70), L('CR 15-4', 170, 45, 130),
      L('P/N', 40, 75, 60), L('96501234', 160, 75, 150),
      L('SERIAL NO', 40, 105, 120), L('0812-1234', 200, 105, 150),
      L('GPM', 40, 140, 60), L('120', 160, 140, 70),
      L('HEAD FT', 40, 170, 110), L('98', 200, 170, 60),
      L('HP', 40, 200, 50), L('7.5', 150, 200, 60),
      L('RPM', 40, 230, 60), L('3450', 160, 230, 80),
    ] }],
    expect: { make: 'Grundfos', serial: '0812-1234', capacityIsTons: false },
  },
  {
    id: 'panel-type-cat-series',
    note: 'Panelboard: TYPE, CAT NO and SERIES all competing to be the model',
    category: 'electrical',
    blocks: [{ lines: [
      L('SQUARE D COMPANY', 40, 10, 290),
      L('TYPE', 40, 45, 70), L('NQOD', 170, 45, 100),
      L('CAT. NO.', 40, 75, 110), L('NQ442L2C', 200, 75, 160),
      L('SERIES', 40, 105, 90), L('E1', 190, 105, 60),
      L('AMPS', 40, 140, 80), L('225', 180, 140, 70),
      L('VOLTS', 40, 170, 80), L('208Y/120', 180, 170, 130),
      L('WIRE', 40, 200, 70), L('4W', 170, 200, 60),
      L('SCCR', 40, 230, 70), L('10KAIC', 170, 230, 110),
    ] }],
    // 'E1' is a series revision, not a model, and must never be asserted as one.
    expect: { make: 'Square D', modelOneOf: ['NQOD', 'NQ442L2C'], capacityIsTons: false },
  },
  {
    id: 'genset-kw-decoy',
    note: 'Standby generator: kW/kVA/RPM ratings, all-digit model and serial',
    category: 'electrical',
    blocks: [{ lines: [
      L('GENERAC POWER SYSTEMS', 40, 10, 330),
      L('MODEL', 40, 45, 90), L('0059430', 200, 45, 140),
      L('SERIAL', 40, 75, 90), L('2145678', 200, 75, 140),
      L('KW', 40, 110, 50), L('60', 150, 110, 60),
      L('KVA', 40, 140, 60), L('75', 160, 140, 60),
      L('VOLTS', 40, 170, 80), L('277/480', 180, 170, 120),
      L('RPM', 40, 200, 60), L('1800', 160, 200, 80),
      L('PHASE', 40, 230, 70), L('3', 170, 230, 40),
    ] }],
    expect: { make: 'Generac', model: '0059430', serial: '2145678', capacityIsTons: false },
  },
  {
    id: 'crac-liebert',
    note: 'Computer-room AC: S/N abbreviation, kW sensible rating',
    category: 'hvac',
    blocks: [{ lines: [
      L('LIEBERT CORPORATION', 40, 10, 300),
      L('MODEL', 40, 45, 90), L('DS042ADC', 200, 45, 160),
      L('S/N', 40, 75, 60), L('3D12345678', 170, 75, 180),
      L('SENSIBLE CAP', 40, 105, 170), L('37.5 KW', 220, 105, 120),
      ...elecBlock(145),
    ] }],
    expect: { make: 'Liebert (Vertiv)', model: 'DS042ADC', serial: '3D12345678' },
  },
  {
    id: 'boiler-lochinvar',
    note: 'Condensing boiler, alphanumeric serial with embedded year letter',
    category: 'hvac',
    blocks: [{ lines: [
      L('LOCHINVAR', 40, 10, 190),
      L('MODEL NO', 40, 45, 110), L('KBN286', 200, 45, 130),
      L('SERIAL NO', 40, 75, 110), L('A18F123456', 200, 75, 180),
      L('INPUT BTU/HR', 40, 105, 170), L('286,000', 220, 105, 130),
      L('MAX WORKING PRESSURE', 40, 135, 250), L('160 PSI', 300, 135, 110),
    ] }],
    expect: { make: 'Lochinvar', model: 'KBN286', serial: 'A18F123456', capacityIsTons: false },
  },
  {
    id: 'diffuser-size-only',
    note: 'Ceiling diffuser: nothing on the label is a model or serial',
    category: 'hvac',
    blocks: [{ lines: [
      L('TITUS', 40, 10, 110),
      L('TYPE', 40, 45, 70), L('TMS-AA', 170, 45, 120),
      L('SIZE', 40, 75, 70), L('24 X 24', 170, 75, 120),
      L('NECK', 40, 105, 70), L('10 IN', 170, 105, 100),
    ] }],
    // No serial exists. Asserting one is the failure this fixture guards.
    expect: { make: 'Titus', serial: null, capacityIsTons: false },
  },
  {
    id: 'metric-export-daikin',
    note: '50Hz 400V export plate, kW capacity, no imperial units anywhere',
    category: 'hvac',
    blocks: [{ lines: [
      L('DAIKIN INDUSTRIES LTD', 40, 10, 320),
      L('MODEL', 40, 45, 90), L('RXYQ14TAYD', 200, 45, 190),
      L('SERIAL NO', 40, 75, 120), L('E000123', 200, 75, 130),
      L('COOLING CAPACITY', 40, 105, 210), L('40.0 KW', 270, 105, 120),
      L('VOLTS', 40, 140, 80), L('380-415', 180, 140, 120),
      L('HERTZ', 40, 170, 80), L('50', 180, 170, 50),
      L('PHASE', 40, 200, 70), L('3N', 170, 200, 60),
      L('REFRIGERANT', 40, 230, 150), L('R-410A', 220, 230, 90),
    ] }],
    expect: { model: 'RXYQ14TAYD', serial: 'E000123', capacityIsTons: false },
  },
  {
    id: 'aaon-long-dashed-model',
    note: 'Long dashed configuration string that is genuinely the model',
    category: 'hvac',
    blocks: [{ lines: [
      L('AAON INC', 40, 10, 160),
      L('MODEL', 40, 45, 90), L('RN-020-8-0-EB01-2AF', 200, 45, 260),
      L('SERIAL', 40, 75, 90), L('201812345', 200, 75, 160),
      L('TAG', 40, 105, 60), L('RTU-4', 160, 105, 110),
      ...elecBlock(145),
    ] }],
    expect: { make: 'AAON', model: 'RN-020-8-0-EB01-2AF', serial: '201812345' },
  },
  {
    id: 'unit-and-coil-models',
    note: 'Two labelled models on one plate: the unit and its coil',
    category: 'hvac',
    blocks: [{ lines: [
      L('RHEEM', 40, 10, 130),
      L('UNIT MODEL', 40, 45, 140), L('RA1436AJ1NA', 210, 45, 190),
      L('COIL MODEL', 40, 75, 140), L('RCF3617STAMCA', 210, 75, 210),
      L('SERIAL', 40, 105, 90), L('W381712345', 200, 105, 180),
      ...elecBlock(145),
    ] }],
    // The unit model is the one that belongs in the inventory row.
    expect: { make: 'Rheem', model: 'RA1436AJ1NA', serial: 'W381712345' },
  },
  {
    id: 'no-labels-two-codes',
    note: 'Peeled plate: brand plus two bare codes, no labels at all',
    category: 'hvac',
    blocks: [{ lines: [
      L('TRANE', 40, 10, 120),
      L('4TWR3036H1000AA', 40, 45, 220),
      L('14253ABCD', 40, 75, 160),
      ...elecBlock(115),
    ] }],
    // Guessing by nomenclature is allowed; pairing them backwards is not.
    expect: { make: 'Trane', serialNotEqual: '4TWR3036H1000AA' },
  },
  {
    id: 'cfm-vav-no-serial',
    note: 'VAV box with CFM range and a size code that is not a model',
    category: 'hvac',
    blocks: [{ lines: [
      L('PRICE INDUSTRIES', 40, 10, 260),
      L('MODEL', 40, 45, 90), L('SDV-1000', 200, 45, 150),
      L('SIZE', 40, 75, 70), L('10', 170, 75, 50),
      L('CFM RANGE', 40, 105, 140), L('150-1200', 210, 105, 140),
      L('INLET', 40, 135, 80), L('10 IN DIA', 180, 135, 140),
    ] }],
    expect: { model: 'SDV-1000', capacityIsTons: false },
  },
];

// ── Fourth wave: date traps ──────────────────────────────────────────────
//
// Written immediately after inverting the year precedence so a printed date
// outranks a serial decode. That change is correct, but it RAISES the cost of
// reading the wrong printed date: whatever date field wins now goes straight
// onto the report as the manufacture year, with no serial decode left to
// contradict it.
//
// Plates carry many dates that are not the manufacture date — hydrostatic
// test dates, inspection tags, warranty expiry, drawing revisions, installer
// stickers. Every one of those sits next to the word DATE. This wave exists
// to make sure the new precedence did not just hand the report a boiler's
// 2024 inspection date as its build year.
export const CORPUS4 = [
  {
    id: 'test-date-not-mfg-date',
    note: 'Boiler with a hydrostatic TEST DATE far newer than the build date',
    category: 'hvac',
    blocks: [{ lines: [
      L('WEIL-McLAIN', 40, 10, 200),
      L('MODEL', 40, 45, 90), L('CGA-25', 200, 45, 120),
      L('SERIAL', 40, 75, 90), L('CP7654321', 200, 75, 170),
      L('MFG DATE', 40, 105, 120), L('04/2009', 210, 105, 110),
      L('TEST DATE', 40, 135, 120), L('05/2024', 210, 135, 110),
      L('MAX PRESSURE', 40, 165, 180), L('30 PSI', 240, 165, 100),
    ] }],
    // Both dates are printed. Only one of them is when the unit was built.
    expect: { make: 'Weil-McLain', model: 'CGA-25', serial: 'CP7654321', year: 2009, capacityIsTons: false },
  },
  {
    id: 'only-a-test-date',
    note: 'Inspection tag date is the ONLY date on the plate — no build date at all',
    category: 'hvac',
    blocks: [{ lines: [
      L('PATTERSON-KELLEY', 40, 10, 250),
      L('MODEL', 40, 45, 90), L('MACH C-2000', 200, 45, 180),
      L('SERIAL', 40, 75, 90), L('P987654', 200, 75, 140),
      L('LAST INSPECTION DATE', 40, 105, 260), L('05/2024', 320, 105, 110),
      L('INPUT MBH', 40, 135, 140), L('2000', 220, 135, 90),
    ] }],
    // An inspection date is not a manufacture year. Blank is the honest
    // answer; 2024 would put a decades-old boiler at zero years old and
    // quietly drop it off the replacement schedule.
    expect: { make: 'Patterson-Kelley', model: 'MACH C-2000', year: null, capacityIsTons: false },
  },
  {
    id: 'warranty-expiry-date',
    note: 'Warranty expiry printed in the future',
    category: 'hvac',
    blocks: [{ lines: [
      L('BRADFORD WHITE', 40, 10, 240),
      L('MODEL', 40, 45, 90), L('RG250T6N', 200, 45, 150),
      L('SERIAL', 40, 75, 90), L('MK1234567', 200, 75, 170),
      L('WARRANTY EXPIRES', 40, 105, 220), L('2033', 280, 105, 90),
      L('CAPACITY', 40, 135, 120), L('50 GAL', 200, 135, 110),
    ] }],
    expect: { make: 'Bradford White', model: 'RG250T6N', serial: 'MK1234567', capacityIsTons: false },
  },
  {
    id: 'revision-date-decoy',
    note: 'Label artwork revision date stamped in the plate corner',
    category: 'electrical',
    blocks: [{ lines: [
      L('SQUARE D COMPANY', 40, 10, 290),
      L('CAT. NO.', 40, 45, 110), L('NQ430L2C', 200, 45, 160),
      L('SERIAL', 40, 75, 90), L('1832A45678', 200, 75, 180),
      L('AMPS', 40, 110, 80), L('225', 180, 110, 70),
      L('REV DATE', 40, 260, 110), L('2011', 190, 260, 90),
    ] }],
    // The artwork revision is a printing-plant date, not this unit's build
    // date. It must not displace the serial decode.
    expect: { make: 'Square D', serial: '1832A45678', capacityIsTons: false },
  },
  {
    id: 'installed-sticker',
    note: 'Contractor start-up sticker in the same photo as the nameplate',
    category: 'hvac',
    blocks: [{ lines: [
      L('CARRIER', 40, 10, 140),
      L('MODEL NO.', 40, 45, 120), L('48TCED08A2A5', 200, 45, 200),
      L('SERIAL NO.', 40, 75, 120), L('3014X12345', 200, 75, 160),
      ...elecBlock(115),
      L('INSTALLED', 40, 360, 130), L('06/2015', 200, 360, 110),
      L('STARTUP BY ACME MECHANICAL', 40, 390, 330),
    ] }],
    // Installed a year after manufacture, which is normal. The serial decode
    // is the build year; the install date is not.
    expect: { make: 'Carrier', model: '48TCED08A2A5', serial: '3014X12345', year: 2014 },
  },
  {
    id: 'date-yyyy-mm',
    note: 'ISO-style YYYY-MM manufacture date',
    category: 'hvac',
    blocks: [{ lines: [
      L('MITSUBISHI ELECTRIC', 40, 10, 300),
      L('MODEL', 40, 45, 90), L('PUZ-A30NHA7', 200, 45, 180),
      L('SERIAL NO', 40, 75, 120), L('7A012345', 200, 75, 150),
      L('MFD', 40, 105, 60), L('2019-06', 160, 105, 130),
      ...elecBlock(145),
    ] }],
    expect: { make: 'Mitsubishi Electric', model: 'PUZ-A30NHA7', serial: '7A012345', year: 2019 },
  },
  {
    id: 'date-dom-two-digit',
    note: 'D.O.M. abbreviation with a two-digit year',
    category: 'hvac',
    blocks: [{ lines: [
      L('BELL & GOSSETT', 40, 10, 220),
      L('MODEL', 40, 45, 90), L('E-1510 3BD', 200, 45, 190),
      L('SERIAL', 40, 75, 90), L('BG554433', 200, 75, 160),
      L('D.O.M.', 40, 105, 100), L('06/19', 190, 105, 100),
      L('HP', 40, 135, 50), L('5', 150, 135, 50),
    ] }],
    expect: { make: 'Bell & Gossett', serial: 'BG554433', year: 2019, capacityIsTons: false },
  },
  {
    id: 'year-run-inside-serial',
    note: 'Serial contains a 4-digit run that reads like a year but is not a date field',
    category: 'hvac',
    blocks: [{ lines: [
      L('AAON INC', 40, 10, 160),
      L('MODEL', 40, 45, 90), L('RQ-015-3-0-AA01', 200, 45, 230),
      L('SERIAL', 40, 75, 90), L('A2019B77321', 200, 75, 190),
      ...elecBlock(115),
    ] }],
    // No DATE label anywhere on this plate, so nothing should be reported as
    // a printed manufacture year on the strength of a digit run in a serial.
    expect: { make: 'AAON', model: 'RQ-015-3-0-AA01', serial: 'A2019B77321' },
  },
];

// ── Fifth wave: bare-year date qualifiers ────────────────────────────────
//
// The fourth wave passed its test-date traps for a structural reason rather
// than a deliberate one: the fallback regex needs the year immediately after
// the DATE keyword, and "TEST DATE | 05/2024" puts a month in between. So the
// trap only sprang when the qualified date was a BARE year — at which point a
// forty-year-old boiler stamped "TEST DATE 2024" reported as manufactured in
// 2024 and left the replacement schedule entirely.
//
// Probed directly, both of these failed before NON_MFG_DATE_QUALIFIER existed.
export const CORPUS5 = [
  {
    id: 'test-date-bare-year',
    note: 'Hydrostatic test stamp with a bare 4-digit year, no build date at all',
    category: 'hvac',
    blocks: [{ lines: [
      L('WEIL-McLAIN', 40, 10, 200),
      L('MODEL', 40, 45, 90), L('CGA-25', 200, 45, 120),
      L('SERIAL', 40, 75, 90), L('CP7654321', 200, 75, 170),
      L('TEST DATE', 40, 105, 120), L('2024', 200, 105, 80),
      L('MAX PRESSURE', 40, 135, 180), L('30 PSI', 240, 135, 100),
    ] }],
    expect: { make: 'Weil-McLain', model: 'CGA-25', serial: 'CP7654321', year: null, capacityIsTons: false },
  },
  {
    id: 'inspection-date-bare-year',
    note: 'Annual inspection tag, bare year',
    category: 'hvac',
    blocks: [{ lines: [
      L('BURNHAM', 40, 10, 160),
      L('MODEL', 40, 45, 90), L('V905', 200, 45, 110),
      L('INSPECTION DATE', 40, 75, 200), L('2024', 260, 75, 80),
      L('INPUT MBH', 40, 105, 140), L('245', 220, 105, 80),
    ] }],
    expect: { make: 'Burnham', model: 'V905', year: null, capacityIsTons: false },
  },
  {
    id: 'both-mfg-and-test-date',
    note: 'Real MFG DATE printed BELOW a disqualified test date in OCR order',
    category: 'hvac',
    blocks: [{ lines: [
      L('BURNHAM', 40, 10, 160),
      L('MODEL', 40, 45, 90), L('V1108', 200, 45, 120),
      L('SERIAL', 40, 75, 90), L('BN334455', 200, 75, 170),
      L('TEST DATE', 40, 105, 120), L('2024', 200, 105, 80),
      L('MFG DATE', 40, 135, 120), L('2003', 200, 135, 80),
    ] }],
    // Scanning past the disqualified match is the whole point: stopping at the
    // first DATE hit would leave this plate with no year despite printing one.
    expect: { make: 'Burnham', model: 'V1108', serial: 'BN334455', year: 2003, capacityIsTons: false },
  },
];
