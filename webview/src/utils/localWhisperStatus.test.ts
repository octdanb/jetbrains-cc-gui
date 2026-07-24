import { describe, expect, it, vi } from 'vitest';
import {
  getLocalWhisperStatus,
  subscribeLocalWhisperStatus,
} from './localWhisperStatus';

describe('localWhisperStatus', () => {
  it('fans one bridge callback out to multiple subscribers', () => {
    const composer = vi.fn();
    const settings = vi.fn();
    const unsubComposer = subscribeLocalWhisperStatus(composer);
    const unsubSettings = subscribeLocalWhisperStatus(settings);

    expect(typeof window.onLocalWhisperStatus).toBe('function');

    window.onLocalWhisperStatus!(
      JSON.stringify({ installed: true, modelReady: true, serverRunning: false, localModel: 'Xenova/whisper-base' })
    );

    const expected = {
      installed: true,
      modelReady: true,
      serverRunning: false,
      localModel: 'Xenova/whisper-base',
    };
    expect(composer).toHaveBeenCalledWith(expected);
    expect(settings).toHaveBeenCalledWith(expected);

    unsubComposer();
    unsubSettings();
  });

  it('coerces missing fields to a not-ready status', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLocalWhisperStatus(listener);

    window.onLocalWhisperStatus!(JSON.stringify({}));

    expect(listener).toHaveBeenLastCalledWith({
      installed: false,
      modelReady: false,
      serverRunning: false,
      localModel: '',
    });

    unsubscribe();
  });

  it('replays cached status to late subscribers and stops after unsubscribe', () => {
    const early = vi.fn();
    const unsubEarly = subscribeLocalWhisperStatus(early);
    window.onLocalWhisperStatus!(
      JSON.stringify({ installed: true, modelReady: false, serverRunning: false, localModel: 'Xenova/whisper-tiny' })
    );

    const late = vi.fn();
    const unsubLate = subscribeLocalWhisperStatus(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0][0].localModel).toBe('Xenova/whisper-tiny');
    expect(getLocalWhisperStatus()?.installed).toBe(true);

    unsubLate();
    const before = late.mock.calls.length;
    window.onLocalWhisperStatus!(JSON.stringify({ installed: false }));
    expect(late.mock.calls.length).toBe(before);

    unsubEarly();
  });

  it('ignores malformed payloads without clobbering state', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLocalWhisperStatus(listener);

    window.onLocalWhisperStatus!(
      JSON.stringify({ installed: true, modelReady: true, serverRunning: true, localModel: 'm' })
    );
    const callsAfterValid = listener.mock.calls.length;

    window.onLocalWhisperStatus!('not-json');
    expect(listener.mock.calls.length).toBe(callsAfterValid);
    expect(getLocalWhisperStatus()?.modelReady).toBe(true);

    unsubscribe();
  });
});
