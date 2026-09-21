// Continuous hands-free voice conversation controller (types + no-op web fallback).
// The real implementation lives in voice-conversation.native.ts.

export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking';

export type VoiceConversationConfig = {
  onPhase: (phase: VoicePhase) => void;
  onLevel?: (level01: number) => void;
  sendUtterance: (audioBase64: string, mimeType: string) => Promise<{ question: string; answer: string }>;
  speak: (text: string) => Promise<void>;
  stopSpeak: () => void;
  onExchange: (question: string, answer: string) => void;
  onError?: (message: string) => void;
};

export async function startConversation(_config: VoiceConversationConfig): Promise<void> {
  throw new Error('Голосовой режим доступен только в мобильном приложении.');
}

export function stopConversation(): void {
  // no-op on web
}

export function interruptAndListen(): void {
  // no-op on web
}
