import React from 'react';
import { StyleSheet, TextStyle, View, ViewStyle } from 'react-native';
import { Text } from './AppText';

import { colors } from '../theme/colors';
import { fontFamilies } from '../theme/typography';

type BadgeVariant = 'demo' | 'success' | 'warning' | 'danger' | 'neutral' | 'primary' | 'muted' | 'info';

type Props = {
  label: string;
  variant?: BadgeVariant;
  style?: ViewStyle;
  textStyle?: TextStyle;
};

export function Badge({ label, variant = 'neutral', style, textStyle }: Props) {
  const vStyle = variantStyles[variant];

  return (
    <View style={[styles.badge, vStyle.container, style]}>
      <Text style={[styles.label, vStyle.text, textStyle]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    alignSelf: 'flex-start',
    flexShrink: 0,
  },
  label: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 10.5,
    letterSpacing: 0.2,
  },
});

const variantStyles: Record<BadgeVariant, { container: ViewStyle; text: TextStyle }> = {
  demo: {
    container: { backgroundColor: colors.warningSoft },
    text: { color: colors.warning },
  },
  success: {
    container: { backgroundColor: colors.successSoft },
    text: { color: colors.success },
  },
  warning: {
    container: { backgroundColor: colors.warningSoft },
    text: { color: colors.warning },
  },
  danger: {
    container: { backgroundColor: colors.dangerSoft },
    text: { color: colors.danger },
  },
  neutral: {
    container: { backgroundColor: '#EFEFF4' },
    text: { color: colors.textSecondary },
  },
  primary: {
    container: { backgroundColor: colors.primarySoft },
    text: { color: colors.primary },
  },
  muted: {
    container: { backgroundColor: '#EAEAEA' },
    text: { color: colors.muted },
  },
  info: {
    container: { backgroundColor: colors.infoSoft },
    text: { color: colors.info },
  },
};
