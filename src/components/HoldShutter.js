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
const COL_W = 90;             // fixed column width per option
const ROW_LIFT = 96;          // how far above the shutter the option row sits

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

  /** Map the finger's x/y (relative to shutter center) to an option id, or null.
   *  Columns are evenly spaced and centered on the shutter, so this works for
   *  any option count (was hard-coded to 3). */
  const hitTest = (x, y) => {
    'worklet';
    if (open.value < 0.5) return null;
    // Options live in a row lifted above the shutter. Only select when the finger
    // has traveled up toward the row (y sufficiently negative) — a straight hold
    // with no drag stays on "photo".
    if (y > -24) return null;
    const n = OPTIONS.length;
    const rowW = n * COL_W;
    // finger x relative to the row's left edge
    const fromLeft = x + rowW / 2;
    let idx = Math.floor(fromLeft / COL_W);
    if (idx < 0) idx = 0;
    if (idx > n - 1) idx = n - 1;
    return OPTIONS[idx].id;
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
    transform: [{ translateY: interpolate(open.value, [0, 1], [20, -ROW_LIFT]) }],
  }));

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {/* Radial option row */}
      <Animated.View style={[styles.optionRow, rowStyle]} pointerEvents="none">
        {OPTIONS.map((o) => (
          <Option key={o.id} option={o} active={active === o.id} labelsOn={labelsOn} />
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
    <View style={styles.optionCol}>
      <View
        style={[
          styles.option,
          { width: size, height: size, borderRadius: size / 2 },
          center && styles.optionCenter,
          active && styles.optionActive,
          center && { transform: [{ translateY: -14 }] },
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
        <Text
          numberOfLines={1}
          style={[styles.optionLabel, center && { transform: [{ translateY: -14 }] }]}
        >
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

  optionRow: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  optionCol: { width: COL_W, alignItems: 'center' },
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
