import React from 'react';
import { StyleSheet, View, Pressable, Platform } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg';
import { color, radius, angle, gradient } from '../theme/tokens';

/**
 * CSS: radial-gradient(120% 90% at 50% -10%, #1f2530, #12151c 55%, #0a0c10)
 * RN has no radial gradient primitive, so we draw it with react-native-svg.
 * objectBoundingBox units map 1:1 with the CSS percentages.
 */
export function Backdrop({ children, style }) {
  return (
    <View style={[{ flex: 1, backgroundColor: color.bgBottom }, style]}>
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <RadialGradient id="bg" cx="0.5" cy="-0.1" rx="1.2" ry="0.9">
            <Stop offset="0" stopColor={color.bgTop} />
            <Stop offset="0.55" stopColor={color.bgMid} />
            <Stop offset="1" stopColor={color.bgBottom} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#bg)" />
      </Svg>
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

/**
 * 1px gradient hairline border. Same technique as the HTML reference:
 * gradient-filled wrapper with 1px padding, opaque-ish inner view on top.
 */
export function GradientBorder({ colors, locations, outerRadius, innerRadius, style, children }) {
  return (
    <LinearGradient
      colors={colors}
      locations={locations}
      start={angle.d155.start}
      end={angle.d155.end}
      style={[{ borderRadius: outerRadius, padding: 1 }, style]}
    >
      <View style={{ borderRadius: innerRadius, overflow: 'hidden' }}>{children}</View>
    </LinearGradient>
  );
}

/**
 * Glassmorphism card: backdrop-filter: blur(14px) + translucent fill.
 *
 * Android note: expo-blur needs experimentalBlurMethod="dimezisBlurView" to blur
 * what's behind it. That view is expensive to composite. Since our background is a
 * smooth gradient with nothing behind the cards, the blur buys us almost nothing —
 * so on Android we fall back to the translucent fill alone. Visually identical here,
 * and it keeps the camera screen at 60fps.
 */
export function GlassCard({ tone = 'card', style, children }) {
  const fill = tone === 'hero' ? color.cardFillHero : color.cardFill;
  if (Platform.OS === 'android') {
    return <View style={[{ backgroundColor: fill }, style]}>{children}</View>;
  }
  return (
    <BlurView intensity={14} tint="dark" style={[{ backgroundColor: fill }, style]}>
      {children}
    </BlurView>
  );
}

/** Hero card (Start Walkthrough) — 26/25 radius, brighter border. */
export function HeroCard({ children, style }) {
  return (
    <GradientBorder
      colors={gradient.heroBorder}
      locations={gradient.heroBorderStops}
      outerRadius={radius.hero}
      innerRadius={radius.heroInner}
      style={style}
    >
      <GlassCard tone="hero" style={styles.heroInner}>
        {children}
      </GlassCard>
    </GradientBorder>
  );
}

/** ActionCard shell (Decoder, Experimental) — 22/21 radius, dimmer border. */
export function ActionCardShell({ children, style }) {
  return (
    <GradientBorder
      colors={gradient.cardBorder}
      locations={gradient.cardBorderStops}
      outerRadius={radius.card}
      innerRadius={radius.cardInner}
      style={style}
    >
      <GlassCard style={styles.actionInner}>{children}</GlassCard>
    </GradientBorder>
  );
}

/** Touch-only app: press = subtle scale + dim. No hover states anywhere. */
export function Press({ onPress, onLongPress, disabled, style, children, scaleTo = 0.975 }) {
  const s = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <Animated.View style={[a, style]}>
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        disabled={disabled}
        accessibilityRole="button"
        onPressIn={() => (s.value = withTiming(scaleTo, { duration: 90 }))}
        onPressOut={() => (s.value = withTiming(1, { duration: 120 }))}
        style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  heroInner: { paddingVertical: 26, paddingHorizontal: 18 },
  actionInner: { paddingVertical: 16, paddingHorizontal: 18 },
});
