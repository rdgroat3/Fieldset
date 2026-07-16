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
        </ScrollView>
      </View>
    </Backdrop>
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
});
