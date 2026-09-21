import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { VoiceRecordingResult } from './voice-recorder';

let activeRecorder: any = null;

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as any);
  }
  return btoa(binary);
}

export async function startNativeOrWebRecording(): Promise<void> {
  const perm = await requestRecordingPermissionsAsync();
  if (!perm.granted) {
    throw new Error('Разрешите доступ к микрофону в Настройках устройства для записи голосового отчета.');
  }

  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
  });

  const recorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
  await recorder.prepareToRecordAsync();
  recorder.record();
  activeRecorder = recorder;
}

export async function stopNativeOrWebRecording(): Promise<VoiceRecordingResult | null> {
  if (!activeRecorder) {
    return null;
  }

  const recorder = activeRecorder;
  activeRecorder = null;

  await recorder.stop();
  const uri = recorder.uri;
  if (!uri) {
    return null;
  }

  let audioBase64 = '';
  try {
    const response = await fetch(uri);
    const blob = await response.blob();
    const base64Promise = new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve(reader.result as string);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    audioBase64 = await base64Promise;
  } catch {
    const response = await fetch(uri);
    const arrayBuffer = await response.arrayBuffer();
    const b64 = bufferToBase64(arrayBuffer);
    audioBase64 = `data:audio/m4a;base64,${b64}`;
  }

  return {
    audioBase64,
    mimeType: 'audio/m4a',
  };
}

export async function cancelNativeOrWebRecording(): Promise<void> {
  if (activeRecorder) {
    try {
      await activeRecorder.stop();
    } catch {
      // ignore
    }
    activeRecorder = null;
  }
}
