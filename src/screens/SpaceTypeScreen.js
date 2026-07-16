import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, TextInput } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Backdrop, Press } from '../components/Surface';
import { useProjects } from '../store/ProjectContext';
import {
  OfficeIcon, HealthcareIcon, RestaurantIcon, ResidentialIcon,
  WarehouseIcon, RetailIcon, ExteriorIcon, CreateNewIcon, CheckBadge,
} from '../components/Icons';
import { color, radius, space, font, gradient, angle, shadow } from '../theme/tokens';

const TYPES = [
  { id: 'office', label: 'Office Space', Icon: OfficeIcon },
  { id: 'healthcare', label: 'Healthcare', Icon: HealthcareIcon },
  { id: 'restaurant', label: 'Restaurant', Icon: RestaurantIcon },
  { id: 'residential', label: 'Residential', Icon: ResidentialIcon },
  { id: 'warehouse', label: 'Warehouse', Icon: WarehouseIcon },
  { id: 'retail', label: 'Retail', Icon: RetailIcon },
  { id: 'exterior', label: 'Exterior', Icon: ExteriorIcon },
  { id: 'create', label: 'Create New', Icon: CreateNewIcon, create: true },
];

// Default room/space checklist seeded per building type, per the handoff's
// "sets the capture prompts and checklist for this stop." Editable later —
// this just gives CameraScreen's space picker something sensible to start from.
const SPACE_TEMPLATES = {
  office: ['Office', 'Open Office', 'Breakroom', 'Conference Room', 'Walkways', 'Restroom', 'Mechanical Room', 'Electrical Room'],
  healthcare: ['Patient Room', 'Exam Room', 'Corridor', 'Mechanical Room', 'Electrical Room'],
  restaurant: ['Kitchen', 'Dining Room', 'Restroom', 'Walk-in Cooler', 'Mechanical Room'],
  residential: ['Living Room', 'Bedroom', 'Kitchen', 'Bathroom', 'Mechanical Room'],
  warehouse: ['Warehouse Floor', 'Loading Dock', 'Office', 'Mechanical Room', 'Electrical Room'],
  retail: ['Sales Floor', 'Stockroom', 'Restroom', 'Mechanical Room', 'Electrical Room'],
  exterior: ['Roof', 'Parking Lot', 'Exterior Wall', 'Loading Area'],
};

function defaultProjectName(label) {
  return `${label} Survey`;
}

export default function SpaceTypeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { createProject, loaded } = useProjects();
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState('');
  const [gridW, setGridW] = useState(0);
  const enabled = selected != null;

  // Exact 2-col width: (available - one gap) / 2. Avoids the percentage+gap overflow.
  const cardW = gridW > 0 ? (gridW - space.gridGap) / 2 : undefined;

  const selectedType = TYPES.find((t) => t.id === selected);

  const onContinue = () => {
    if (!enabled) return;
    const type = selectedType;

    if (type?.create) {
      navigation?.navigate?.('CreateSpaceType', { name: name.trim() });
      return;
    }

    // ProjectContext loads existing projects from AsyncStorage asynchronously.
    // Creating before that resolves would persist [newProject] and silently
    // wipe out everything already saved. Landing is the app's entry point now,
    // so this can genuinely be hit on a fast tap right after cold start.
    if (!loaded) {
      Alert.alert('One moment', 'Still loading your projects \u2014 try again in a second.');
      return;
    }

    const projectId = createProject({
      name: name.trim() || defaultProjectName(type.label),
      levels: ['01'],
      spaceTypes: SPACE_TEMPLATES[type.id] || [type.label],
    });

    // Routes to the existing, fully-wired capture screen (camera, OCR, tags,
    // addPhoto) rather than the new Camera UI, which doesn't persist photos
    // yet. Swap this to 'Camera' once that screen's data wiring is done.
    navigation?.navigate?.('Capture', { projectId });
  };
  return (
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space.gutter, paddingTop: 24, paddingBottom: 20 }}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.h1}>What space are you walking through?</Text>
          <Text style={styles.sub}>Sets the capture prompts and checklist for this stop.</Text>

          <Text style={styles.fieldLabel}>SURVEY NAME</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={selectedType ? defaultProjectName(selectedType.label) : 'e.g. Riverside Tower \u2014 Level 3'}
            placeholderTextColor={color.text30}
            style={styles.nameInput}
            returnKeyType="done"
            maxLength={60}
          />

          <View
            style={styles.grid}
            onLayout={(e) => setGridW(e.nativeEvent.layout.width)}
          >
            {cardW &&
              TYPES.map((t) => (
                <SpaceCard
                  key={t.id}
                  type={t}
                  width={cardW}
                  selected={selected === t.id}
                  onPress={() => setSelected((prev) => (prev === t.id ? null : t.id))}
                />
              ))}
          </View>
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <ContinueButton enabled={enabled} onPress={onContinue} />
        </View>
      </View>
    </Backdrop>
  );
}

