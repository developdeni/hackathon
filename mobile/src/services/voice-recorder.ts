export interface VoiceRecordingResult {
  audioBase64: string;
  mimeType: string;
}

export declare function startNativeOrWebRecording(): Promise<void>;
export declare function stopNativeOrWebRecording(): Promise<VoiceRecordingResult | null>;
export declare function cancelNativeOrWebRecording(): Promise<void>;
