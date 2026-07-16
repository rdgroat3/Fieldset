// Non-visual survey constants. The old amber C/FONT design system that used
// to live here has been fully retired — every screen now uses the cobalt
// tokens in src/theme/tokens.js. What's left are real, still-used data
// constants that aren't part of any visual theme.

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
