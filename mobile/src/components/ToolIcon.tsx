import { SymbolView } from 'expo-symbols';

import type { ToolIconName } from './ToolIcon.types';
export type { ToolIconName } from './ToolIcon.types';
const symbols = {
  chat: 'bubble.left.and.bubble.right.fill', photo: 'camera.fill', count: 'leaf.fill',
  grain: 'square.grid.2x2.fill', livestock: 'pawprint.fill',
} as const;

export function ToolIcon({ name, size = 25, color = '#FFFFFF' }: { name: ToolIconName; size?: number; color?: string }) {
  return <SymbolView name={symbols[name]} size={size} tintColor={color} />;
}
