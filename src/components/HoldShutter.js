import React, { useState, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Polygon } from 'react-native-svg';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle, useSharedValue, withTiming, withSpring,
  useAnimatedProps, runOnJS, cancelAnimation, interpolate,
} from 'react-native-reanimated';
import { PanelIcon, VideoIcon, PhotoIcon, DecoderIcon } from './Icons';
import { color } from '../theme/tokens';

const HOLD_MS = 450;         // hold duration before the picker "arms"
const SHUTTER = 74;           // outer shutter diameter
const RING = 84;              // progress ring diameter
const OPTION_LG = 64;         // center (Video) option
const OPTION_SM = 52;         // side options
const COL_W = 90;             // fixed column width per option (label wrap width)

// Arc geometry: options fan out above the shutter along a circle instead of
// sitting in a straight row, so they read as "radial" rather than a toolbar.
const ARC_RADIUS = 108;       // distance from shutter center to each option
const ARC_SPAN_DEG = 100;     // total angular spread of the fan, centered on straight-up
const ARC_CENTER_DEG = -90;   // straight up, in standard (x right, y down) degrees

// Per-option capture: how close the finger needs to be to an option's center
// to select it, and the hard outer radius past which nothing selects (drops
// back to "no option" — released there, it does nothing, matching the
// existing "back out" behavior). Both are generous vs. the old tight column
// math, which is what made the radial feel overly sensitive/twitchy.
const CAPTURE_RADIUS = 46;
const DEADZONE_RADIUS = 30;   // must clear the shutter itself before any option can arm

const AProgress = Animated.createAnimatedComponent(Circle);

/** Photo-mode radial: Panels / Video / Decoder. Flag moved to its own
 *  persistent toggle, so it no longer needs a slot here. */
export const PHOTO_OPTIONS = [
  { id: 'panels', label: 'Panels', size: OPTION_SM, Icon: PanelIcon },
  { id: 'video', label: 'Video', size: OPTION_SM, Icon: VideoIcon },
  { id: 'decoder', label: 'Decoder', size: OPTION_SM, Icon: DecoderIcon },
];

/** Video-mode radial (not recording): swap Video for Photo so you can hold
 *  the shutter to get back to stills without a separate button. */
export const VIDEO_OPTIONS = [
  { id: 'panels', label: 'Panels', size: OPTION_SM, Icon: PanelIcon },
  { id: 'photo', label: 'Photo', size: OPTION_SM, Icon: PhotoIcon },
  { id: 'decoder', label: 'Decoder', size: OPTION_SM, Icon: DecoderIcon },
];

/**
 * onPhoto()        — released with menu not armed (a plain tap/short press)
 * onSelectMode(id) — released while an option is highlighted
 * onArmChange(b)   — fires when the picker opens/closes, so the parent can dim the toolbar
 */
