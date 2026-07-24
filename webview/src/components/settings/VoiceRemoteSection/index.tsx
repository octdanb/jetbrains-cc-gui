import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';
import { sendToJava } from '../../../utils/bridge';
import {
  DEFAULT_VOICE_INPUT_CONFIG,
  refreshVoiceInputConfig,
  saveVoiceInputConfig,
  subscribeVoiceInputConfig,
  type VoiceInputConfig,
} from '../../../utils/voiceInputConfig';

interface VoiceRemoteSectionProps {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

/**
 * VoiceRemoteSection - Settings for the two "hands-off" features:
 *
 * 1. Voice Input: speech-to-text prompt dictation (mic button in the composer,
 *    shown in Plan/Agent modes). Audio is recorded on the IDE side and sent to
 *    an OpenAI-compatible transcription endpoint configured here.
 *
 * 2. Remote Control: launches `claude remote-control` in the IDE terminal so
 *    the session can be paired with the Claude mobile app / claude.ai, letting
 *    the user answer permission prompts and questions from their phone.
 */
const VoiceRemoteSection = ({ addToast }: VoiceRemoteSectionProps) => {
  const { t } = useTranslation();

  // ---------------------------------------------------------------- voice
  const [voiceConfig, setVoiceConfig] = useState<VoiceInputConfig>(DEFAULT_VOICE_INPUT_CONFIG);

  useEffect(() => {
    const unsubscribe = subscribeVoiceInputConfig(setVoiceConfig);
    refreshVoiceInputConfig();
    return unsubscribe;
  }, []);

  const updateVoiceField = useCallback(<K extends keyof VoiceInputConfig>(key: K, value: VoiceInputConfig[K]) => {
    setVoiceConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleVoiceSave = useCallback(() => {
    saveVoiceInputConfig(voiceConfig);
    addToast(t('settings.voiceRemote.voice.saved'), 'success');
  }, [voiceConfig, addToast, t]);

  const handleVoiceEnabledChange = useCallback((enabled: boolean) => {
    const next = { ...voiceConfig, enabled };
    setVoiceConfig(next);
    saveVoiceInputConfig(next);
  }, [voiceConfig]);

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
