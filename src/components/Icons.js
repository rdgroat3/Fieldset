import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Circle, Rect, Line, Polygon, Ellipse } from 'react-native-svg';
import { color } from '../theme/tokens';

const A = color.accent;

/* ── Landing ─────────────────────────────────────────────── */

/** Sliders/adjustments. Three tracks, one handle each, offset per track. */
export function SlidersIcon({ size = 16 }) {
  const track = { height: 2, borderRadius: 1, backgroundColor: color.text30 };
  const handle = (left, fill) => ({
    position: 'absolute',
    top: -2,
    left,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: fill,
  });
  return (
    <View style={{ width: size, gap: 4 }}>
      <View style={track}>
        <View style={handle(9, A)} />
      </View>
      <View style={track}>
        <View style={handle(2, 'rgba(245,243,239,.6)')} />
      </View>
      <View style={track}>
        <View style={handle(6, 'rgba(245,243,239,.6)')} />
      </View>
    </View>
  );
}

export function PlayGlyph({ size = 12, fill = color.playGlyph }) {
  return (
    <Svg width={size} height={size * 1.33} viewBox="0 0 12 16">
      <Polygon points="0,0 12,8 0,16" fill={fill} />
    </Svg>
  );
}

/** Decoder: four corner brackets — an OCR reticle. */
export function DecoderIcon({ size = 14, stroke = A }) {
  const p = 1.5;
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14">
      <Path d="M0.75 5V0.75H5" stroke={stroke} strokeWidth={p} fill="none" />
      <Path d="M9 0.75h4.25V5" stroke={stroke} strokeWidth={p} fill="none" />
      <Path d="M0.75 9v4.25H5" stroke={stroke} strokeWidth={p} fill="none" />
      <Path d="M9 13.25h4.25V9" stroke={stroke} strokeWidth={p} fill="none" />
    </Svg>
  );
}

/** Experimental: ringed circle with a filled core. */
export function ExperimentalIcon({ size = 16, stroke = A }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Circle cx="8" cy="8" r="7.25" stroke={stroke} strokeWidth={1.5} fill="none" />
      <Circle cx="8" cy="8" r="2" fill={stroke} />
    </Svg>
  );
}

export function ListIcon({ size = 12, stroke = A }) {
  return (
    <Svg width={size} height={9} viewBox="0 0 12 9">
      <Rect x="0" y="0" width="12" height="1.5" rx="0.75" fill={stroke} />
      <Rect x="0" y="3.75" width="8" height="1.5" rx="0.75" fill={stroke} />
      <Rect x="0" y="7.5" width="10" height="1.5" rx="0.75" fill={stroke} />
    </Svg>
  );
}

export function DocIcon({ stroke = A }) {
  return (
    <Svg width={12} height={14} viewBox="0 0 12 14" fill="none">
      <Path
        d="M2.75 0.75h4.1L10.25 4.1v8.15a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1V1.75a1 1 0 0 1 1-1z"
        stroke={stroke} strokeWidth={1.2} strokeLinejoin="round"
      />
      <Path d="M6.6 0.9v3.3h3.3" stroke={stroke} strokeWidth={1.2} strokeLinejoin="round" />
      <Line x1="4" y1="7.4" x2="8" y2="7.4" stroke={stroke} strokeWidth={1.1} strokeLinecap="round" />
      <Line x1="4" y1="9.7" x2="8" y2="9.7" stroke={stroke} strokeWidth={1.1} strokeLinecap="round" />
    </Svg>
  );
}

/* ── Space type picker ───────────────────────────────────── */

const glyph = (children) => ({ size = 16, stroke = A }) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    {children(stroke)}
  </Svg>
);

/** Office tower: windows + entrance. */
export const OfficeIcon = glyph((s) => (
  <>
    <Rect x="2.75" y="1.75" width="10.5" height="12.5" rx="1.2" stroke={s} strokeWidth={1.3} />
    <Rect x="5" y="4" width="2" height="2" rx="0.3" fill={s} />
    <Rect x="9" y="4" width="2" height="2" rx="0.3" fill={s} />
    <Rect x="5" y="7.5" width="2" height="2" rx="0.3" fill={s} />
    <Rect x="9" y="7.5" width="2" height="2" rx="0.3" fill={s} />
    <Rect x="6.75" y="11.2" width="2.5" height="3.05" rx="0.3" fill={s} />
  </>
));

/** Healthcare: facility with a medical cross. */
export const HealthcareIcon = glyph((s) => (
  <>
    <Rect x="2.75" y="3.25" width="10.5" height="11" rx="1.2" stroke={s} strokeWidth={1.3} />
    <Line x1="8" y1="6" x2="8" y2="11.5" stroke={s} strokeWidth={1.5} strokeLinecap="round" />
    <Line x1="5.25" y1="8.75" x2="10.75" y2="8.75" stroke={s} strokeWidth={1.5} strokeLinecap="round" />
  </>
));

