import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceInput } from './useVoiceInput';

/** Minimal i18n stub: return the key so assertions stay readable. */
const t = ((key: string) => key) as never;

function pushConfig(overrides: Record<string, unknown> = {}) {
  act(() => {
    window.updateVoiceInputConfig?.(JSON.stringify({
      enabled: true,
      mode: 'local',
      localModel: 'Xenova/whisper-base',
      localDevice: 'cpu',
      liveDictation: true,
      ...overrides,
    }));
  });
}

function pushReadyStatus(model = 'Xenova/whisper-base') {
  act(() => {
    window.onLocalWhisperStatus?.(JSON.stringify({
      installed: true, modelReady: true, serverRunning: false, localModel: model,
    }));
  });
}

function pushRecordingState(state: string, live?: boolean) {
  act(() => {
    window.onVoiceRecordingState?.(JSON.stringify({ state, live }));
  });
}

/**
 * Voice commands only. The config/status stores also send over
 * window.sendToJava (get_voice_input_config, get_local_whisper_status), so a
 * bare "was not called" assertion would be polluted by those refreshes.
 */
function voiceCalls(): string[] {
  const mock = vi.mocked(window.sendToJava!);
  return mock.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.startsWith('voice_record_'));
}

function setup(options: Partial<Parameters<typeof useVoiceInput>[0]> = {}) {
  return renderHook(() => useVoiceInput({
    insertTranscript: options.insertTranscript ?? vi.fn(),
    showPartialTranscript: options.showPartialTranscript,
    commitPartialTranscript: options.commitPartialTranscript,
    discardPartialTranscript: options.discardPartialTranscript,
    addToast: options.addToast,
    t,
  }));
}

describe('useVoiceInput', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('requests plain recording from the record button and live from the dictation button', () => {
    const { result } = setup();
    pushConfig();
    pushReadyStatus();

    act(() => result.current.toggleRecording());
    expect(window.sendToJava).toHaveBeenCalledWith('voice_record_start:{"live":false}');

    vi.mocked(window.sendToJava!).mockClear();
    act(() => result.current.toggleDictation());
    expect(window.sendToJava).toHaveBeenCalledWith('voice_record_start:{"live":true}');
  });

  it('stops only from the button that owns the recording', () => {
    const { result } = setup();
    pushConfig();
    pushReadyStatus();

    // Live dictation is running.
    pushRecordingState('recording', true);
    expect(result.current.activeMode).toBe('dictate');

    vi.mocked(window.sendToJava!).mockClear();
    // The record button must not stop a dictation it does not own...
    act(() => result.current.toggleRecording());
    expect(voiceCalls()).toEqual([]);

    // ...but the dictation button must stop it. This is the regression: with a
    // single toggle there was no visible way to end the recording.
    act(() => result.current.toggleDictation());
    expect(window.sendToJava).toHaveBeenCalledWith('voice_record_stop:');
  });

  it('stops a plain recording from the record button', () => {
    const { result } = setup();
    pushConfig();
    pushReadyStatus();

    pushRecordingState('recording', false);
    expect(result.current.activeMode).toBe('record');

    vi.mocked(window.sendToJava!).mockClear();
    act(() => result.current.toggleDictation());
    expect(voiceCalls()).toEqual([]);

    act(() => result.current.toggleRecording());
    expect(window.sendToJava).toHaveBeenCalledWith('voice_record_stop:');
  });

  it('reflects the backend when a dictation request degrades to plain recording', () => {
    const { result } = setup();
    pushConfig();
    pushReadyStatus();

    // Asked for live, but the backend reports live=false (e.g. cloud engine),
    // so the record button owns the stop control.
    act(() => result.current.toggleDictation());
    pushRecordingState('recording', false);
    expect(result.current.activeMode).toBe('record');
  });

  it('clears the active mode when the recording ends', () => {
    const { result } = setup();
    pushConfig();
    pushReadyStatus();

    pushRecordingState('recording', true);
    expect(result.current.activeMode).toBe('dictate');

    act(() => {
      window.onVoiceTranscript?.(JSON.stringify({ success: true, text: 'hello' }));
    });
    expect(result.current.activeMode).toBeNull();
    expect(result.current.voiceState).toBe('idle');
  });

  it('offers the dictation button only for the local engine with the setting on', () => {
    const { result } = setup();

    pushConfig({ liveDictation: true, mode: 'local' });
    expect(result.current.liveAvailable).toBe(true);

    pushConfig({ liveDictation: false, mode: 'local' });
    expect(result.current.liveAvailable).toBe(false);

    // Cloud endpoints would be billed once per second of speech.
    pushConfig({ liveDictation: true, mode: 'cloud', apiKey: 'k' });
    expect(result.current.liveAvailable).toBe(false);
  });

  it('explains what to set up instead of recording when not ready', () => {
    const addToast = vi.fn();
    const { result } = setup({ addToast });
    pushConfig();
    act(() => {
      window.onLocalWhisperStatus?.(JSON.stringify({
        installed: false, modelReady: false, serverRunning: false, localModel: '',
      }));
    });

    expect(result.current.voiceReady).toBe(false);
    act(() => result.current.toggleRecording());
    expect(voiceCalls()).toEqual([]);
    expect(addToast).toHaveBeenCalledWith('chat.voice.setupRequired', 'warning');
  });

  it('ignores presses while transcribing', () => {
    const { result } = setup();
    pushConfig();
    pushReadyStatus();

    pushRecordingState('transcribing');
    vi.mocked(window.sendToJava!).mockClear();
    act(() => result.current.toggleRecording());
    act(() => result.current.toggleDictation());
    expect(voiceCalls()).toEqual([]);
  });
});