export default function HoldShutter({ onPhoto, onSelectMode, onArmChange, labelsOn = true, options = PHOTO_OPTIONS, variant = 'photo' }) {
  const OPTIONS = options;
  const [armed, setArmed] = useState(false);
  const [active, setActive] = useState(null); // highlighted option id (drives visual)
  const activeRef = useRef(null);             // same value, read synchronously on release

  const setActiveBoth = (id) => {
    activeRef.current = id;
    setActive(id);
  };

  const progress = useSharedValue(0);   // 0..1 hold progress (drives ring)
  const open = useSharedValue(0);        // 0..1 menu open (drives option row)
  const innerScale = useSharedValue(1);

  const armedRef = useSharedValue(0);

  const setArmedJS = (v) => {
    setArmed(v);
    onArmChange?.(v);
    if (!v) {
      setActive(null);
      activeRef.current = null;
    }
  };

  const arm = () => {
    'worklet';
    armedRef.value = 1;
    open.value = withSpring(1, { damping: 15, stiffness: 160 });
    runOnJS(setArmedJS)(true);
  };

  const reset = () => {
    'worklet';
    cancelAnimation(progress);
    progress.value = withTiming(0, { duration: 150 });
    open.value = withSpring(0, { damping: 18, stiffness: 200 });
    innerScale.value = withSpring(1);
    armedRef.value = 0;
  };

  // Each option's fixed (x, y) offset from the shutter center, spread evenly
  // across the arc. Computed once per options set (not per gesture frame).
  const positions = React.useMemo(() => {
    const n = OPTIONS.length;
    return OPTIONS.map((o, i) => {
      // Single option sits dead center (straight up); multiple options
      // spread evenly across the arc, in index order left-to-right.
      const t = n === 1 ? 0.5 : i / (n - 1);
      const deg = ARC_CENTER_DEG - ARC_SPAN_DEG / 2 + t * ARC_SPAN_DEG;
      const rad = (deg * Math.PI) / 180;
      return { id: o.id, x: Math.cos(rad) * ARC_RADIUS, y: Math.sin(rad) * ARC_RADIUS };
    });
  }, [OPTIONS]);

  /** Nearest-option-within-radius: finds the closest arc position to the
   *  finger and selects it only if within CAPTURE_RADIUS. Anything beyond
   *  that (including the empty space between options) selects nothing,
   *  which is the "go too far and it deselects" behavior. */
  const hitTest = (x, y) => {
    'worklet';
    if (open.value < 0.5) return null;
    const distFromCenter = Math.sqrt(x * x + y * y);
    if (distFromCenter < DEADZONE_RADIUS) return null;
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const dx = x - p.x;
      const dy = y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) { bestDist = d; best = p.id; }
    }
    if (bestDist > CAPTURE_RADIUS) return null;
    return best;
  };

  const gesture = Gesture.Pan()
    .maxPointers(1)
    .minDistance(0)
    .onBegin(() => {
      innerScale.value = withTiming(0.9, { duration: 120 });
      progress.value = withTiming(1, { duration: HOLD_MS }, (done) => {
        if (done) arm();
      });
    })
    .onUpdate((e) => {
      if (armedRef.value !== 1) return;
      const id = hitTest(e.translationX, e.translationY);
      runOnJS(setActiveBoth)(id);
    })
    .onEnd(() => {
      const wasArmed = armedRef.value === 1;
      reset();
      runOnJS(dispatchRelease)(wasArmed);
    })
    .onFinalize(() => {
      runOnJS(closeMenu)();
    });

  // Runs on JS thread at release. activeRef holds the last highlighted option.
  function dispatchRelease(wasArmed) {
    if (wasArmed) {
      // Menu was open: fire the highlighted option, or — if the user held and
      // released without dragging onto one — treat it as backing out and do
      // NOTHING. Previously this fell through to onPhoto(), so escaping the
      // radial always snapped an unwanted photo.
      if (activeRef.current) onSelectMode?.(activeRef.current);
      return;
    }
    onPhoto?.();
  }

  // Clears armed/active state after dispatch has already read the ref.
  function closeMenu() {
    setArmedJS(false);
  }

  const ringProps = useAnimatedProps(() => {
    const c = Math.PI * (RING - 6);
    return { strokeDashoffset: c * (1 - progress.value) };
  });
  const innerStyle = useAnimatedStyle(() => ({ transform: [{ scale: innerScale.value }] }));
  const rowStyle = useAnimatedStyle(() => ({
    opacity: open.value,
    transform: [{ scale: interpolate(open.value, [0, 1], [0.85, 1]) }],
  }));

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {/* Radial options, fanned along an arc above the shutter. */}
      <Animated.View style={[styles.arcLayer, rowStyle]} pointerEvents="none">
        {OPTIONS.map((o, i) => (
          <View
            key={o.id}
            style={[
              styles.arcSlot,
              { left: RING / 2 + positions[i].x - COL_W / 2, top: RING / 2 + positions[i].y - COL_W / 2 },
            ]}
          >
            <Option option={o} active={active === o.id} labelsOn={labelsOn} />
          </View>
        ))}
      </Animated.View>

      {/* Shutter + ring */}
      <GestureDetector gesture={gesture}>
        <View style={styles.shutterHit}>
          <Svg width={RING} height={RING} style={StyleSheet.absoluteFill}>
            <Circle
              cx={RING / 2} cy={RING / 2} r={(RING - 6) / 2}
              stroke="rgba(255,255,255,.25)" strokeWidth={3} fill="none"
            />
            <AProgress
              cx={RING / 2} cy={RING / 2} r={(RING - 6) / 2}
              stroke={color.accent} strokeWidth={3} fill="none"
              strokeLinecap="round"
              strokeDasharray={Math.PI * (RING - 6)}
              animatedProps={ringProps}
              transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
            />
          </Svg>
          <View style={styles.shutterOuter}>
            <Animated.View style={[styles.shutterInner, variant === 'video' && styles.shutterInnerVideo, innerStyle]}>
              {variant === 'video' && (
                <Svg width={22} height={22} viewBox="0 0 22 22">
                  <Polygon points="8,5.5 17,11 8,16.5" fill="#fff" />
                </Svg>
              )}
            </Animated.View>
          </View>
        </View>
      </GestureDetector>
    </View>
  );
}

function Option({ option, active, labelsOn }) {
  const { size, center, Icon, label } = option;
  return (
    <View style={styles.optionWrap}>
      <View
        style={[
          styles.option,
          { width: size, height: size, borderRadius: size / 2 },
          center && styles.optionCenter,
          active && styles.optionActive,
        ]}
      >
        {center ? (
          <View
            style={[StyleSheet.absoluteFill, { borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(20,22,26,.9)' }]}
          >
            <Icon fill={active ? color.ink : color.textPrimary} />
          </View>
        ) : (
          <Icon stroke={active ? color.ink : color.textPrimary} />
        )}
      </View>
      {labelsOn && (
        <Text numberOfLines={1} style={styles.optionLabel}>
          {label}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', width: RING, height: RING },

  shutterHit: {
    width: RING, height: RING, alignItems: 'center', justifyContent: 'center',
  },
  shutterOuter: {
    width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2,
    borderWidth: 4, borderColor: 'rgba(255,255,255,.9)',
    alignItems: 'center', justifyContent: 'center',
  },
  shutterInner: {
    width: SHUTTER - 12, height: SHUTTER - 12, borderRadius: (SHUTTER - 12) / 2,
    backgroundColor: '#f2f0ec',
    alignItems: 'center', justifyContent: 'center',
  },
  // Video mode: red disc + play glyph so the shutter reads as "record",
  // not "take a picture".
  shutterInnerVideo: { backgroundColor: '#e5484d' },

  arcLayer: {
    position: 'absolute',
    width: RING, height: RING,
    // Centered on the shutter itself; children are placed absolutely inside
    // via left/top computed from each option's arc offset.
  },
  arcSlot: {
    position: 'absolute', width: COL_W, alignItems: 'center',
  },
  optionWrap: { alignItems: 'center' },
  option: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(20,22,26,.82)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,.14)',
    overflow: 'hidden',
  },
  optionCenter: { borderColor: 'transparent' },
  optionActive: {
    backgroundColor: color.accent,
    borderColor: color.accentLight,
    shadowColor: color.accent, shadowOpacity: 0.6, shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 }, elevation: 8,
  },
  optionLabel: {
    marginTop: 8, fontSize: 10, color: color.textPrimary,
    fontFamily: 'Manrope_500Medium', textAlign: 'center',
  },
});
