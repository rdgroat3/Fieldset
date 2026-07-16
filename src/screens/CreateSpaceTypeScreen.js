import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, Alert } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Backdrop, Press } from '../components/Surface';
import { useProjects } from '../store/ProjectContext';
import { color, radius, space, font, gradient, angle, shadow } from '../theme/tokens';

function defaultProjectName(label) {
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${label} Survey \u2014 ${date}`;
}

/**
 * Reached from SpaceTypeScreen's "Create New" card. Custom building types
 * don't have a seeded room checklist the way the presets do, so this screen
 * collects one room/space name to start from; the survey-name field carries
 * over anything already typed on the previous screen.
 *
 * Known gap: there's currently no way to add further room names beyond this
 * one after the project is created — CameraScreen's room picker only
 * *selects* from the list set here, it doesn't let you add to it. That's a
 * separate feature, not something this screen tries to solve.
 */
export default function CreateSpaceTypeScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { createProject, loaded } = useProjects();
  const [typeLabel, setTypeLabel] = useState('');
  const [name, setName] = useState(route?.params?.name || '');
  const enabled = typeLabel.trim().length > 0;

  const onContinue = () => {
    if (!enabled) return;

    if (!loaded) {
      Alert.alert('One moment', 'Still loading your projects \u2014 try again in a second.');
      return;
    }

    const label = typeLabel.trim();
    const projectId = createProject({
      name: name.trim() || defaultProjectName(label),
      levels: ['01'],
      spaceTypes: [label, 'Mechanical Room', 'Electrical Room'],
    });

    navigation?.navigate?.('Capture', { projectId });
  };

  return (
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={{ flex: 1, paddingHorizontal: space.gutter, paddingTop: 24 }}>
          <Text style={styles.h1}>What should we call this space type?</Text>
          <Text style={styles.sub}>
            Used to seed the room checklist for this survey \u2014 you can add more once you're capturing.
          </Text>

          <Text style={styles.fieldLabel}>SPACE TYPE</Text>
          <TextInput
            value={typeLabel}
            onChangeText={setTypeLabel}
            placeholder="e.g. Data Center"
            placeholderTextColor={color.text30}
            style={styles.input}
            returnKeyType="next"
            maxLength={40}
            autoFocus
          />

          <Text style={styles.fieldLabel}>SURVEY NAME</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={typeLabel.trim() ? defaultProjectName(typeLabel.trim()) : 'e.g. Riverside Tower \u2014 Level 3'}
            placeholderTextColor={color.text30}
            style={styles.input}
            returnKeyType="done"
            maxLength={60}
          />
        </View>

        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <ContinueButton enabled={enabled} onPress={onContinue} />
        </View>
      </View>
    </Backdrop>
  );
}

function ContinueButton({ enabled, onPress }) {
  const s = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));

  const label = (
    <Text style={[styles.btnLabel, { color: enabled ? color.ink : color.text30 }]}>Continue</Text>
  );

  if (!enabled) {
    return (
      <View style={[styles.btn, styles.btnDisabled]} accessibilityState={{ disabled: true }}>
        {label}
      </View>
    );
  }

  return (
    <Animated.View style={a}>
      <Press onPress={onPress} scaleTo={0.98}>
        <LinearGradient
          colors={gradient.action}
          locations={gradient.actionStops}
          start={angle.d160.start}
          end={angle.d160.end}
          style={[styles.btn, shadow.action]}
        >
          {label}
        </LinearGradient>
      </Press>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  h1: { ...font(700, 22, { lh: 1.25, ls: -0.3 }), color: color.textPrimary },
  sub: { ...font(400, 13, { lh: 1.4 }), color: color.text50, marginTop: 8 },

  fieldLabel: {
    ...font(700, 10, { mono: true, ls: 0.8 }), color: color.text40,
    marginTop: 22, marginBottom: 8,
  },
  input: {
    height: 52, borderRadius: radius.spaceCard,
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder,
    paddingHorizontal: 16, ...font(600, 15), color: color.textPrimary,
  },

  footer: { paddingHorizontal: space.gutter, paddingTop: 10 },
  btn: { height: 52, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' },
  btnDisabled: { backgroundColor: color.cardFillDisabled },
  btnLabel: { ...font(700, 15) },
});