/** Restaurant: fork + spoon. The right-hand shape was a knife, drawn as a
 *  tapered blade outline — at 16px that read as a second fork tine or a stray
 *  stroke. A spoon's filled bowl is unambiguous at any size. */
export const RestaurantIcon = glyph((s) => (
  <>
    {/* Fork: three tines over a shared neck + handle. */}
    <Line x1="3.4" y1="2.5" x2="3.4" y2="5.4" stroke={s} strokeWidth={1.1} strokeLinecap="round" />
    <Line x1="5" y1="2.5" x2="5" y2="5.4" stroke={s} strokeWidth={1.1} strokeLinecap="round" />
    <Line x1="6.6" y1="2.5" x2="6.6" y2="5.4" stroke={s} strokeWidth={1.1} strokeLinecap="round" />
    <Path d="M2.8 5.3h4.4a1 1 0 0 1-1 1.8H3.8a1 1 0 0 1-1-1.8z" fill={s} />
    <Line x1="5" y1="7" x2="5" y2="13.5" stroke={s} strokeWidth={1.3} strokeLinecap="round" />
    {/* Spoon: filled oval bowl + handle. */}
    <Ellipse cx="11.2" cy="4.6" rx="1.9" ry="2.5" fill={s} />
    <Line x1="11.2" y1="7.1" x2="11.2" y2="13.5" stroke={s} strokeWidth={1.3} strokeLinecap="round" />
  </>
));

/** Residential: pitched-roof house with a door. */
export const ResidentialIcon = glyph((s) => (
  <>
    <Path d="M2.25 7.4 8 2.5l5.75 4.9" stroke={s} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    <Path d="M3.9 8.1v5.4h8.2V8.1" stroke={s} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    <Rect x="6.75" y="10" width="2.5" height="3.5" rx="0.3" fill={s} />
  </>
));

/** Warehouse: wide low shed with a roll-up bay door. */
export const WarehouseIcon = glyph((s) => (
  <>
    <Path d="M1.75 6.6 8 3.2l6.25 3.4v6.9H1.75z" stroke={s} strokeWidth={1.3} strokeLinejoin="round" />
    <Rect x="5.5" y="8.6" width="5" height="4.9" stroke={s} strokeWidth={1.2} />
    <Line x1="5.5" y1="10.4" x2="10.5" y2="10.4" stroke={s} strokeWidth={1} />
    <Line x1="5.5" y1="12" x2="10.5" y2="12" stroke={s} strokeWidth={1} />
  </>
));

/** Retail: storefront with an awning. */
export const RetailIcon = glyph((s) => (
  <>
    <Path d="M2.4 5.2h11.2l-1.1 2.6H3.5z" stroke={s} strokeWidth={1.3} strokeLinejoin="round" />
    <Path d="M3.7 8v5.5h8.6V8" stroke={s} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    <Rect x="6.5" y="9.9" width="3" height="3.6" rx="0.3" fill={s} />
    <Line x1="4.6" y1="2.5" x2="11.4" y2="2.5" stroke={s} strokeWidth={1.3} strokeLinecap="round" />
  </>
));

/** Exterior: sun with rays above a building on a ground line — outdoors /
 *  roof / site work. The old version paired a HOLLOW circle with a bare
 *  roofline polyline: with no rays the circle read as a generic dot, and the
 *  roofline had no ground reference so it looked like an arbitrary zigzag.
 *  Rays make the sun unmistakable; the ground line anchors the building as a
 *  structure seen from OUTSIDE. */
export const ExteriorIcon = glyph((s) => (
  <>
    {/* Sun: filled disc + four rays. */}
    <Circle cx="11.6" cy="4.2" r="1.9" fill={s} />
    <Line x1="11.6" y1="0.9" x2="11.6" y2="1.7" stroke={s} strokeWidth={1.1} strokeLinecap="round" />
    <Line x1="14.9" y1="4.2" x2="14.1" y2="4.2" stroke={s} strokeWidth={1.1} strokeLinecap="round" />
    <Line x1="13.95" y1="1.85" x2="13.4" y2="2.4" stroke={s} strokeWidth={1.1} strokeLinecap="round" />
    <Line x1="9.25" y1="1.85" x2="9.8" y2="2.4" stroke={s} strokeWidth={1.1} strokeLinecap="round" />
    {/* Ground line. */}
    <Line x1="1.5" y1="13.8" x2="14.5" y2="13.8" stroke={s} strokeWidth={1.4} strokeLinecap="round" />
    {/* Building: pitched roof + walls, sitting on the ground line. Walls start
        at the eave line (8.1), not below it — a 0.5px gap between roof and
        wall is invisible on a mockup and obvious at 16px on a phone. */}
    <Path d="M2.2 8.1 6 5.2l3.8 2.9" stroke={s} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    <Path d="M3.3 8.1v5.7M8.7 8.1v5.7" stroke={s} strokeWidth={1.3} strokeLinecap="round" />
  </>
));

