import { Alert, Platform } from 'react-native';

/**
 * Cross-platform alert. On web (Telegram Mini App) React Native's `Alert.alert`
 * is a silent no-op, so the user never sees validation or error feedback.
 * Fall back to the native browser dialog there.
 */
export function notify(title: string, message?: string) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(message ? `${title}\n\n${message}` : title);
    }
    return;
  }
  Alert.alert(title, message);
}

/**
 * Cross-platform destructive confirmation. On web `Alert.alert` with buttons is a
 * no-op, so long-press "hold to delete" never confirms. Use `window.confirm` there.
 */
export function confirmDestructive(
  title: string,
  message: string,
  onConfirm: () => void,
  confirmLabel = 'Удалить',
  cancelLabel = 'Отмена',
) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (window.confirm(message ? `${title}\n\n${message}` : title)) onConfirm();
    }
    return;
  }
  Alert.alert(title, message, [
    { text: cancelLabel, style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}