function SpaceCard({ type, selected, onPress, width }) {
  const { label, Icon, create } = type;

  const cardStyle = selected
    ? styles.cardSelected
    : create
    ? styles.cardCreate
    : styles.card;

  const swatchStyle = selected ? styles.swatchSelected : styles.swatch;
  const glyphColor = selected ? color.ink : color.accent;

  return (
    <Press onPress={onPress} scaleTo={0.97} style={{ width }}>
      <View style={[styles.cardBase, cardStyle]}>
        <View style={[styles.check, { opacity: selected ? 1 : 0 }]} pointerEvents="none">
          <CheckBadge />
        </View>
        <View style={swatchStyle}>
          <Icon stroke={glyphColor} />
        </View>
        <Text style={styles.cardLabel}>{label}</Text>
      </View>
    </Press>
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
      <Press
        onPress={onPress}
        scaleTo={0.98}
        // let the gradient own the visuals; Press just handles the touch + scale
      >
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
  nameInput: {
    height: 52, borderRadius: radius.spaceCard,
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder,
    paddingHorizontal: 16, ...font(600, 15), color: color.textPrimary,
  },

  grid: {
    flexDirection: 'row', flexWrap: 'wrap',
    columnGap: space.gridGap, rowGap: space.gridGap,
    marginTop: 22,
  },

  cardBase: {
    borderRadius: radius.spaceCard,
    padding: 13,
    minHeight: 92,
    justifyContent: 'flex-end',
  },
  card: { backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder },
  cardCreate: {
    backgroundColor: color.accentTint05,
    borderWidth: 1.5, borderColor: color.accentTint40, borderStyle: 'dashed',
  },
  cardSelected: {
    backgroundColor: color.accentTint10,
    borderWidth: 1.5, borderColor: color.accent,
    // iOS-only glow. Deliberately NO `elevation` here: on Android, elevation
    // draws a shadow from the view outline, and because this card's fill is
    // translucent (10%), that shadow renders straight through it as a black
    // box. The border + tint already carry the selected state on Android.
    shadowColor: color.accent, shadowOpacity: 0.35, shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },

  check: { position: 'absolute', top: 13, right: 13 },

  swatch: {
    width: 32, height: 32, borderRadius: radius.iconSquare,
    backgroundColor: color.accentTint12,
    alignItems: 'center', justifyContent: 'center', marginBottom: 10,
  },
  swatchSelected: {
    width: 32, height: 32, borderRadius: radius.iconSquare,
    backgroundColor: color.accent,
    alignItems: 'center', justifyContent: 'center', marginBottom: 10,
  },
  cardLabel: { ...font(600, 12.5), color: color.textPrimary },

  footer: { paddingHorizontal: space.gutter, paddingTop: 10 },
  btn: { height: 52, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' },
  btnDisabled: { backgroundColor: color.cardFillDisabled },
  btnLabel: { ...font(700, 15) },
});
