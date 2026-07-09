import React from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { ProjectProvider } from './src/store/ProjectContext';
import { C } from './src/theme';

import ProjectsScreen from './src/screens/ProjectsScreen';
import NewProjectScreen from './src/screens/NewProjectScreen';
import ProjectHomeScreen from './src/screens/ProjectHomeScreen';
import CaptureScreen from './src/screens/CaptureScreen';
import ReviewScreen from './src/screens/ReviewScreen';
import GalleryScreen from './src/screens/GalleryScreen';
import ExportScreen from './src/screens/ExportScreen';
import { PanelsScreen, PanelDetailScreen } from './src/screens/PanelScreens';
import ARPipeSizerScreen from './src/screens/ARPipeSizerScreen';
import ExperimentalScreen from './src/screens/ExperimentalScreen';
import LightMeterScreen from './src/screens/LightMeterScreen';
import CCTScreen from './src/screens/CCTScreen';
import SettingsScreen from './src/screens/SettingsScreen';

const Stack = createNativeStackNavigator();

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: C.bg, card: C.bg, text: C.ink, primary: C.amber, border: C.panelEdge },
};

export default function App() {
  return (
    <ProjectProvider>
      <NavigationContainer theme={theme}>
        <StatusBar style="light" />
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: C.bg },
            headerTintColor: C.amber,
            headerTitleStyle: { color: C.ink, fontWeight: '800' },
            headerShadowVisible: false,
          }}
        >
          <Stack.Screen name="Projects" component={ProjectsScreen} options={{ headerShown: false }} />
          <Stack.Screen name="NewProject" component={NewProjectScreen} options={{ title: 'New Survey' }} />
          <Stack.Screen name="ProjectHome" component={ProjectHomeScreen} options={{ title: 'Survey' }} />
          <Stack.Screen name="Capture" component={CaptureScreen} options={{ title: 'Capture' }} />
          <Stack.Screen name="Review" component={ReviewScreen} options={{ title: 'Review Shot', headerBackVisible: false }} />
          <Stack.Screen name="Gallery" component={GalleryScreen} options={{ title: 'Photos' }} />
          <Stack.Screen name="Panels" component={PanelsScreen} options={{ title: 'Panelboards' }} />
          <Stack.Screen name="PanelDetail" component={PanelDetailScreen} options={{ title: 'Panel Session' }} />
          <Stack.Screen name="Export" component={ExportScreen} options={{ title: 'Export' }} />
          <Stack.Screen name="Experimental" component={ExperimentalScreen} options={{ title: 'Experimental' }} />
          <Stack.Screen name="ARPipeSizer" component={ARPipeSizerScreen} options={{ title: 'AR Sizer (Experimental)' }} />
          <Stack.Screen name="LightMeter" component={LightMeterScreen} options={{ title: 'Footcandles (Experimental)' }} />
          <Stack.Screen name="CCT" component={CCTScreen} options={{ title: 'Color Temp (Experimental)' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </ProjectProvider>
  );
}
