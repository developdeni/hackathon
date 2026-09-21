import {
  AudioModule,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { MicrophonePermissionResult, VoiceRecordingResult } from './voice-recorder';

let activeRecorder: any = null;

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk as any);
  }
  return btoa(binary);
}

/**
 * Checks or requests microphone recording permissions on native iOS/Android
 */
export async function checkMicrophonePermission(): Promise<MicrophonePermissionResult> {
  try {
    const current = await getRecordingPermissionsAsync();
    if (current.granted) {
      return {
        granted: true,
        canAskAgain: true,
        status: 'granted',
      };
    }

    // If undetermined or can ask again, ask the system
    if (current.status === 'undetermined' || current.canAskAgain !== false) {
      const requested = await requestRecordingPermissionsAsync();
      return {
        granted: requested.granted,
        canAskAgain: requested.canAskAgain ?? true,
        status: requested.granted ? 'granted' : (requested.status as any),
      };
    }

    return {
      granted: false,
      canAskAgain: false,
      status: current.status as any,
    };
  } catch {
    // Fallback: try direct request
    try {
      const requested = await requestRecordingPermissionsAsync();
      return {
        granted: requested.granted,
        canAskAgain: requested.canAskAgain ?? true,
        status: requested.granted ? 'granted' : 'denied',
      };
    } catch {
      return {
        granted: false,
        canAskAgain: false,
        status: 'denied',
      };
    }
  }
}

/**
 * Starts audio recording on iOS/Android device
 */
export async function startNativeOrWebRecording(): Promise<void> {
  const perm = await checkMicrophonePermission();
  if (!perm.granted) {
    throw new Error('Разрешите доступ к микрофону в Настройках устройства для записи голосового отчёта.');
  }

  // Cancel any lingering recorder first
  if (activeRecorder) {
    try {
      await activeRecorder.stop();
    } catch {}
    activeRecorder = null;
  }

  // Set audio session mode for recording
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
  });

  // Flat options matching Swift RecordingOptions: Record struct
  const recordingOptions = {
    extension: '.m4a',
    sampleRate: 44100,
    numberOfChannels: 1, // Mono voice memo (compact file, perfect for speech AI)
    bitRate: 64000,      // 64kbps AAC -> ~480 KB per minute, well under 1 MB!
    outputFormat: 'aac ',
    audioQuality: 96,
    isMeteringEnabled: false,
  };

  const recorder = new AudioModule.AudioRecorder(recordingOptions);
  await recorder.prepareToRecordAsync();
  recorder.record();
  activeRecorder = recorder;
}

/**
 * Stops audio recording and returns base64 encoded audio
 */
export async function stopNativeOrWebRecording(): Promise<VoiceRecordingResult | null> {
  if (!activeRecorder) {
    return null;
  }

  const recorder = activeRecorder;
  activeRecorder = null;

  try {
    await recorder.stop();
  } catch (err) {
    console.warn('Error stopping recorder:', err);
  }

  const uri = recorder.uri;
  if (!uri) {
    return null;
  }

  let audioBase64 = '';
  try {
    const response = await fetch(uri);
    const arrayBuf = await response.arrayBuffer();
    audioBase64 = bufferToBase64(arrayBuf);
  } catch {
    // Fallback using FileReader
    try {
      const response = await fetch(uri);
      const blob = await response.blob();
      const base64Promise = new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const res = reader.result as string;
          resolve(res.includes(',') ? res.split(',')[1] : res);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      audioBase64 = await base64Promise;
    } catch (e) {
      console.warn('Failed to convert audio to base64:', e);
      return null;
    }
  }

  return {
    audioBase64,
    mimeType: 'audio/m4a',
  };
}

/**
 * Cancels active recording without saving
 */
export async function cancelNativeOrWebRecording(): Promise<void> {
  if (activeRecorder) {
    try {
      await activeRecorder.stop();
    } catch {}
    activeRecorder = null;
  }
}
