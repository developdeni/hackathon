import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from './AppText';

import { colors } from '../theme/colors';
import { typography } from '../theme/typography';

type Props = {
  title: string;
  text: string;
};

export function EmptyState({ title, text }: Props) {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    alignItems: 'center',
    gap: 6,
  },
  title: {
    ...typography.headline,
    color: colors.text,
    textAlign: 'center',
  },
  text: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: '92%',
  },
});
