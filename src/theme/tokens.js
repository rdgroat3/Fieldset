/**
 * Fieldset — design tokens.
 * Ported verbatim from README.md / space-type-picker-handoff.md / camera-toolbar-handoff.md.
 * Do not introduce new colors here without updating the handoff docs.
 */

export const color = {
  // Background radial gradient stops (see <Backdrop />)
  bgTop: '#1f2530',
  bgMid: '#12151c',
  bgBottom: '#0a0c10',

  // Camera / picker surfaces use a slightly different near-black
  ink: '#0d0f11',

  textPrimary: '#f5f3ef',
  text50: 'rgba(245,243,239,.5)',
  text45: 'rgba(245,243,239,.45)',
  text40: 'rgba(245,243,239,.4)',
  text30: 'rgba(245,243,239,.3)',
  text85: 'rgba(242,240,236,.85)',

  accent: '#5b8def',
  accentLight: '#a8c6ff',
  accentDark: '#2c53a8',

  accentTint05: 'rgba(91,141,239,.05)',
  accentTint10: 'rgba(91,141,239,.1)',
  accentTint12: 'rgba(91,141,239,.12)',
  accentTint15: 'rgba(91,141,239,.15)',
  accentTint30: 'rgba(91,141,239,.3)',
  accentTint40: 'rgba(91,141,239,.4)',
  accentTint50: 'rgba(91,141,239,.5)',

  cardFill: 'rgba(255,255,255,.03)',
  cardFillHero: 'rgba(255,255,255,.035)',
  cardFillDisabled: 'rgba(255,255,255,.05)',
  cardBorder: 'rgba(255,255,255,.07)',
  cardBorderSoft: 'rgba(255,255,255,.08)',

  // Camera overlay
  pillFill: 'rgba(10,12,16,.55)',
  playGlyph: '#14161a',
};

export const radius = {
  hero: 26,
  heroInner: 25,
  card: 22,
  cardInner: 21,
  shortcut: 18,
  spaceCard: 16,
  button: 16,
  pill: 12,
  iconSquare: 9,
};

export const space = {
  gutter: 26,
  stackGap: 16,
  shortcutGap: 10,
  gridGap: 9,
};

/** 155deg / 160deg CSS angles converted to expo-linear-gradient unit-square vectors. */
export const angle = {
  // 155deg → direction (0.4226, 0.9063)
  d155: { start: { x: 0.289, y: 0.047 }, end: { x: 0.711, y: 0.953 } },
  // 160deg → direction (0.342, 0.9397)
  d160: { start: { x: 0.329, y: 0.03 }, end: { x: 0.671, y: 0.97 } },
};

export const gradient = {
  heroBorder: ['rgba(91,141,239,.55)', 'rgba(91,141,239,.05)', 'rgba(255,255,255,.06)'],
  heroBorderStops: [0, 0.4, 1],

  cardBorder: ['rgba(91,141,239,.3)', 'rgba(91,141,239,.03)', 'rgba(255,255,255,.05)'],
  cardBorderStops: [0, 0.45, 1],

  play: ['#a8c6ff', '#5b8def', '#2c53a8'],
  playStops: [0, 0.55, 1],

  // Shared by "Continue" (enabled) and the camera "Finish" pill
  action: ['#6d9ef4', '#5b8def', '#3f6fd4'],
  actionStops: [0, 0.55, 1],
};

const DISPLAY = {
  400: 'Manrope_400Regular',
  500: 'Manrope_500Medium',
  600: 'Manrope_600SemiBold',
  700: 'Manrope_700Bold',
  800: 'Manrope_800ExtraBold',
};
const MONO = {
  400: 'JetBrainsMono_400Regular',
  500: 'JetBrainsMono_500Medium',
  700: 'JetBrainsMono_700Bold',
};

/** font(600, 17, { lh: 1, ls: -0.2 }) → RN text style */
export function font(weight, size, opts = {}) {
  const { lh, ls, mono } = opts;
  const s = { fontFamily: (mono ? MONO : DISPLAY)[weight], fontSize: size };
  if (lh) s.lineHeight = Math.round(size * lh);
  if (ls) s.letterSpacing = ls;
  return s;
}

export const shadow = {
  play: {
    shadowColor: color.accent,
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  action: {
    shadowColor: color.accent,
    shadowOpacity: 0.35,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
};
