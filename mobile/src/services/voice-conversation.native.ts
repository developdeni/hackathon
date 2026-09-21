import { AudioModule, setAudioModeAsync } from 'expo-audio';
import type { VoiceConversationConfig, VoicePhase } from './voice-conversation';

// ── Tuning constants ───────────────────────────────────────────────────────
const POLL_MS = 120;
const CALIB_MS = 500;          // noise-floor calibration window at cycle start
const SILENCE_HOLD_MS = 1100;  // silence after speech before we treat it as end-of-utterance
const MIN_SPEECH_MS = 350;     // ignore blips shorter than this
const MAX_UTTERANCE_MS = 15000;
const SPEECH_MARGIN_DB = 12;   // level above noise floor that counts as speech
const SPEECH_OFF_MARGIN_DB = 6;
const SPEECH_ON_CEIL = -30;    // speech threshold never stricter than this
const LEVEL_FLOOR = -55;       // for UI level normalisation

let running = false;
let recorder: any = null;
let poll: any = null;
let phase: VoicePhase = 'idle';
let cfg: VoiceConversationConfig | null = null;

function setPhase(p: VoicePhase) {
  phase = p;
  cfg?.onPhase(p);
}

function clearPoll() {
  if (poll) {
    clearInterval(poll);
    poll = null;
  }
}

async function setRecordMode() {
  try {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
  } catch {
    // ignore
  }
}

async function setPlaybackMode() {
  // Loud speaker output for TTS (recording category routes to the quiet earpiece on iOS).
  try {
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  } catch {
    // ignore
  }
}

async function makeRecorder(): Promise<any> {
  await setRecordMode();
  const options = {
    extension: '.m4a',
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 64000,
    outputFormat: 'aac ',
    audioQuality: 96,
    isMeteringEnabled: true,
  };
  const rec = new AudioModule.AudioRecorder(options);
  await rec.prepareToRecordAsync();
  rec.record();
  return rec;
}

async function recorderToBase64(rec: any): Promise<string | null> {
  const uri = rec?.uri;
  if (!uri) return null;
  try {
    const response = await fetch(uri);
    const buf = await response.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)) as any);
    }
    return btoa(binary);
  } catch {
    return null;
  }
}

async function safeStop(rec: any) {
  try {
    await rec?.stop();
  } catch {
    // ignore
  }
}

// One listening cycle: record until end-of-speech (silence) is detected, then resolve
// with the captured audio (or null if it was just noise / too short).
function listenOnce(): Promise<{ audioBase64: string; mimeType: string } | null> {
  return new Promise(async (resolve) => {
    let rec: any;
    try {
      rec = await makeRecorder();
    } catch (e: any) {
      cfg?.onError?.(e?.message || 'Микрофон недоступен');
      resolve(null);
      return;
    }
    recorder = rec;

    const startedAt = Date.now();
    let floor = -60;
    let hadSpeech = false;
    let speechStart: number | null = null;
    let silenceStart: number | null = null;

    clearPoll();
    poll = setInterval(async () => {
      if (!running) {
        clearPoll();
        await safeStop(rec);
        resolve(null);
        return;
      }
      let level = -160;
      try {
        const st = rec.getStatus();
        level = typeof st?.metering === 'number' ? st.metering : -160;
      } catch {
        // ignore
      }
      const now = Date.now();
      const elapsed = now - startedAt;

      // Calibrate noise floor at the very start of the cycle.
      if (elapsed < CALIB_MS) {
        floor = Math.max(floor, level); // track loudest ambient as a conservative floor
      }
      const speechOn = Math.min(floor + SPEECH_MARGIN_DB, SPEECH_ON_CEIL);
      const speechOff = floor + SPEECH_OFF_MARGIN_DB;

      // UI level (0..1)
      const norm = Math.max(0, Math.min(1, (level - LEVEL_FLOOR) / (0 - LEVEL_FLOOR)));
      cfg?.onLevel?.(norm);

      if (level > speechOn) {
        hadSpeech = true;
        if (speechStart == null) speechStart = now;
        silenceStart = null;
      } else if (hadSpeech && level < speechOff) {
        if (silenceStart == null) silenceStart = now;
        const spokenMs = speechStart != null ? now - speechStart : 0;
        if (now - silenceStart >= SILENCE_HOLD_MS && spokenMs >= MIN_SPEECH_MS) {
          clearPoll();
          await safeStop(rec);
          const b64 = await recorderToBase64(rec);
          resolve(b64 ? { audioBase64: b64, mimeType: 'audio/m4a' } : null);
          return;
        }
      }

      // Safety cap on utterance length.
      if (hadSpeech && elapsed > MAX_UTTERANCE_MS) {
        clearPoll();
        await safeStop(rec);
        const b64 = await recorderToBase64(rec);
        resolve(b64 ? { audioBase64: b64, mimeType: 'audio/m4a' } : null);
      }
    }, POLL_MS);
  });
}

async function loop() {
  while (running) {
    setPhase('listening');
    const utterance = await listenOnce();
    if (!running) break;
    if (!utterance) {
      // nothing captured — keep listening
      continue;
    }

    setPhase('thinking');
    let result: { question: string; answer: string } | null = null;
    try {
      result = await cfg!.sendUtterance(utterance.audioBase64, utterance.mimeType);
    } catch (e: any) {
      cfg?.onError?.(e?.message || 'Не удалось получить ответ');
      result = null;
    }
    if (!running) break;
    if (!result || !result.answer) {
      continue; // resume listening
    }

    cfg!.onExchange(result.question, result.answer);

    setPhase('speaking');
    await setPlaybackMode();
    try {
      await cfg!.speak(result.answer);
    } catch {
      // ignore TTS errors
    }
    if (!running) break;
    // After speaking, loop resumes listening automatically (hands-free).
  }
}

export async function startConversation(config: VoiceConversationConfig): Promise<void> {
  if (running) return;
  cfg = config;
  running = true;
  try {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
  } catch {
    // ignore
  }
  void loop().finally(() => {
    setPhase('idle');
  });
}

export function stopConversation(): void {
  running = false;
  clearPoll();
  cfg?.stopSpeak?.();
  if (recorder) {
    void safeStop(recorder);
    recorder = null;
  }
  setPhase('idle');
}

// Tap-to-interrupt: stop current TTS and jump straight back to listening.
export function interruptAndListen(): void {
  cfg?.stopSpeak?.();
  // The loop is awaiting speak(); stopping TTS resolves it, and the loop resumes listening.
}
