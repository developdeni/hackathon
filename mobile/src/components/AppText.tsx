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

// Keep existing font tokens compatible while rendering native system typography.
function systemTypography(style: TextProps['style']): TextStyle {
  const flat = StyleSheet.flatten(style);
  const weights: Record<string, TextStyle['fontWeight']> = {
    [fontFamilies.regular]: '400',
    [fontFamilies.medium]: '500',
    [fontFamilies.semiBold]: '600',
    [fontFamilies.bold]: '700',
  };
  return {
    fontFamily: Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif' }),
    fontWeight: flat?.fontWeight ?? weights[flat?.fontFamily ?? ''] ?? '400',
    letterSpacing: 0,
  };
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
