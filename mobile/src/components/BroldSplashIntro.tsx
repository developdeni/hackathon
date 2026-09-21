import { useEffect } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';
import { Text } from './AppText';
import { colors } from '../theme/colors';
import { fontFamilies } from '../theme/typography';

export function BroldSplashIntro({ onFinish }: { onFinish: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onFinish, 1400);
    return () => clearTimeout(timer);
  }, [onFinish]);
  return (
    <Pressable style={styles.overlay} onPress={onFinish} accessibilityLabel="Открыть Tanap AI">
      <View style={styles.logoPlate}>
        <Image source={require('../../assets/brold_bear_logo.png')} style={styles.logo} resizeMode="contain" />
      </View>
      <View style={styles.brandBlock}>
        <Text style={styles.title}>BROLD DEV</Text>
        <Text style={styles.credit}>ceo. Данил Мирошниченко</Text>
      </View>
      <ActivityIndicator color={colors.primary} style={styles.loader} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 999999, elevation: 999, backgroundColor: '#F4F7F3', alignItems: 'center', justifyContent: 'center', gap: 20 },
  logoPlate: { width: 124, height: 124, borderRadius: 62, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 104, height: 104 },
  brandBlock: { alignItems: 'center', gap: 6 },
  title: { fontFamily: fontFamilies.bold, fontSize: 28, color: colors.primaryDark, letterSpacing: 0 },
  credit: { fontFamily: fontFamilies.medium, fontSize: 14, color: colors.textSecondary },
  loader: { marginTop: 8 },
});
