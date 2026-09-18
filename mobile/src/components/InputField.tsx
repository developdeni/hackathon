import { StyleSheet, TextInputProps, View } from 'react-native';
import { Text, TextInput } from './AppText';
import { colors } from '../theme/colors';
import { fontFamilies } from '../theme/typography';

type InputFieldProps = TextInputProps & {
  label: string;
  error?: string;
};

export function InputField({ label, error, style, ...rest }: InputFieldProps) {
  return (
    <View style={styles.wrapper}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputWrap, error ? styles.inputWrapError : undefined]}>
        <TextInput
          style={[styles.input, style]}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          {...rest}
        />
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: 5,
  },
  label: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 12,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textSecondary,
    paddingHorizontal: 4,
  },
  inputWrap: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  inputWrapError: {
    borderColor: colors.danger,
  },
  input: {
    fontFamily: fontFamilies.regular,
    fontSize: 15,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 13,
    minHeight: 48,
  },
  errorText: {
    fontFamily: fontFamilies.regular,
    fontSize: 12,
    color: colors.danger,
    paddingHorizontal: 4,
  },
});
