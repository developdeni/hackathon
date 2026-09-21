import { forwardRef } from 'react';
import {
  Text as RNText,
  TextInput as RNTextInput,
  TextProps,
  TextInputProps,
  Platform,
  StyleSheet,
  TextStyle,
} from 'react-native';
import { fontFamilies } from '../theme/typography';

function systemTypography(style: TextProps['style']): TextStyle {
  const flat = StyleSheet.flatten(style);
  if (Platform.OS === 'ios') {
    const weights: Record<string, TextStyle['fontWeight']> = {
      [fontFamilies.regular]: '400',
      [fontFamilies.medium]: '500',
      [fontFamilies.semiBold]: '600',
      [fontFamilies.bold]: '700',
    };
    return {
      fontFamily: 'System',
      fontWeight: flat?.fontWeight ?? weights[flat?.fontFamily ?? ''] ?? '400',
      letterSpacing: 0,
    };
  }
  if (Platform.OS === 'web') {
    return {
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
      letterSpacing: 0,
    };
  }
  // Android — use Montserrat (loaded via useFonts in _layout.tsx)
  const fontMap: Record<string, string> = {
    [fontFamilies.regular]: 'Montserrat_400Regular',
    [fontFamilies.medium]: 'Montserrat_500Medium',
    [fontFamilies.semiBold]: 'Montserrat_600SemiBold',
    [fontFamilies.bold]: 'Montserrat_700Bold',
  };
  const resolvedFont = flat?.fontFamily ? (fontMap[flat.fontFamily] ?? flat.fontFamily) : 'Montserrat_400Regular';
  return { fontFamily: resolvedFont };
}

// Единая точка отключения системного масштабирования шрифта (Dynamic Type /
// «Размер текста» в настройках iOS). Вёрстка приложения плотная и не должна
// зависеть от системного размера шрифта, поэтому allowFontScaling всегда false.
// Значения ставятся ПОСЛЕ спреда, чтобы их нельзя было случайно переопределить.

export const Text = forwardRef<RNText, TextProps>(function Text(props, ref) {
  return <RNText ref={ref} {...props} style={[props.style, systemTypography(props.style)]} allowFontScaling={false} maxFontSizeMultiplier={1} />;
});

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput(props, ref) {
  return <RNTextInput ref={ref} {...props} style={[props.style, systemTypography(props.style)]} allowFontScaling={false} maxFontSizeMultiplier={1} />;
});
