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

export default function RootLayout() {
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
    <AuthProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerShadowVisible: false,
          headerTintColor: colors.primaryDark,
          headerTitleStyle: {
            fontFamily: fontFamilies.bold,
            fontSize: 17,
          },
          headerBackTitle: '',
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
            gestureEnabled: false,
          }}
        />

        {/* Profile screens */}
        <Stack.Screen name="profile/me" options={{ title: 'Мой профиль' }} />
        <Stack.Screen name="profile/new" options={{ title: 'Новый профиль' }} />

        {/* Field screens */}
        <Stack.Screen name="field/new" options={{ title: 'Новый участок' }} />
        <Stack.Screen name="field/[id]" options={{ title: 'Карточка поля' }} />
        <Stack.Screen name="field/[id]/new-inspection" options={{ title: 'Новый осмотр' }} />

        {/* Inspection */}
        <Stack.Screen name="inspection/[id]" options={{ title: 'Осмотр' }} />
      </Stack>
    </AuthProvider>
  );
}
