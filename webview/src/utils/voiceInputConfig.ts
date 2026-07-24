import { sendBridgeEvent, sendToJava } from './bridge.js';

/**
 * Voice input (speech-to-text) configuration shared between the composer
 * mic button and the settings page.
 *
 * The Java side owns persistence (~/.codemoss config). Because only one
 * `window.updateVoiceInputConfig` slot exists, this module registers the
 * bridge callback exactly once and fans updates out to any number of
 * subscribers (composer + settings page).
 */
export interface VoiceInputConfig {
  /** Master switch for the mic button in the composer */
  enabled: boolean;
  /** OpenAI-compatible API base URL, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** API key for the transcription endpoint */
  apiKey: string;
  /** Transcription model, e.g. whisper-1 / gpt-4o-mini-transcribe */
  model: string;
  /** Optional ISO-639-1 language hint (empty = auto detect) */
  language: string;
}

export const DEFAULT_VOICE_INPUT_CONFIG: VoiceInputConfig = {
  enabled: true,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'whisper-1',
  language: '',
};

type Listener = (config: VoiceInputConfig) => void;

let currentConfig: VoiceInputConfig | null = null;
const listeners = new Set<Listener>();
let bridgeInstalled = false;

function normalizeConfig(raw: Partial<VoiceInputConfig> | null | undefined): VoiceInputConfig {
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_VOICE_INPUT_CONFIG.enabled,
    baseUrl: typeof raw?.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : DEFAULT_VOICE_INPUT_CONFIG.baseUrl,
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : '',
    model: typeof raw?.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_VOICE_INPUT_CONFIG.model,
    language: typeof raw?.language === 'string' ? raw.language.trim() : '',
  };
}

function installBridgeCallback(): void {
  if (bridgeInstalled) {
    return;
  }
  bridgeInstalled = true;

  window.updateVoiceInputConfig = (json: string) => {
    try {
      currentConfig = normalizeConfig(JSON.parse(json));
      listeners.forEach((listener) => {
        try {
          listener(currentConfig as VoiceInputConfig);
        } catch (e) {
          console.error('[voiceInputConfig] listener failed:', e);
        }
      });
    } catch (e) {
      console.error('[voiceInputConfig] failed to parse config payload:', e);
    }
  };

  // Request the persisted config from the Java side. If the bridge is not
  // ready yet the composer/settings page will re-request on mount.
  sendBridgeEvent('get_voice_input_config');
}

/**
 * Subscribe to voice input config updates. Installs the bridge callback on
 * first use and immediately replays the cached config when available.
 * Returns an unsubscribe function.
 */
export function subscribeVoiceInputConfig(listener: Listener): () => void {
  installBridgeCallback();
  listeners.add(listener);
  if (currentConfig) {
    listener(currentConfig);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Re-request the persisted config from the Java side. */
export function refreshVoiceInputConfig(): void {
  installBridgeCallback();
  sendBridgeEvent('get_voice_input_config');
}

/** Latest known config (null until the Java side has replied once). */
export function getVoiceInputConfig(): VoiceInputConfig | null {
  return currentConfig;
}

/**
 * Persist a new config. The Java side writes it and echoes the stored value
 * back through `window.updateVoiceInputConfig`, which updates all subscribers.
 */
export function saveVoiceInputConfig(config: VoiceInputConfig): void {
  sendToJava('set_voice_input_config', config);
}