/** Create new: dashed ring + plus. */
export const CreateNewIcon = glyph((s) => (
  <>
    <Circle cx="8" cy="8" r="6" stroke={s} strokeWidth={1.3} strokeDasharray="2.2 2.2" />
    <Line x1="8" y1="5.2" x2="8" y2="10.8" stroke={s} strokeWidth={1.5} strokeLinecap="round" />
    <Line x1="5.2" y1="8" x2="10.8" y2="8" stroke={s} strokeWidth={1.5} strokeLinecap="round" />
  </>
));

export function CheckBadge({ size = 16 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Circle cx="8" cy="8" r="8" fill={A} />
      <Path d="M4.6 8.2 6.9 10.5 11.4 5.9" stroke={color.ink} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/* ── Camera ──────────────────────────────────────────────── */

export function MinusIcon({ size = 14, stroke = color.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14">
      <Line x1="2.5" y1="7" x2="11.5" y2="7" stroke={stroke} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}

export function PlusIcon({ size = 14, stroke = color.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14">
      <Line x1="2.5" y1="7" x2="11.5" y2="7" stroke={stroke} strokeWidth={1.6} strokeLinecap="round" />
      <Line x1="7" y1="2.5" x2="7" y2="11.5" stroke={stroke} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}

/** Panelboard with breakers — the Electrical Panels capture mode. */
export function PanelIcon({ size = 22, stroke = color.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Rect x="4.5" y="2.5" width="13" height="17" rx="2" stroke={stroke} strokeWidth={1.5} />
      <Line x1="11" y1="6" x2="11" y2="16" stroke={stroke} strokeWidth={1.2} opacity={0.5} />
      {[6.5, 9.5, 12.5, 15.5].map((y) => (
        <React.Fragment key={y}>
          <Rect x="6.5" y={y} width="3.6" height="1.8" rx="0.6" fill={stroke} />
          <Rect x="11.9" y={y} width="3.6" height="1.8" rx="0.6" fill={stroke} />
        </React.Fragment>
      ))}
    </Svg>
  );
}

export function VideoIcon({ size = 24, stroke = color.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Polygon points="8.5,5.5 18,12 8.5,18.5" fill={stroke} />
    </Svg>
  );
}

/** Photo/stills: simple camera glyph, used to return to photo mode from video. */
export function PhotoIcon({ size = 22, stroke = color.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Path d="M7.2 5.5 8.4 3.5h5.2l1.2 2" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <Rect x="2.5" y="5.5" width="17" height="12.5" rx="2.5" stroke={stroke} strokeWidth={1.5} />
      <Circle cx="11" cy="11.75" r="3.4" stroke={stroke} strokeWidth={1.5} />
    </Svg>
  );
}

export function FlagIcon({ size = 22, stroke = color.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Line x1="6" y1="3" x2="6" y2="19.5" stroke={stroke} strokeWidth={1.6} strokeLinecap="round" />
      <Path d="M6 3.8h10.5l-2.6 3.6 2.6 3.6H6z" fill={stroke} />
    </Svg>
  );
}

export function TorchIcon({ size = 18, stroke = color.textPrimary, active = false }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18">
      <Path
        d="M10 1 3 10.5h4.5L7 17l7.5-10H10z"
        fill={active ? color.accent : 'none'}
        stroke={active ? color.accent : stroke}
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
export function LabelsToggleIcon({ on = true }) {
  return (
    <Svg width={26} height={26} viewBox="0 0 26 26">
      <Path
        d="M3.2 11.5 6 4.5l2.8 7M4.1 9.4h3.9"
        stroke={color.textPrimary}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx="13" cy="8.6" r="2.9" stroke={color.textPrimary} strokeWidth={1.4} fill="none" />
      <Line x1="15.9" y1="5.4" x2="15.9" y2="11.5" stroke={color.textPrimary} strokeWidth={1.4} strokeLinecap="round" />
      <Rect
        x="4"
        y="15.5"
        width="18"
        height="8"
        rx="4"
        fill={on ? A : 'rgba(255,255,255,.14)'}
      />
      <Circle cx={on ? 18 : 8} cy="19.5" r="2.9" fill={on ? color.ink : color.textPrimary} />
    </Svg>
  );
}
