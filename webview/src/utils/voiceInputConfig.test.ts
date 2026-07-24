import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VOICE_INPUT_CONFIG,
  getVoiceInputConfig,
  subscribeVoiceInputConfig,
} from './voiceInputConfig';

describe('voiceInputConfig', () => {
  it('installs the bridge callback on first subscribe and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVoiceInputConfig(listener);

    expect(typeof window.updateVoiceInputConfig).toBe('function');

    window.updateVoiceInputConfig!(
      JSON.stringify({ enabled: false, mode: 'local', baseUrl: 'https://proxy.example/v1', apiKey: 'k', model: 'whisper-1', language: 'en', localModel: 'Xenova/whisper-small' })
    );

    expect(listener).toHaveBeenCalledWith({
      enabled: false,
      mode: 'local',
      baseUrl: 'https://proxy.example/v1',
      apiKey: 'k',
      model: 'whisper-1',
      language: 'en',
      localModel: 'Xenova/whisper-small',
      localDevice: 'cpu',
    });

    unsubscribe();
  });

  it('normalizes unknown or missing modes to local (the default engine)', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVoiceInputConfig(listener);

    window.updateVoiceInputConfig!(JSON.stringify({ mode: 'weird' }));
    expect(listener.mock.calls[listener.mock.calls.length - 1][0].mode).toBe('local');

    window.updateVoiceInputConfig!(JSON.stringify({}));
    expect(listener.mock.calls[listener.mock.calls.length - 1][0].mode).toBe('local');

    // An explicit cloud choice is still honoured.
    window.updateVoiceInputConfig!(JSON.stringify({ mode: 'cloud' }));
    expect(listener.mock.calls[listener.mock.calls.length - 1][0].mode).toBe('cloud');

    unsubscribe();
  });

  it('normalizes missing fields to defaults', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVoiceInputConfig(listener);

    window.updateVoiceInputConfig!(JSON.stringify({}));

    expect(listener).toHaveBeenLastCalledWith({
      ...DEFAULT_VOICE_INPUT_CONFIG,
    });
    expect(getVoiceInputConfig()).toEqual(DEFAULT_VOICE_INPUT_CONFIG);

    unsubscribe();
  });

  it('replays the cached config to late subscribers and stops after unsubscribe', () => {
    const early = vi.fn();
    const unsubscribeEarly = subscribeVoiceInputConfig(early);
    window.updateVoiceInputConfig!(JSON.stringify({ enabled: true, model: 'gpt-4o-mini-transcribe' }));

    const late = vi.fn();
    const unsubscribeLate = subscribeVoiceInputConfig(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0][0].model).toBe('gpt-4o-mini-transcribe');

    unsubscribeLate();
    const callsBefore = late.mock.calls.length;
    window.updateVoiceInputConfig!(JSON.stringify({ enabled: false }));
    expect(late.mock.calls.length).toBe(callsBefore);

    unsubscribeEarly();
  });

  it('preserves the localDevice choice so a wasm fallback is not reset to cpu', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVoiceInputConfig(listener);

    window.updateVoiceInputConfig!(JSON.stringify({ mode: 'local', localDevice: 'wasm' }));
    expect(listener.mock.calls[listener.mock.calls.length - 1][0].localDevice).toBe('wasm');

    // Unknown/absent values fall back to the native backend.
    window.updateVoiceInputConfig!(JSON.stringify({ mode: 'local', localDevice: 'gpu' }));
    expect(listener.mock.calls[listener.mock.calls.length - 1][0].localDevice).toBe('cpu');
    window.updateVoiceInputConfig!(JSON.stringify({ mode: 'local' }));
    expect(listener.mock.calls[listener.mock.calls.length - 1][0].localDevice).toBe('cpu');

    unsubscribe();
  });

  it('ignores malformed payloads without breaking existing state', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVoiceInputConfig(listener);

    window.updateVoiceInputConfig!(JSON.stringify({ enabled: false }));
    const callsAfterValid = listener.mock.calls.length;

    window.updateVoiceInputConfig!('not-json');
    expect(listener.mock.calls.length).toBe(callsAfterValid);
    expect(getVoiceInputConfig()?.enabled).toBe(false);

    unsubscribe();
  });
});
