import React from 'react';
import { Text, TouchableOpacity, View, TextInput, StyleSheet } from 'react-native';
import { C, TAP, FONT } from '../theme';

export const Btn = ({ label, onPress, kind = 'primary', style, small }) => (
  <TouchableOpacity
    onPress={onPress}
    activeOpacity={0.8}
    style={[
      s.btn,
      kind === 'primary' && { backgroundColor: C.amber },
      kind === 'ghost' && { backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge },
      kind === 'danger' && { backgroundColor: C.red },
      small && { minHeight: 40, paddingHorizontal: 14 },
      style,
    ]}
  >
    <Text style={[s.btnText, kind === 'primary' ? { color: C.amberInk } : { color: C.ink }, small && { fontSize: 13 }]}>
      {label}
    </Text>
  </TouchableOpacity>
);

export const Chip = ({ label, active, onPress, color = C.amber }) => (
  <TouchableOpacity
    onPress={onPress}
    activeOpacity={0.8}
    style={[s.chip, active && { backgroundColor: color, borderColor: color }]}
  >
    <Text style={[s.chipText, active && { color: C.amberInk }]}>{label}</Text>
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
      placeholderTextColor={C.inkDim}
      keyboardType={keyboardType}
      autoCapitalize={autoCapitalize}
    />
  </View>
);

export const SectionLabel = ({ children }) => <Text style={s.section}>{children}</Text>;

const s = StyleSheet.create({
  btn: {
    minHeight: TAP,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  btnText: { ...FONT.display, fontSize: 15 },
  chip: {
    paddingHorizontal: 14,
    minHeight: 42,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.panelEdge,
    backgroundColor: C.panel,
    marginRight: 8,
    marginBottom: 8,
  },
  chipText: { color: C.ink, fontWeight: '700', fontSize: 13 },
  fieldLabel: { ...FONT.label, color: C.inkDim, marginBottom: 6 },
  input: {
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.panelEdge,
    borderRadius: 10,
    color: C.ink,
    paddingHorizontal: 14,
    minHeight: TAP,
    fontSize: 16,
  },
  section: { ...FONT.label, color: C.amber, marginTop: 18, marginBottom: 8 },
});
