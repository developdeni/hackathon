import { StyleSheet, View } from 'react-native';
import { Text } from './AppText';
import { colors } from '../theme/colors';
import { fontFamilies } from '../theme/typography';

type AvatarProps = {
  name: string;
  size?: number;
};

/** Extracts up to 2 initials from a full name */
function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** A simple letter-based avatar that doesn't require any image */
export function Avatar({ name, size = 40 }: AvatarProps) {
  const initials = getInitials(name);
  const fontSize = Math.round(size * 0.38);

  return (
    <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.initials, { fontSize }]}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontFamily: fontFamilies.bold,
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
});
