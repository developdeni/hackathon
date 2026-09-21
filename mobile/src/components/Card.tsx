import React, { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, View, ViewStyle } from 'react-native';

import { colors } from '../theme/colors';

type Props = PropsWithChildren<{
  style?: ViewStyle;
  onPress?: () => void;
}>;

export function Card({ children, style, onPress }: Props) {
  const containerStyle = [styles.card, style];

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [containerStyle, pressed && styles.pressed]}
      >
        {children}
      </Pressable>
    );
  }

  return <View style={containerStyle}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    overflow: 'hidden',
  },
  pressed: {
    backgroundColor: colors.surfaceSecondary,
    opacity: 0.85,
  },
});
