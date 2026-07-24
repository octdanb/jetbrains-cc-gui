import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../../../utils/bridge.js';
import {
  subscribeVoiceInputConfig,
  refreshVoiceInputConfig,
  DEFAULT_VOICE_INPUT_CONFIG,
  type VoiceInputConfig,
} from '../../../utils/voiceInputConfig.js';
import {
  subscribeLocalWhisperStatus,
  refreshLocalWhisperStatus,
  type LocalWhisperStatus,
} from '../../../utils/localWhisperStatus.js';

export type VoiceRecordingState = 'idle' | 'recording' | 'transcribing';

interface UseVoiceInputOptions {
  /** Insert the transcript into the input box (usually window.insertCodeSnippetAtCursor) */
  insertTranscript: (text: string) => void;
  /**
   * Show/replace live partial text in place while speaking. Returns true when
   * the partial was rendered, so the final transcript knows to replace it
   * rather than append a second copy.
   */
  showPartialTranscript?: (text: string) => boolean;
  /**
   * Commit the live partial to plain text. Returns true when a partial existed
   * and was replaced (so the caller should not also insert the transcript).
   */
  commitPartialTranscript?: (text: string) => boolean;
  /** Drop any live partial without committing it. */
  discardPartialTranscript?: () => void;
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

interface UseVoiceInputResult {
  /** Current recording state driven by the Java side */
  voiceState: VoiceRecordingState;
  /** Whether voice input is enabled in settings */
  voiceEnabled: boolean;
  /**
   * Whether dictation can actually run: local mode needs the runtime and model
   * installed, cloud mode needs an API key. When false the mic button is shown
   * in a disabled state that explains what to set up.
   */
  voiceReady: boolean;
  /** Localized reason the mic is unavailable (null when ready) */
  voiceUnavailableReason: string | null;
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
  showPartialTranscript,
  commitPartialTranscript,
  discardPartialTranscript,
  addToast,
  t,
}: UseVoiceInputOptions): UseVoiceInputResult {
  const [voiceState, setVoiceState] = useState<VoiceRecordingState>('idle');
  const [config, setConfig] = useState<VoiceInputConfig>(DEFAULT_VOICE_INPUT_CONFIG);
  const [whisperStatus, setWhisperStatus] = useState<LocalWhisperStatus | null>(null);

  // Keep latest callbacks in refs so the window bridge functions stay stable.
  const insertTranscriptRef = useRef(insertTranscript);
  const showPartialRef = useRef(showPartialTranscript);
  const commitPartialRef = useRef(commitPartialTranscript);
  const discardPartialRef = useRef(discardPartialTranscript);
  const addToastRef = useRef(addToast);
  const tRef = useRef(t);
  useEffect(() => {
    insertTranscriptRef.current = insertTranscript;
    showPartialRef.current = showPartialTranscript;
    commitPartialRef.current = commitPartialTranscript;
    discardPartialRef.current = discardPartialTranscript;
    addToastRef.current = addToast;
    tRef.current = t;
  }, [insertTranscript, showPartialTranscript, commitPartialTranscript, discardPartialTranscript, addToast, t]);

  /** True while a live partial is showing, so the final transcript replaces it. */
  const hasPartialRef = useRef(false);

  // Track settings state (master toggle, engine mode, credentials).
  useEffect(() => {
    const unsubscribe = subscribeVoiceInputConfig(setConfig);
    refreshVoiceInputConfig();
    return unsubscribe;
  }, []);

  // Track local Whisper setup state so the mic can explain what is missing.
  useEffect(() => {
    const unsubscribe = subscribeLocalWhisperStatus(setWhisperStatus);
    refreshLocalWhisperStatus();
    return unsubscribe;
  }, []);

  // Re-check local readiness whenever the selected local model changes
  // (a model that has not been downloaded yet must not look ready).
  useEffect(() => {
    if (config.mode === 'local') {
      refreshLocalWhisperStatus();
    }
  }, [config.mode, config.localModel]);

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

    // Live dictation: replace the in-place partial as new text arrives.
    window.onVoicePartialTranscript = (json: string) => {
      try {
        const payload = JSON.parse(json) as { text?: string };
        const text = payload.text?.trim();
        if (!text) {
          return;
        }
        if (showPartialRef.current?.(text)) {
          hasPartialRef.current = true;
        }
      } catch (e) {
        console.error('[useVoiceInput] bad partial payload:', e);
      }
    };

    window.onVoiceTranscript = (json: string) => {
      setVoiceState('idle');
      try {
        const payload = JSON.parse(json) as { success?: boolean; text?: string; error?: string };
        const finalText = payload.text?.trim() ?? '';
        const hadPartial = hasPartialRef.current;
        hasPartialRef.current = false;

        if (payload.success && finalText) {
          // Prefer replacing the live partial in place; only fall back to a
          // fresh insertion when there was no partial to replace (live mode
          // off, or the user deleted it mid-dictation).
          const replaced = hadPartial && commitPartialRef.current?.(finalText);
          if (!replaced) {
            discardPartialRef.current?.();
            insertTranscriptRef.current(finalText);
          }
        } else if (payload.success) {
          discardPartialRef.current?.();
          addToastRef.current?.(tRef.current('chat.voice.emptyTranscript'), 'warning');
        } else {
          discardPartialRef.current?.();
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
      hasPartialRef.current = false;
      delete window.onVoiceRecordingState;
      delete window.onVoicePartialTranscript;
      delete window.onVoiceTranscript;
    };
  }, []);

  // Readiness: what (if anything) the user still has to set up.
  let voiceUnavailableReason: string | null = null;
  if (config.mode === 'local') {
    if (!whisperStatus) {
      // Status not back yet — assume usable rather than flashing a warning.
      voiceUnavailableReason = null;
    } else if (!whisperStatus.installed) {
      voiceUnavailableReason = t('chat.voice.setupRequired');
    } else if (!whisperStatus.modelReady || whisperStatus.localModel !== config.localModel) {
      voiceUnavailableReason = t('chat.voice.modelRequired');
    }
  } else if (!config.apiKey.trim()) {
    voiceUnavailableReason = t('chat.voice.apiKeyRequired');
  }

  const voiceReady = voiceUnavailableReason === null;

  const toggleVoiceRecording = useCallback(() => {
    if (voiceState === 'transcribing') {
      return;
    }
    // Not set up yet: explain instead of starting a recording that will fail
    // after the user has already spoken.
    if (voiceUnavailableReason) {
      addToastRef.current?.(voiceUnavailableReason, 'warning');
      return;
    }
    if (voiceState === 'recording') {
      sendBridgeEvent('voice_record_stop');
    } else {
      sendBridgeEvent('voice_record_start');
    }
  }, [voiceState, voiceUnavailableReason]);

  return {
    voiceState,
    voiceEnabled: config.enabled,
    voiceReady,
    voiceUnavailableReason,
    toggleVoiceRecording,
  };
}
