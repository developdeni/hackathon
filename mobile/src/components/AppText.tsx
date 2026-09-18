import { forwardRef } from 'react';
import {
  Text as RNText,
  TextInput as RNTextInput,
  TextProps,
  TextInputProps,
} from 'react-native';

// Единая точка отключения системного масштабирования шрифта (Dynamic Type /
// «Размер текста» в настройках iOS). Вёрстка приложения плотная и не должна
// зависеть от системного размера шрифта, поэтому allowFontScaling всегда false.
// Значения ставятся ПОСЛЕ спреда, чтобы их нельзя было случайно переопределить.

export const Text = forwardRef<RNText, TextProps>(function Text(props, ref) {
  return <RNText ref={ref} {...props} allowFontScaling={false} maxFontSizeMultiplier={1} />;
});

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput(props, ref) {
  return <RNTextInput ref={ref} {...props} allowFontScaling={false} maxFontSizeMultiplier={1} />;
});
