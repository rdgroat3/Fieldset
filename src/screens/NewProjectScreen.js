import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C } from '../theme';
import { BUILDING_PROFILES } from '../theme';
import { Btn, Chip, Field, SectionLabel } from '../components/UI';
import { useProjects } from '../store/ProjectContext';

export default function NewProjectScreen({ navigation }) {
  const { createProject } = useProjects();
  const [name, setName] = useState('');
  const [profile, setProfile] = useState('Commercial Office');
  const [levels, setLevels] = useState('B1, 01, 02');

  const create = () => {
    if (!name.trim()) return;
    const id = createProject({
      name: name.trim(),
      profile,
      levels: levels.split(',').map((l) => l.trim()).filter(Boolean),
      spaceTypes: BUILDING_PROFILES[profile],
    });
    navigation.replace('ProjectHome', { projectId: id });
  };

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={s.title}>New Survey</Text>

        <Field label="Survey / Building Name" value={name} onChangeText={setName} placeholder="e.g. Marriott Downtown — Ph1 Renovation" />
        <Field label="Levels (comma separated)" value={levels} onChangeText={setLevels} placeholder="B1, 01, 02, RF" autoCapitalize="characters" />

        <SectionLabel>Building Profile</SectionLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {Object.keys(BUILDING_PROFILES).map((p) => (
            <Chip key={p} label={p} active={profile === p} onPress={() => setProfile(p)} />
          ))}
        </View>
        <Text style={s.hint}>
          The profile pre-loads space names for one-tap tagging: {BUILDING_PROFILES[profile].slice(0, 4).join(', ')}…
        </Text>

        <Btn label="CREATE SURVEY" onPress={create} style={{ marginTop: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  title: { color: C.ink, fontSize: 22, fontWeight: '800', marginBottom: 18 },
  hint: { color: C.inkDim, fontSize: 12, marginTop: 6, lineHeight: 17 },
});
