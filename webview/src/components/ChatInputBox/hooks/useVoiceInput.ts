import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../../../utils/bridge.js';
import {
  subscribeVoiceInputConfig,
  refreshVoiceInputConfig,
} from '../../../utils/voiceInputConfig.js';

export type VoiceRecordingState = 'idle' | 'recording' | 'transcribing';

interface UseVoiceInputOptions {
  /** Insert the transcript into the input box (usually window.insertCodeSnippetAtCursor) */
  insertTranscript: (text: string) => void;
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

interface UseVoiceInputResult {
  /** Current recording state driven by the Java side */
  voiceState: VoiceRecordingState;
  /** Whether voice input is enabled in settings */
  voiceEnabled: boolean;
  /** Start recording / stop-and-transcribe toggle */
  toggleVoiceRecording: () => void;
}

/**
 * useVoiceInput - Speech-to-text prompt dictation.
 *
 * Audio is captured on the Java side (javax.sound.sampled) because JCEF —
 * especially in OSR mode on Linux — does not reliably expose getUserMedia.
 * The webview only drives the lifecycle over the bridge:
 *
 *   voice_record_start / voice_record_stop / voice_record_cancel  (JS -> Java)
 *   window.onVoiceRecordingState({state, error?})                 (Java -> JS)
 *   window.onVoiceTranscript({success, text?, error?})            (Java -> JS)
 */
export function useVoiceInput({
  insertTranscript,
  addToast,
  t,
}: UseVoiceInputOptions): UseVoiceInputResult {
  const [voiceState, setVoiceState] = useState<VoiceRecordingState>('idle');
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  // Keep latest callbacks in refs so the window bridge functions stay stable.
  const insertTranscriptRef = useRef(insertTranscript);
  const addToastRef = useRef(addToast);
  const tRef = useRef(t);
  useEffect(() => {
    insertTranscriptRef.current = insertTranscript;
    addToastRef.current = addToast;
    tRef.current = t;
  }, [insertTranscript, addToast, t]);

  // Track settings state (master toggle).
  useEffect(() => {
    const unsubscribe = subscribeVoiceInputConfig((config) => {
      setVoiceEnabled(config.enabled);
    });
    refreshVoiceInputConfig();
    return unsubscribe;
  }, []);

  // Bridge callbacks from the Java recording/transcription services.
  useEffect(() => {
    window.onVoiceRecordingState = (json: string) => {
      try {
        const payload = JSON.parse(json) as { state?: string; error?: string };
        const state = payload.state;
        if (state === 'recording' || state === 'transcribing' || state === 'idle') {
          setVoiceState(state);
        }
        if (payload.error) {
          addToastRef.current?.(payload.error, 'error');
        }
      } catch (e) {
        console.error('[useVoiceInput] bad recording-state payload:', e);
      }
    };

    window.onVoiceTranscript = (json: string) => {
      setVoiceState('idle');
      try {
        const payload = JSON.parse(json) as { success?: boolean; text?: string; error?: string };
        if (payload.success && payload.text && payload.text.trim()) {
          insertTranscriptRef.current(payload.text.trim());
        } else if (payload.success) {
          addToastRef.current?.(tRef.current('chat.voice.emptyTranscript'), 'warning');
        } else {
          addToastRef.current?.(
            payload.error || tRef.current('chat.voice.transcriptionFailed'),
            'error'
          );
        }
      } catch (e) {
        console.error('[useVoiceInput] bad transcript payload:', e);
      }
    };

    return () => {
      // Cancel any in-flight recording when the composer unmounts so the
      // Java side does not keep the microphone line open.
      sendBridgeEvent('voice_record_cancel');
      delete window.onVoiceRecordingState;
      delete window.onVoiceTranscript;
    };
  }, []);

  const toggleVoiceRecording = useCallback(() => {
    if (voiceState === 'transcribing') {
      return;
    }
    if (voiceState === 'recording') {
      sendBridgeEvent('voice_record_stop');
    } else {
      sendBridgeEvent('voice_record_start');
    }
  }, [voiceState]);

  return { voiceState, voiceEnabled, toggleVoiceRecording };
}
