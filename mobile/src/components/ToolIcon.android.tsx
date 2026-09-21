import { Text, type TextStyle } from 'react-native';
import type { ToolIconName } from './ToolIcon.types';
export type { ToolIconName } from './ToolIcon.types';

const emojis: Record<ToolIconName, string> = {
  chat: '💬',
  photo: '📷',
  count: '🌿',
  grain: '🌾',
  livestock: '🐾',
};

export function ToolIcon({ name, size = 25 }: { name: ToolIconName; size?: number; color?: string }) {
  const style: TextStyle = { fontSize: size * 0.9, lineHeight: size * 1.1, textAlign: 'center' };
  return <Text style={style}>{emojis[name]}</Text>;
}
