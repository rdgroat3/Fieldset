// Design system: "instrument panel" aesthetic.
// High contrast for dark mechanical rooms + gloved thumbs.
// Safety-amber accent borrowed from electrical panel warning labels.

export const C = {
  bg: '#0D1117',        // graphite black
  panel: '#161C24',     // raised panel surface
  panelEdge: '#232B36', // hairline edges
  ink: '#E8EDF2',       // primary text
  inkDim: '#8B97A5',    // secondary text
  amber: '#FFB020',     // primary action / accent (safety amber)
  amberInk: '#1A1200',  // text on amber
  green: '#3FD68C',     // pass / OK
  red: '#FF5A52',       // fail / deficiency
  blue: '#4DA3FF',      // info / nameplate mode
};

export const FONT = {
  // System fonts keep the bundle light; weights carry the identity.
  display: { fontWeight: '800', letterSpacing: 0.5 },
  label: { fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', fontSize: 11 },
  mono: { fontVariant: ['tabular-nums'] },
};

// Big-target sizing: everything tappable is >= 52pt for gloved hands.
export const TAP = 52;

export const SYSTEMS = ['MECH', 'ELEC', 'PLMB', 'FP', 'GEN'];

export const BUILDING_PROFILES = {
  'Commercial Office': ['Private Office', 'Open Office', 'Conference Room', 'Corridor', 'Electrical Room', 'Mechanical Room', 'IDF Closet', 'Restroom', 'Lobby', 'Storage'],
  Healthcare: ['Patient Room', 'Exam Room', 'Nurse Station', 'Corridor', 'Electrical Room', 'Mechanical Room', 'Med Gas Room', 'Clean Utility', 'Soiled Utility', 'OR'],
  Industrial: ['Production Floor', 'Warehouse Bay', 'Electrical Room', 'Mechanical Room', 'Compressor Room', 'Boiler Room', 'Control Room', 'Loading Dock', 'Office', 'Break Room'],
  Education: ['Classroom', 'Lab', 'Corridor', 'Gymnasium', 'Cafeteria', 'Electrical Room', 'Mechanical Room', 'Library', 'Office', 'Restroom'],
  Retail: ['Sales Floor', 'Stock Room', 'Electrical Room', 'Mechanical Room', 'RTU Well', 'Office', 'Restroom', 'Receiving'],
};

// Blur / exposure thresholds (Laplacian variance on 240px grayscale).
// Tune these after real field testing.
export const QUALITY = {
  BLUR_MIN: 110,           // below this = blurry (general shots)
  BLUR_MIN_NAMEPLATE: 260, // nameplates must be crisp enough to read stamped text
  LUMA_MIN: 38,            // mean luminance below this = too dark
};
