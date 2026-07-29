import React from 'react';
import { View, Text, Image, TouchableOpacity, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Backdrop } from '../components/Surface';
import { color, radius, space, font } from '../theme/tokens';
import { Field, SectionLabel, Btn } from '../components/UI';
import { useProjects } from '../store/ProjectContext';
import { persistToApp } from '../utils/media';

export default function SettingsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { settings, updateSettings } = useProjects();

  const pickLogo = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
    if (r.canceled || !r.assets?.[0]) return;
    // Copy into app storage so the logo survives if the original is deleted.
    const uri = await persistToApp(r.assets[0].uri, 'png');
    updateSettings({ logoUri: uri });
  };

  return (
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={s.header}>
          <Pressable onPress={() => navigation?.goBack?.()} hitSlop={12}>
            <Text style={s.back}>{'\u2039 Back'}</Text>
          </Pressable>
          <Text style={s.h1}>Settings</Text>
          <View style={{ width: 44 }} />
        </View>
        <ScrollView contentContainerStyle={{ padding: space.gutter, paddingTop: 4, paddingBottom: 40 }}>
          <Text style={s.title}>Firm Branding</Text>
          <Text style={s.sub}>Applied to every photo watermark and printed on report headers.</Text>

          <Field label="Firm name" value={settings.firmName}
            onChangeText={(v) => updateSettings({ firmName: v })}
            placeholder="e.g. Meridian MEP Engineering" />

          <SectionLabel>Firm Logo (reports)</SectionLabel>
          <View style={s.logoRow}>
            {settings.logoUri ? (
              <Image source={{ uri: settings.logoUri }} style={s.logo} resizeMode="contain" />
            ) : (
              <View style={[s.logo, s.logoEmpty]}><Text style={s.logoEmptyText}>No logo</Text></View>
            )}
            <View style={{ flex: 1, gap: 8 }}>
              <Btn label={settings.logoUri ? 'REPLACE LOGO' : 'CHOOSE LOGO'} kind="ghost" small onPress={pickLogo} />
              {settings.logoUri && (
                <Btn label="REMOVE" kind="ghost" small onPress={() => updateSettings({ logoUri: null })} />
              )}
            </View>
          </View>

          <SectionLabel>Watermark Preview</SectionLabel>
          <View style={s.preview}>
            <View style={s.previewImg}>
              <View style={s.burnBar}>
                <Text style={s.burnText} numberOfLines={2}>
                  Sample Tower · FLOOR 02 · MECHANICAL ROOM #01
                  {settings.firmName ? `  ·  ${settings.firmName}` : ''}
                </Text>
              </View>
            </View>
          </View>
          <Text style={s.hint}>Logo appears on PDF report headers; firm name is burned into the photo watermark bar.</Text>

          <Text style={[s.title, { marginTop: 30 }]}>Capture Quality</Text>
          <Text style={s.sub}>
            Photos save at full quality by default. Burning the watermark into the
            image re-encodes it at screen resolution, which softens fine detail —
            turn it off when sharpness matters more than the stamp (nameplates,
            corroded pipe, panel schedules).
          </Text>

          <Toggle
            label="Burn watermark into photos"
            hint="Off keeps the original full-resolution file. Survey details are still recorded against every photo either way — you just won't see them printed on the image."
            value={settings.burnWatermark !== false}
            onToggle={() => updateSettings({ burnWatermark: settings.burnWatermark === false })}
          />

          <Toggle
            label="Warn on blurry shots"
            hint="Off stops the Keep/Retake popup. Blur is still measured and flagged in the gallery and reports."
            value={settings.blurCheck !== false}
            onToggle={() => updateSettings({ blurCheck: settings.blurCheck === false })}
          />

          <SectionLabel>JPEG Quality</SectionLabel>
          <View style={s.qRow}>
            {[
              { v: 1, label: 'MAX' },
              { v: 0.9, label: 'HIGH' },
              { v: 0.75, label: 'SMALLER FILES' },
            ].map((o) => {
              const cur = typeof settings.photoQuality === 'number' ? settings.photoQuality : 1;
              const on = Math.abs(cur - o.v) < 0.001;
              return (
                <TouchableOpacity
                  key={o.v}
                  style={[s.qChip, on && s.qChipOn]}
                  onPress={() => updateSettings({ photoQuality: o.v })}
                >
                  <Text style={[s.qChipText, on && s.qChipTextOn]}>{o.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={s.hint}>
            Applies to new photos only. MAX is recommended — a survey photo you
            can't zoom into is a site visit you have to repeat.
          </Text>
        </ScrollView>
      </View>
    </Backdrop>
  );
}

/** Row with a label, explanatory hint, and an on/off pill. */
function Toggle({ label, hint, value, onToggle }) {
  return (
    <TouchableOpacity style={s.toggleRow} onPress={onToggle} activeOpacity={0.7}>
      <View style={{ flex: 1 }}>
        <Text style={s.toggleLabel}>{label}</Text>
        {!!hint && <Text style={s.toggleHint}>{hint}</Text>}
      </View>
      <View style={[s.switch, value && s.switchOn]}>
        <View style={[s.knob, value && s.knobOn]} />
      </View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.gutter, paddingVertical: 12,
  },
  back: { ...font(700, 14), color: color.accent },
  h1: { ...font(600, 16), color: color.textPrimary },
  title: { ...font(700, 20, { lh: 1.2 }), color: color.textPrimary, marginTop: 6 },
  sub: { ...font(400, 12, { lh: 1.5 }), color: color.text45, marginTop: 4, marginBottom: 18 },
  logoRow: { flexDirection: 'row', gap: 14, alignItems: 'center', marginBottom: 8 },
  logo: { width: 110, height: 110, borderRadius: radius.card, backgroundColor: '#FFFFFF' },
  logoEmpty: { backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder, alignItems: 'center', justifyContent: 'center' },
  logoEmptyText: { ...font(400, 12), color: color.text45 },
  preview: { borderRadius: radius.card, overflow: 'hidden' },
  previewImg: { height: 110, backgroundColor: '#3A4654', justifyContent: 'flex-end' },
  burnBar: { backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 8, paddingVertical: 6 },
  burnText: { color: '#FFF', fontSize: 10.5, fontWeight: '700' },
  hint: { ...font(400, 11, { lh: 1.5 }), color: color.text45, marginTop: 10 },

  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: color.cardBorder,
  },
  toggleLabel: { ...font(600, 14), color: color.textPrimary },
  toggleHint: { ...font(400, 11, { lh: 1.45 }), color: color.text45, marginTop: 3 },
  switch: {
    width: 46, height: 28, borderRadius: 14, padding: 3,
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder,
    justifyContent: 'center',
  },
  switchOn: { backgroundColor: color.accent, borderColor: color.accent },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: color.text45 },
  knobOn: { backgroundColor: color.ink, alignSelf: 'flex-end' },

  qRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  qChip: {
    paddingHorizontal: 14, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder,
  },
  qChipOn: { backgroundColor: color.accent, borderColor: color.accent },
  qChipText: { ...font(700, 12, { mono: true, ls: 0.4 }), color: color.text45 },
  qChipTextOn: { color: color.ink },
});
