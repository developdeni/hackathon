import { VoiceRecordingResult } from './voice-recorder';

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let activeStream: MediaStream | null = null;
let activeMimeType = 'audio/webm';

export async function startNativeOrWebRecording(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Микрофон не поддерживается в текущем браузере.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  activeStream = stream;
  audioChunks = [];
  activeMimeType =
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : 'audio/ogg';

  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      audioChunks.push(event.data);
    }
  };

  mediaRecorder = recorder;
  recorder.start(250);
}

export async function stopNativeOrWebRecording(): Promise<VoiceRecordingResult | null> {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      if (activeStream) {
        activeStream.getTracks().forEach((track) => track.stop());
        activeStream = null;
      }
      resolve(null);
      return;
    }

    mediaRecorder.onstop = async () => {
      try {
        if (activeStream) {
          activeStream.getTracks().forEach((track) => track.stop());
          activeStream = null;
        }
        const blob = new Blob(audioChunks, { type: activeMimeType });
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          resolve({
            audioBase64: result,
            mimeType: activeMimeType,
          });
        };
        reader.onerror = (e) => reject(e);
        reader.readAsDataURL(blob);
      } catch (e) {
        reject(e);
      }
    };

    mediaRecorder.stop();
  });
}

export async function cancelNativeOrWebRecording(): Promise<void> {
  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
    } catch {
      // ignore
    }
  }
  audioChunks = [];
  mediaRecorder = null;
}
