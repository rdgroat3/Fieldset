import React from 'react';
import { Text, TouchableOpacity, View, TextInput, StyleSheet } from 'react-native';
import { TAP } from '../theme';
import { color, radius, font } from '../theme/tokens';

// `disabled` was accepted by callers but never wired to TouchableOpacity, so
// passing it did nothing: the Panel export button stayed live while a PDF was
// being built, and a second tap started a second concurrent export of the
// same panel. Both wrote to the same filename.
export const Btn = ({ label, onPress, kind = 'primary', style, small, disabled }) => (
  <TouchableOpacity
    onPress={onPress}
    disabled={disabled}
    activeOpacity={0.8}
    style={[
      s.btn,
      disabled && { opacity: 0.55 },
      kind === 'primary' && { backgroundColor: color.accent },
      kind === 'ghost' && { backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder },
      kind === 'danger' && { backgroundColor: '#e5484d' },
      small && { minHeight: 40, paddingHorizontal: 14 },
      style,
    ]}
  >
    <Text style={[s.btnText, kind === 'primary' ? { color: color.ink } : { color: color.textPrimary }, small && { fontSize: 13 }]}>
      {label}
    </Text>
  </TouchableOpacity>
);

export const Chip = ({ label, active, onPress, color: activeColor = color.accent }) => (
  <TouchableOpacity
    onPress={onPress}
    activeOpacity={0.8}
    style={[s.chip, active && { backgroundColor: activeColor, borderColor: activeColor }]}
  >
    <Text style={[s.chipText, active && { color: color.ink }]}>{label}</Text>
  </TouchableOpacity>
);

export const Field = ({ label, value, onChangeText, placeholder, keyboardType, autoCapitalize }) => (
  <View style={{ marginBottom: 14 }}>
    <Text style={s.fieldLabel}>{label}</Text>
    <TextInput
      style={s.input}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={color.text30}
      keyboardType={keyboardType}
      autoCapitalize={autoCapitalize}
    />
  </View>
);

export const SectionLabel = ({ children }) => <Text style={s.section}>{children}</Text>;

const s = StyleSheet.create({
  btn: {
    minHeight: TAP,
    borderRadius: radius.button,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  btnText: { ...font(700, 15) },
  chip: {
    paddingHorizontal: 14,
    minHeight: 42,
    justifyContent: 'center',
    borderRadius: radius.spaceCard,
    borderWidth: 1,
    borderColor: color.cardBorder,
    backgroundColor: color.cardFill,
    marginRight: 8,
    marginBottom: 8,
  },
  chipText: { ...font(700, 13), color: color.textPrimary },
  fieldLabel: { ...font(700, 11, { mono: true, ls: 0.8 }), color: color.text45, marginBottom: 6 },
  input: {
    backgroundColor: color.cardFill,
    borderWidth: 1,
    borderColor: color.cardBorder,
    borderRadius: radius.button,
    color: color.textPrimary,
    paddingHorizontal: 14,
    minHeight: TAP,
    fontSize: 16,
  },
  section: { ...font(700, 11, { mono: true, ls: 0.8 }), color: color.accent, marginTop: 18, marginBottom: 8 },
});
