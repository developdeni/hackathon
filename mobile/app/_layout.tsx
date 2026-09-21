import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import {
  Montserrat_400Regular,
  Montserrat_500Medium,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
} from '@expo-google-fonts/montserrat';

import { colors } from '../src/theme/colors';
import { fontFamilies } from '../src/theme/typography';
import { AuthProvider } from '../src/contexts/AuthContext';
import { LanguageProvider } from '../src/i18n';
import { BroldSplashIntro } from '../src/components/BroldSplashIntro';

export default function RootLayout() {
  const [showSplash, setShowSplash] = useState(true);
  const [fontsLoaded] = useFonts({
    Montserrat_400Regular,
    Montserrat_500Medium,
    Montserrat_600SemiBold,
    Montserrat_700Bold,
  });

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <LanguageProvider>
    <AuthProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerShadowVisible: false,
          headerTintColor: colors.primaryDark,
          headerTitleStyle: {
            fontWeight: '600',
            fontSize: 17,
          },
          headerBackTitle: 'Назад',
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        {/* Auth screens — fullscreen, no header, no back gesture */}
        <Stack.Screen
          name="auth/login"
          options={{ headerShown: false, gestureEnabled: false }}
        />
        <Stack.Screen
          name="auth/register"
          options={{ headerShown: false, gestureEnabled: false }}
        />

        {/* Root — home screen: never allow back to auth */}
        <Stack.Screen
          name="index"
          options={{
            headerShown: false,
            headerBackTitle: 'Назад',
            title: 'Назад',
            gestureEnabled: false,
          }}
        />

        {/* Profile screens */}
        <Stack.Screen name="profile/me" options={{ title: 'Мой профиль', headerBackTitle: 'Назад' }} />
        <Stack.Screen name="profile/edit" options={{ title: 'Редактирование профиля', headerBackTitle: 'Назад' }} />
        <Stack.Screen name="profile/team" options={{ title: 'Команда', headerBackTitle: 'Назад' }} />
        <Stack.Screen name="profile/new" options={{ title: 'Новый профиль', headerBackTitle: 'Назад' }} />

        {/* Field screens */}
        <Stack.Screen name="field/new" options={{ title: 'Новый участок', headerBackTitle: 'Назад' }} />
        <Stack.Screen name="field/[id]" options={{ title: 'Карточка поля', headerBackTitle: 'Назад' }} />
        <Stack.Screen name="field/[id]/new-inspection" options={{ title: 'Новый осмотр', headerBackTitle: 'Назад' }} />
        <Stack.Screen name="field/[id]/yield-history" options={{ title: 'История урожайности', headerBackTitle: 'Назад' }} />

        {/* Inspection */}
        <Stack.Screen name="inspection/[id]" options={{ title: 'Осмотр', headerBackTitle: 'Назад' }} />
      </Stack>

      {showSplash && <BroldSplashIntro onFinish={() => setShowSplash(false)} />}
    </AuthProvider>
    </LanguageProvider>
  );
}
