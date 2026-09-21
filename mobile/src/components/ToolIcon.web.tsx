import { Camera, Grid2X2, Leaf, MessagesSquare, PawPrint } from 'lucide-react';
import type { ToolIconName } from './ToolIcon.types';
export type { ToolIconName } from './ToolIcon.types';

const icons = { chat: MessagesSquare, photo: Camera, count: Leaf, grain: Grid2X2, livestock: PawPrint };
export function ToolIcon({ name, size = 25, color = '#FFFFFF' }: { name: ToolIconName; size?: number; color?: string }) {
  const Icon = icons[name];
  return <Icon size={size} color={color} strokeWidth={1.8} aria-hidden="true" />;
}
