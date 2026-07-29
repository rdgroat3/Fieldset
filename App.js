import React from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { ProjectProvider } from './src/store/ProjectContext';
import PermissionGate from './src/components/PermissionGate';
import { color } from './src/theme/tokens';

import ProjectsScreen from './src/screens/ProjectsScreen';
import ProjectHomeScreen from './src/screens/ProjectHomeScreen';
import GalleryScreen from './src/screens/GalleryScreen';
import ExportScreen from './src/screens/ExportScreen';
import { PanelsScreen, PanelDetailScreen } from './src/screens/PanelScreens';
import SettingsScreen from './src/screens/SettingsScreen';

// UI refresh screens
import LandingScreen from './src/screens/LandingScreen';
import SpaceTypeScreen from './src/screens/SpaceTypeScreen';
import CreateSpaceTypeScreen from './src/screens/CreateSpaceTypeScreen';
import CameraScreen from './src/screens/CameraScreen';
import FinalizeScreen from './src/screens/FinalizeScreen';
import DecoderScreen from './src/screens/DecoderScreen';
import EquipmentScreen from './src/screens/EquipmentScreen';

const Stack = createNativeStackNavigator();

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: color.bgBottom, card: color.bgBottom, text: color.textPrimary, primary: color.accent, border: color.cardBorder },
};

export default function App() {
  return (
    <ProjectProvider>
      <NavigationContainer theme={theme}>
        <StatusBar style="light" />
        {/* Asks for camera/mic/library once, up front, with an explanation —
            instead of ambushing the surveyor mid-walkthrough. */}
        <PermissionGate>
        <Stack.Navigator
          initialRouteName="Landing"
          screenOptions={{
            headerStyle: { backgroundColor: color.bgBottom },
            headerTintColor: color.accent,
            headerTitleStyle: { color: color.textPrimary, fontWeight: '700' },
            headerShadowVisible: false,
          }}
        >
          <Stack.Screen name="Projects" component={ProjectsScreen} options={{ headerShown: false }} />
          <Stack.Screen name="ProjectHome" component={ProjectHomeScreen} options={{ headerShown: false }} />

          {/* UI refresh — full-bleed custom designs, no native header */}
          <Stack.Screen name="Landing" component={LandingScreen} options={{ headerShown: false }} />
          <Stack.Screen name="SpaceType" component={SpaceTypeScreen} options={{ headerShown: false }} />
          <Stack.Screen name="CreateSpaceType" component={CreateSpaceTypeScreen} options={{ headerShown: false }} />

          {/* CameraScreen is the real capture screen (camera + tagging +
              ProjectContext persistence), registered under 'Capture'. */}
          <Stack.Screen name="Capture" component={CameraScreen} options={{ headerShown: false }} />
          {/* Finalize sits between Camera's "Finish" and ProjectHome: bulk
              review, tag, move, and delete pass over the survey's photos. */}
          <Stack.Screen name="Finalize" component={FinalizeScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Decoder" component={DecoderScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Equipment" component={EquipmentScreen} options={{ headerShown: false }} />

          <Stack.Screen name="Gallery" component={GalleryScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Panels" component={PanelsScreen} options={{ headerShown: false }} />
          <Stack.Screen name="PanelDetail" component={PanelDetailScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Export" component={ExportScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ headerShown: false }} />
        </Stack.Navigator>
        </PermissionGate>
      </NavigationContainer>
    </ProjectProvider>
  );
}
