import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import { sendBridgeEvent, sendToJava } from '../../../utils/bridge';
import {
  DEFAULT_VOICE_INPUT_CONFIG,
  refreshVoiceInputConfig,
  saveVoiceInputConfig,
  subscribeVoiceInputConfig,
  type VoiceInputConfig,
  type VoiceInputMode,
} from '../../../utils/voiceInputConfig';

interface VoiceRemoteSectionProps {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

interface LocalWhisperStatus {
  installed: boolean;
  modelReady: boolean;
  serverRunning: boolean;
  localModel: string;
}

/** Local Whisper models runnable via transformers.js (ONNX, q8-quantized). */
const LOCAL_WHISPER_MODELS = [
  { id: 'Xenova/whisper-tiny', label: 'whisper-tiny (~40 MB, fastest)' },
  { id: 'Xenova/whisper-base', label: 'whisper-base (~80 MB, recommended)' },
  { id: 'Xenova/whisper-small', label: 'whisper-small (~250 MB, most accurate)' },
];

/**
 * VoiceRemoteSection - Settings for the two "hands-off" features:
 *
 * 1. Voice Input: speech-to-text prompt dictation (mic button in the composer,
 *    shown in Plan/Agent modes). Two engines: a cloud OpenAI-compatible API,
 *    or a fully local Whisper server (transformers.js + ONNX) that the user
 *    can install with one click — no API key, audio never leaves the machine.
 *
 * 2. Remote Control: launches `claude remote-control` in the IDE terminal so
 *    the session can be paired with the Claude mobile app / claude.ai.
 */
const VoiceRemoteSection = ({ addToast }: VoiceRemoteSectionProps) => {
  const { t } = useTranslation();

  // ---------------------------------------------------------------- voice
  const [voiceConfig, setVoiceConfig] = useState<VoiceInputConfig>(DEFAULT_VOICE_INPUT_CONFIG);
  const [whisperStatus, setWhisperStatus] = useState<LocalWhisperStatus | null>(null);
  const [setupRunning, setSetupRunning] = useState(false);
  const [setupProgress, setSetupProgress] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeVoiceInputConfig(setVoiceConfig);
    refreshVoiceInputConfig();
    return unsubscribe;
  }, []);

  // Local Whisper status + setup progress callbacks (this section is the only consumer).
  useEffect(() => {
    window.onLocalWhisperStatus = (json: string) => {
      try {
        setWhisperStatus(JSON.parse(json) as LocalWhisperStatus);
      } catch {
        // ignore malformed payloads
      }
    };
    window.onLocalWhisperSetupProgress = (json: string) => {
      try {
        const payload = JSON.parse(json) as { phase?: string; message?: string };
        if (payload.message) {
          setSetupProgress(payload.message);
        }
      } catch {
        // ignore malformed payloads
      }
    };
    window.onLocalWhisperSetupResult = (json: string) => {
      setSetupRunning(false);
      setSetupProgress(null);
      try {
        const payload = JSON.parse(json) as { success?: boolean; error?: string };
        if (payload.success) {
          addToast(t('settings.voiceRemote.voice.setupSuccess'), 'success');
        } else {
          addToast(payload.error || t('settings.voiceRemote.voice.setupFailed'), 'error');
        }
      } catch {
        addToast(t('settings.voiceRemote.voice.setupFailed'), 'error');
      }
      sendBridgeEvent('get_local_whisper_status');
    };

    sendBridgeEvent('get_local_whisper_status');

    return () => {
      delete window.onLocalWhisperStatus;
      delete window.onLocalWhisperSetupProgress;
      delete window.onLocalWhisperSetupResult;
    };
  }, [addToast, t]);

  const updateVoiceField = useCallback(<K extends keyof VoiceInputConfig>(key: K, value: VoiceInputConfig[K]) => {
    setVoiceConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const persistVoiceConfig = useCallback((next: VoiceInputConfig) => {
    setVoiceConfig(next);
    saveVoiceInputConfig(next);
  }, []);

  const handleVoiceSave = useCallback(() => {
    saveVoiceInputConfig(voiceConfig);
    addToast(t('settings.voiceRemote.voice.saved'), 'success');
  }, [voiceConfig, addToast, t]);

  const handleVoiceEnabledChange = useCallback((enabled: boolean) => {
    persistVoiceConfig({ ...voiceConfig, enabled });
  }, [voiceConfig, persistVoiceConfig]);

  const handleModeChange = useCallback((mode: VoiceInputMode) => {
    persistVoiceConfig({ ...voiceConfig, mode });
  }, [voiceConfig, persistVoiceConfig]);

  const handleLocalModelChange = useCallback((localModel: string) => {
    persistVoiceConfig({ ...voiceConfig, localModel });
    // Model readiness depends on the selection — refresh the status line.
    setTimeout(() => sendBridgeEvent('get_local_whisper_status'), 300);
  }, [voiceConfig, persistVoiceConfig]);

  const handleSetupLocalWhisper = useCallback(() => {
    setSetupRunning(true);
    setSetupProgress(t('settings.voiceRemote.voice.setupStarting'));
    sendToJava('setup_local_whisper', { model: voiceConfig.localModel });
  }, [voiceConfig.localModel, t]);

  const localReady = !!whisperStatus?.installed
    && !!whisperStatus?.modelReady
    && whisperStatus?.localModel === voiceConfig.localModel;

  const localStatusText = !whisperStatus
    ? t('settings.voiceRemote.voice.statusChecking')
    : !whisperStatus.installed
      ? t('settings.voiceRemote.voice.statusNotInstalled')
      : localReady
        ? (whisperStatus.serverRunning
          ? t('settings.voiceRemote.voice.statusRunning')
          : t('settings.voiceRemote.voice.statusReady'))
        : t('settings.voiceRemote.voice.statusModelMissing');

  // --------------------------------------------------------------- remote
  const [continueSession, setContinueSession] = useState(false);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    window.onRemoteControlLaunched = (json: string) => {
      setLaunching(false);
      try {
        const payload = JSON.parse(json) as { success?: boolean; error?: string };
        if (payload.success) {
          addToast(t('settings.voiceRemote.remote.launched'), 'success');
        } else {
          addToast(payload.error || t('settings.voiceRemote.remote.launchFailed'), 'error');
        }
      } catch {
        addToast(t('settings.voiceRemote.remote.launchFailed'), 'error');
      }
    };
    return () => {
      delete window.onRemoteControlLaunched;
    };
  }, [addToast, t]);

  const handleLaunchRemoteControl = useCallback(() => {
    setLaunching(true);
    sendToJava('remote_control_launch', { continueSession });
    // Safety net: never leave the button stuck if the bridge drops the reply.
    setTimeout(() => setLaunching(false), 15000);
  }, [continueSession]);

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{t('settings.voiceRemote.title')}</h3>
      <p className={styles.sectionDesc}>{t('settings.voiceRemote.description')}</p>

      {/* Voice input (speech-to-text) */}
      <div className={styles.card}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-mic" />
          <span className={styles.fieldLabel}>{t('settings.voiceRemote.voice.label')}</span>
        </div>

        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={voiceConfig.enabled}
            onChange={(e) => handleVoiceEnabledChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {voiceConfig.enabled
              ? t('settings.voiceRemote.voice.enabled')
              : t('settings.voiceRemote.voice.disabled')}
          </span>
        </label>

        {/* Engine selector */}
        <div className={styles.formRow}>
          <label className={styles.formLabel}>{t('settings.voiceRemote.voice.engine')}</label>
          <div className={styles.radioRow}>
            <label className={styles.radioOption}>
              <input
                type="radio"
                name="voice-engine"
                checked={voiceConfig.mode === 'local'}
                onChange={() => handleModeChange('local')}
              />
              <span>{t('settings.voiceRemote.voice.engineLocal')}</span>
            </label>
            <label className={styles.radioOption}>
              <input
                type="radio"
                name="voice-engine"
                checked={voiceConfig.mode === 'cloud'}
                onChange={() => handleModeChange('cloud')}
              />
              <span>{t('settings.voiceRemote.voice.engineCloud')}</span>
            </label>
          </div>
        </div>

        {voiceConfig.mode === 'local' ? (
          <>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>{t('settings.voiceRemote.voice.localModel')}</label>
              <select
                className={styles.formInput}
                value={voiceConfig.localModel}
                disabled={setupRunning}
                onChange={(e) => handleLocalModelChange(e.target.value)}
              >
                {LOCAL_WHISPER_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
                {!LOCAL_WHISPER_MODELS.some((m) => m.id === voiceConfig.localModel) && (
                  <option value={voiceConfig.localModel}>{voiceConfig.localModel}</option>
                )}
              </select>
            </div>

            <div className={styles.statusRow}>
              <span className={`codicon ${localReady ? 'codicon-pass-filled' : 'codicon-circle-large-outline'}`} />
              <span>{localStatusText}</span>
            </div>

            <div className={styles.buttonRow}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={handleSetupLocalWhisper}
                disabled={setupRunning}
              >
                <span className={`codicon ${setupRunning ? 'codicon-loading codicon-modifier-spin' : 'codicon-cloud-download'}`} />
                <span>
                  {localReady
                    ? t('settings.voiceRemote.voice.setupAgain')
                    : t('settings.voiceRemote.voice.setup')}
                </span>
              </button>
            </div>

            {setupRunning && setupProgress && (
              <div className={styles.progressLine}>{setupProgress}</div>
            )}

            <small className={styles.formHint}>
              <span className="codicon codicon-info" />
              <span>{t('settings.voiceRemote.voice.localHint')}</span>
            </small>
          </>
        ) : (
          <>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>{t('settings.voiceRemote.voice.baseUrl')}</label>
              <input
                type="text"
                className={styles.formInput}
                value={voiceConfig.baseUrl}
                placeholder={DEFAULT_VOICE_INPUT_CONFIG.baseUrl}
                onChange={(e) => updateVoiceField('baseUrl', e.target.value)}
              />
            </div>

            <div className={styles.formRow}>
              <label className={styles.formLabel}>{t('settings.voiceRemote.voice.apiKey')}</label>
              <input
                type="password"
                className={styles.formInput}
                value={voiceConfig.apiKey}
                placeholder="sk-..."
                autoComplete="off"
                onChange={(e) => updateVoiceField('apiKey', e.target.value)}
              />
            </div>

            <div className={styles.formRow}>
              <label className={styles.formLabel}>{t('settings.voiceRemote.voice.model')}</label>
              <input
                type="text"
                className={styles.formInput}
                value={voiceConfig.model}
                placeholder={DEFAULT_VOICE_INPUT_CONFIG.model}
                onChange={(e) => updateVoiceField('model', e.target.value)}
              />
            </div>

            <div className={styles.formRow}>
              <label className={styles.formLabel}>{t('settings.voiceRemote.voice.language')}</label>
              <input
                type="text"
                className={styles.formInput}
                value={voiceConfig.language}
                placeholder={t('settings.voiceRemote.voice.languagePlaceholder')}
                onChange={(e) => updateVoiceField('language', e.target.value)}
              />
            </div>

            <small className={styles.formHint}>
              <span className="codicon codicon-info" />
              <span>{t('settings.voiceRemote.voice.hint')}</span>
            </small>

            <div className={styles.buttonRow}>
              <button type="button" className={styles.primaryButton} onClick={handleVoiceSave}>
                <span className="codicon codicon-save" />
                <span>{t('common.save')}</span>
              </button>
            </div>
          </>
        )}
      </div>

      {/* Remote Control */}
      <div className={styles.card}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-broadcast" />
          <span className={styles.fieldLabel}>{t('settings.voiceRemote.remote.label')}</span>
        </div>

        <p className={styles.sectionDesc} style={{ marginBottom: 8 }}>
          {t('settings.voiceRemote.remote.description')}
        </p>

        <div className={styles.noteBox}>
          <span className="codicon codicon-warning" />
          <span>{t('settings.voiceRemote.remote.note')}</span>
        </div>

        <label className={styles.checkboxWrapper}>
          <input
            type="checkbox"
            checked={continueSession}
            onChange={(e) => setContinueSession(e.target.checked)}
          />
          <span>{t('settings.voiceRemote.remote.continueSession')}</span>
        </label>

        <div className={styles.buttonRow}>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={handleLaunchRemoteControl}
            disabled={launching}
          >
            <span className={`codicon ${launching ? 'codicon-loading codicon-modifier-spin' : 'codicon-broadcast'}`} />
            <span>{t('settings.voiceRemote.remote.launch')}</span>
          </button>
        </div>

        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.voiceRemote.remote.hint')}</span>
        </small>
      </div>
    </div>
  );
};

export default VoiceRemoteSection;
