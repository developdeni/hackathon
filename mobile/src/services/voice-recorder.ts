export interface VoiceRecordingResult {
  audioBase64: string;
  mimeType: string;
}

export interface MicrophonePermissionResult {
  granted: boolean;
  canAskAgain: boolean;
  status: 'granted' | 'denied' | 'undetermined';
}

export declare function checkMicrophonePermission(): Promise<MicrophonePermissionResult>;
export declare function startNativeOrWebRecording(): Promise<void>;
export declare function stopNativeOrWebRecording(): Promise<VoiceRecordingResult | null>;
export declare function cancelNativeOrWebRecording(): Promise<void>;
