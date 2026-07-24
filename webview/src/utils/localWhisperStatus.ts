import { sendBridgeEvent } from './bridge.js';

/**
 * Shared store for the local Whisper install/model/server state.
 *
 * Both the composer (to decide whether the mic button is usable) and the
 * settings page (to render setup state) need this, but there is only one
 * `window.onLocalWhisperStatus` slot — so the bridge callback is registered
 * exactly once here and fanned out to all subscribers.
 */
export interface LocalWhisperStatus {
  /** transformers.js runtime is installed under ~/.codemoss/dependencies */
  installed: boolean;
  /** The configured local model has been downloaded */
  modelReady: boolean;
  /** The transcription server process is currently up */
  serverRunning: boolean;
  /** Model the status refers to */
  localModel: string;
}

type Listener = (status: LocalWhisperStatus) => void;

let currentStatus: LocalWhisperStatus | null = null;
const listeners = new Set<Listener>();
let bridgeInstalled = false;

function normalizeStatus(raw: Partial<LocalWhisperStatus> | null | undefined): LocalWhisperStatus {
  return {
    installed: raw?.installed === true,
    modelReady: raw?.modelReady === true,
    serverRunning: raw?.serverRunning === true,
    localModel: typeof raw?.localModel === 'string' ? raw.localModel : '',
  };
}

function installBridgeCallback(): void {
  if (bridgeInstalled) {
    return;
  }
  bridgeInstalled = true;

  window.onLocalWhisperStatus = (json: string) => {
    try {
      currentStatus = normalizeStatus(JSON.parse(json));
      listeners.forEach((listener) => {
        try {
          listener(currentStatus as LocalWhisperStatus);
        } catch (e) {
          console.error('[localWhisperStatus] listener failed:', e);
        }
      });
    } catch (e) {
      console.error('[localWhisperStatus] failed to parse status payload:', e);
    }
  };
}

/**
 * Subscribe to local Whisper status updates. Installs the bridge callback on
 * first use and immediately replays the cached status when available.
 * Returns an unsubscribe function.
 */
export function subscribeLocalWhisperStatus(listener: Listener): () => void {
  installBridgeCallback();
  listeners.add(listener);
  if (currentStatus) {
    listener(currentStatus);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Ask the Java side for the current status. */
export function refreshLocalWhisperStatus(): void {
  installBridgeCallback();
  sendBridgeEvent('get_local_whisper_status');
}

/** Latest known status (null until the Java side has replied once). */
export function getLocalWhisperStatus(): LocalWhisperStatus | null {
  return currentStatus;
}
