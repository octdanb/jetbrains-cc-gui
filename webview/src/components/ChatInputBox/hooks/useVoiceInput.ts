import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent, sendToJava } from '../../../utils/bridge.js';
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
/** Which button owns the current recording. */
export type VoiceActiveMode = 'record' | 'dictate' | null;

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
  /** Which of the two buttons started the active recording (null when idle) */
  activeMode: VoiceActiveMode;
  /** Whether voice input is enabled in settings */
  voiceEnabled: boolean;
  /**
   * Whether the separate live-dictation button should be offered: it needs the
   * setting on and the local engine (each live pass is a full transcription
   * request, so it is not offered against a paid cloud endpoint).
   */
  liveAvailable: boolean;
  /**
   * Whether dictation can actually run: local mode needs the runtime and model
   * installed, cloud mode needs an API key. When false the mic button is shown
   * in a disabled state that explains what to set up.
   */
  voiceReady: boolean;
  /** Localized reason the mic is unavailable (null when ready) */
  voiceUnavailableReason: string | null;
  /** Toggle plain recording: transcribes once when stopped */
  toggleRecording: () => void;
  /** Toggle live dictation: streams text into the box while speaking */
  toggleDictation: () => void;
}

/**
 * useVoiceInput - Speech-to-text prompt dictation.
 *
 * Audio is captured on the Java side (javax.sound.sampled) because JCEF —
 * especially in OSR mode on Linux — does not reliably expose getUserMedia.
 * The webview only drives the lifecycle over the bridge:
 *
 *   voice_record_start {live} / voice_record_stop / voice_record_cancel (JS -> Java)
 *   window.onVoiceRecordingState({state, live, error?})           (Java -> JS)
 *   window.onVoicePartialTranscript({text})                       (Java -> JS)
 *   window.onVoiceTranscript({success, text?, error?})            (Java -> JS)
 *
 * The composer exposes two buttons — Record (transcribe once on stop) and
 * Dictation (live partials) — so the mode is requested explicitly and echoed
 * back in the recording state, letting each button show its own stop control.
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
  const [activeMode, setActiveMode] = useState<VoiceActiveMode>(null);
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
        const payload = JSON.parse(json) as { state?: string; live?: boolean; error?: string };
        const state = payload.state;
        if (state === 'recording' || state === 'transcribing' || state === 'idle') {
          setVoiceState(state);
          if (state === 'recording') {
            // Trust the backend about whether live passes actually started: a
            // dictation request silently degrades to plain recording when the
            // local engine is not in use.
            setActiveMode(payload.live ? 'dictate' : 'record');
          } else if (state === 'idle') {
            setActiveMode(null);
          }
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
      setActiveMode(null);
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

  // Live dictation is only offered with the local engine: each pass is a full
  // transcription request, which would bill a cloud endpoint per second of speech.
  const liveAvailable = config.liveDictation && config.mode === 'local';

  /**
   * Shared toggle for both buttons. `mode` identifies the caller, so pressing
   * the button that owns the active recording stops it, while pressing the
   * other one is ignored (you cannot record two ways at once).
   */
  const toggle = useCallback((mode: Exclude<VoiceActiveMode, null>) => {
    if (voiceState === 'transcribing') {
      return;
    }
    if (voiceState === 'recording') {
      if (activeMode === mode) {
        sendBridgeEvent('voice_record_stop');
      }
      return;
    }
    // Not set up yet: explain instead of starting a recording that will fail
    // after the user has already spoken.
    if (voiceUnavailableReason) {
      addToastRef.current?.(voiceUnavailableReason, 'warning');
      return;
    }
    sendToJava('voice_record_start', { live: mode === 'dictate' });
  }, [voiceState, activeMode, voiceUnavailableReason]);

  const toggleRecording = useCallback(() => toggle('record'), [toggle]);
  const toggleDictation = useCallback(() => toggle('dictate'), [toggle]);

  return {
    voiceState,
    activeMode,
    voiceEnabled: config.enabled,
    liveAvailable,
    voiceReady,
    voiceUnavailableReason,
    toggleRecording,
    toggleDictation,
  };
}
