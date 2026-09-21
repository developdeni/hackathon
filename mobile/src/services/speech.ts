import * as Speech from 'expo-speech';
import type { Lang } from '../i18n';

const LANG_TO_BCP47: Record<Lang, string> = {
  ru: 'ru-RU',
  kk: 'kk-KZ',
  en: 'en-US',
};

// Strip emojis, section markers and markdown so TTS reads a clean sentence flow.
function textForSpeech(raw: string): string {
  return raw
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu, ' ')
    .replace(/[*#_`>|]/g, ' ')
    .replace(/-{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stopSpeaking(): void {
  try {
    Speech.stop();
  } catch {
    // ignore
  }
}

export async function isSpeaking(): Promise<boolean> {
  try {
    return await Speech.isSpeakingAsync();
  } catch {
    return false;
  }
}

type SpeakCallbacks = {
  onStart?: () => void;
  onDone?: () => void;
  onError?: () => void;
};

// Promise version: resolves when TTS finishes, is stopped (interrupted), or errors.
export function speakAsync(text: string, lang: Lang, onStart?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const clean = textForSpeech(text);
    if (!clean) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      Speech.stop();
      Speech.speak(clean, {
        language: LANG_TO_BCP47[lang] ?? 'ru-RU',
        pitch: 1.0,
        rate: 0.98,
        onStart: () => onStart?.(),
        onDone: done,
        onStopped: done,
        onError: done,
      });
    } catch {
      done();
    }
  });
}

export function speakAnswer(text: string, lang: Lang, cb?: SpeakCallbacks): void {
  const clean = textForSpeech(text);
  if (!clean) {
    cb?.onDone?.();
    return;
  }
  try {
    Speech.stop();
    Speech.speak(clean, {
      language: LANG_TO_BCP47[lang] ?? 'ru-RU',
      pitch: 1.0,
      rate: 0.98,
      onStart: () => cb?.onStart?.(),
      onDone: () => cb?.onDone?.(),
      onStopped: () => cb?.onDone?.(),
      onError: () => cb?.onError?.(),
    });
  } catch {
    cb?.onError?.();
  }
}
