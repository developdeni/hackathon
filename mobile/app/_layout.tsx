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
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerShadowVisible: false,
          headerTintColor: colors.primaryDark,
          headerTitleStyle: {
            fontFamily: fontFamilies.bold,
            fontSize: 18,
          },
          headerBackTitle: '',
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Tanap AI' }} />
        <Stack.Screen name="field/[id]" options={{ title: 'Карточка поля' }} />
        <Stack.Screen name="field/[id]/new-inspection" options={{ title: 'Новый осмотр' }} />
        <Stack.Screen name="inspection/[id]" options={{ title: 'Осмотр' }} />
      </Stack>
    </>
  );
}
