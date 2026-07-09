import React from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { C, FONT } from '../theme';
import { Field, SectionLabel, Btn } from '../components/UI';
import { useProjects } from '../store/ProjectContext';
import { persistToApp } from '../utils/media';

export default function SettingsScreen() {
  const { settings, updateSettings } = useProjects();

  const pickLogo = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
    if (r.canceled || !r.assets?.[0]) return;
    // Copy into app storage so the logo survives if the original is deleted.
    const uri = await persistToApp(r.assets[0].uri, 'png');
    updateSettings({ logoUri: uri });
  };

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
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
                BLDG: Sample Tower | LVL: 02 | SPACE: Mechanical Room #01 | SYS: MECH | 2026-07-08 14:30
                {settings.firmName ? `  ·  ${settings.firmName}` : ''}
              </Text>
            </View>
          </View>
        </View>
        <Text style={s.hint}>Logo appears on PDF report headers; firm name is burned into the photo watermark bar.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  title: { color: C.ink, fontSize: 22, fontWeight: '800' },
  sub: { color: C.inkDim, fontSize: 12, marginTop: 4, marginBottom: 18 },
  logoRow: { flexDirection: 'row', gap: 14, alignItems: 'center', marginBottom: 8 },
  logo: { width: 110, height: 110, borderRadius: 12, backgroundColor: '#FFFFFF' },
  logoEmpty: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge, alignItems: 'center', justifyContent: 'center' },
  logoEmptyText: { color: C.inkDim, fontSize: 12 },
  preview: { borderRadius: 12, overflow: 'hidden' },
  previewImg: { height: 110, backgroundColor: '#3A4654', justifyContent: 'flex-end' },
  burnBar: { backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 8, paddingVertical: 6 },
  burnText: { color: '#FFF', fontSize: 10.5, fontWeight: '700' },
  hint: { color: C.inkDim, fontSize: 11, marginTop: 10, lineHeight: 16 },
});
