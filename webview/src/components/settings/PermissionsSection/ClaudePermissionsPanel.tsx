import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './claudePermissions.module.less';
import { sendBridgeEvent, sendToJava } from '../../../utils/bridge';
import {
  PERMISSION_BUCKETS,
  findOverridingScopes,
  hasBlockingError,
  normalizeRule,
  validatePermissionRule,
  type PermissionBucket,
  type PermissionRule,
  type PermissionScope,
  type PermissionScopeState,
  type PermissionSettingsPayload,
} from '../../../types/permissions';

interface ClaudePermissionsPanelProps {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

/** Draft state per scope, so edits survive tab switches until saved. */
type DraftRules = Record<PermissionBucket, PermissionRule[]>;

const emptyDraft = (): DraftRules => ({ allow: [], ask: [], deny: [] });

const BUCKET_ICON: Record<PermissionBucket, string> = {
  allow: 'codicon-pass',
  ask: 'codicon-question',
  deny: 'codicon-circle-slash',
};

/**
 * Editor for Claude Code permission rules across the user, project and local
 * settings files.
 *
 * Design notes:
 * - Rules are edited as a draft and written only on Save, because a half-typed
 *   rule must never reach settings.json (the CLI rejects the whole permissions
 *   block if one entry is malformed).
 * - Disabling a rule removes it from the file but remembers it plugin-side, so
 *   a rule can be parked without being retyped later.
 * - Saved rules do not affect the running conversation: the CLI reads settings
 *   when a session's runtime starts. That is stated in the UI, with an explicit
 *   action to restart the runtime.
 */
const ClaudePermissionsPanel = ({ addToast }: ClaudePermissionsPanelProps) => {
  const { t } = useTranslation();

  const [payload, setPayload] = useState<PermissionSettingsPayload | null>(null);
  const [activeScope, setActiveScope] = useState<PermissionScope>('project');
  const [drafts, setDrafts] = useState<Partial<Record<PermissionScope, DraftRules>>>({});
  const [dirtyScopes, setDirtyScopes] = useState<Set<PermissionScope>>(new Set());
  const [saving, setSaving] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [newRule, setNewRule] = useState<Record<PermissionBucket, string>>({
    allow: '', ask: '', deny: '',
  });

  const addToastRef = useRef(addToast);
  const tRef = useRef(t);
  useEffect(() => {
    addToastRef.current = addToast;
    tRef.current = t;
  }, [addToast, t]);

  // Mirror of dirtyScopes for the (deliberately stable) bridge callbacks below.
  const dirtyScopesRef = useRef(dirtyScopes);
  useEffect(() => {
    dirtyScopesRef.current = dirtyScopes;
  }, [dirtyScopes]);

  // Bridge callbacks.
  useEffect(() => {
    window.updatePermissionSettings = (json: string) => {
      try {
        const next = JSON.parse(json) as PermissionSettingsPayload;
        setPayload(next);
        // Reset drafts to what is actually on disk; scopes still dirty would be
        // stale after a save or external change.
        setDrafts((prev) => {
          const preserved: Partial<Record<PermissionScope, DraftRules>> = {};
          next.scopes.forEach((scope) => {
            if (dirtyScopesRef.current.has(scope.scope) && prev[scope.scope]) {
              preserved[scope.scope] = prev[scope.scope];
            }
          });
          return preserved;
        });
        if (!next.hasProject) {
          setActiveScope('user');
        }
      } catch (e) {
        console.error('[ClaudePermissionsPanel] bad settings payload:', e);
      }
    };

    window.permissionSettingsSaved = (json: string) => {
      setSaving(false);
      try {
        const result = JSON.parse(json) as {
          success?: boolean; scope?: PermissionScope; error?: string; requiresReload?: boolean;
        };
        if (result.success) {
          addToastRef.current?.(tRef.current('settings.claudePermissions.saved'), 'success');
          if (result.scope) {
            setDirtyScopes((prev) => {
              const next = new Set(prev);
              next.delete(result.scope!);
              return next;
            });
            setDrafts((prev) => {
              const next = { ...prev };
              delete next[result.scope!];
              return next;
            });
          }
          if (result.requiresReload) {
            setNeedsReload(true);
          }
        } else {
          addToastRef.current?.(result.error || tRef.current('settings.claudePermissions.saveFailed'), 'error');
        }
      } catch {
        addToastRef.current?.(tRef.current('settings.claudePermissions.saveFailed'), 'error');
      }
    };

    window.permissionSessionReloaded = (json: string) => {
      try {
        const result = JSON.parse(json) as { success?: boolean; error?: string };
        if (result.success) {
          setNeedsReload(false);
          addToastRef.current?.(tRef.current('settings.claudePermissions.reloaded'), 'success');
        } else {
          addToastRef.current?.(result.error || tRef.current('settings.claudePermissions.reloadFailed'), 'error');
        }
      } catch {
        addToastRef.current?.(tRef.current('settings.claudePermissions.reloadFailed'), 'error');
      }
    };

    sendBridgeEvent('get_permission_settings');

    return () => {
      delete window.updatePermissionSettings;
      delete window.permissionSettingsSaved;
      delete window.permissionSessionReloaded;
    };
  }, []);

  const scopeState: PermissionScopeState | undefined = useMemo(
    () => payload?.scopes.find((scope) => scope.scope === activeScope),
    [payload, activeScope],
  );

  /** Draft for the active scope, falling back to what is on disk. */
  const activeRules: DraftRules = useMemo(() => {
    const draft = drafts[activeScope];
    if (draft) {
      return draft;
    }
    if (!scopeState) {
      return emptyDraft();
    }
    return {
      allow: scopeState.rules?.allow ?? [],
      ask: scopeState.rules?.ask ?? [],
      deny: scopeState.rules?.deny ?? [],
    };
  }, [drafts, activeScope, scopeState]);

  const mutateRules = useCallback((mutate: (rules: DraftRules) => DraftRules) => {
    setDrafts((prev) => ({ ...prev, [activeScope]: mutate(activeRules) }));
    setDirtyScopes((prev) => new Set(prev).add(activeScope));
  }, [activeScope, activeRules]);

  const handleAddRule = useCallback((bucket: PermissionBucket) => {
    const raw = newRule[bucket].trim();
    if (!raw) {
      return;
    }
    const findings = validatePermissionRule(raw, bucket);
    if (hasBlockingError(findings)) {
      addToast(findings.find((f) => f.severity === 'error')!.message, 'error');
      return;
    }
    const exists = activeRules[bucket].some((entry) => normalizeRule(entry.rule) === normalizeRule(raw));
    if (exists) {
      addToast(t('settings.claudePermissions.duplicate'), 'warning');
      return;
    }
    mutateRules((rules) => ({
      ...rules,
      [bucket]: [...rules[bucket], { rule: raw, enabled: true, findings }],
    }));
    setNewRule((prev) => ({ ...prev, [bucket]: '' }));
  }, [newRule, activeRules, mutateRules, addToast, t]);

  const handleToggleRule = useCallback((bucket: PermissionBucket, index: number) => {
    mutateRules((rules) => ({
      ...rules,
      [bucket]: rules[bucket].map((entry, i) =>
        i === index ? { ...entry, enabled: !entry.enabled } : entry),
    }));
  }, [mutateRules]);

  const handleDeleteRule = useCallback((bucket: PermissionBucket, index: number) => {
    mutateRules((rules) => ({
      ...rules,
      [bucket]: rules[bucket].filter((_, i) => i !== index),
    }));
  }, [mutateRules]);

  const handleEditRule = useCallback((bucket: PermissionBucket, index: number, value: string) => {
    mutateRules((rules) => ({
      ...rules,
      [bucket]: rules[bucket].map((entry, i) =>
        i === index
          ? { ...entry, rule: value, findings: validatePermissionRule(value.trim(), bucket) }
          : entry),
    }));
  }, [mutateRules]);

  const invalidCount = useMemo(
    () => PERMISSION_BUCKETS.reduce(
      (total, bucket) => total + activeRules[bucket].filter(
        (entry) => hasBlockingError(entry.findings ?? validatePermissionRule(entry.rule, bucket)),
      ).length,
      0,
    ),
    [activeRules],
  );

  const isDirty = dirtyScopes.has(activeScope);

  const handleSave = useCallback(() => {
    if (invalidCount > 0) {
      addToast(t('settings.claudePermissions.fixErrorsFirst'), 'error');
      return;
    }
    setSaving(true);
    sendToJava('save_permission_settings', {
      scope: activeScope,
      rules: {
        allow: activeRules.allow.map(({ rule, enabled }) => ({ rule: rule.trim(), enabled })),
        ask: activeRules.ask.map(({ rule, enabled }) => ({ rule: rule.trim(), enabled })),
        deny: activeRules.deny.map(({ rule, enabled }) => ({ rule: rule.trim(), enabled })),
      },
    });
    // Safety net so the button never sticks if the bridge drops the reply.
    setTimeout(() => setSaving(false), 15000);
  }, [activeScope, activeRules, invalidCount, addToast, t]);

  const handleRevert = useCallback(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[activeScope];
      return next;
    });
    setDirtyScopes((prev) => {
      const next = new Set(prev);
      next.delete(activeScope);
      return next;
    });
  }, [activeScope]);

  const scopeLabel = (scope: PermissionScope) => t(`settings.claudePermissions.scope.${scope}`);

  return (
    <div className={styles.panel}>
      <h3 className={styles.sectionTitle}>{t('settings.claudePermissions.title')}</h3>
      <p className={styles.sectionDesc}>{t('settings.claudePermissions.description')}</p>

      {/* Session-applies notice: rules are read when a session runtime starts. */}
      <div className={needsReload ? styles.noticeActive : styles.notice}>
        <span className="codicon codicon-info" />
        <div className={styles.noticeBody}>
          <span>
            {needsReload
              ? t('settings.claudePermissions.reloadNeeded')
              : t('settings.claudePermissions.sessionNotice')}
          </span>
          {needsReload && (
            <button
              type="button"
              className={styles.reloadButton}
              onClick={() => sendBridgeEvent('reload_permissions_session')}
            >
              <span className="codicon codicon-debug-restart" />
              <span>{t('settings.claudePermissions.reloadAction')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Scope tabs, highest precedence first */}
      <div className={styles.scopeTabs}>
        {(payload?.precedence ?? ['local', 'project', 'user']).map((scope) => {
          const state = payload?.scopes.find((entry) => entry.scope === scope);
          const disabled = state ? !state.applicable : false;
          return (
            <button
              key={scope}
              type="button"
              className={`${styles.scopeTab} ${activeScope === scope ? styles.scopeTabActive : ''}`}
              onClick={() => !disabled && setActiveScope(scope)}
              disabled={disabled}
              title={disabled ? t('settings.claudePermissions.noProject') : state?.path}
            >
              <span>{scopeLabel(scope)}</span>
              {dirtyScopes.has(scope) && <span className={styles.dirtyDot} aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      {scopeState && (
        <div className={styles.scopeMeta}>
          <code className={styles.scopePath}>{scopeState.path || '—'}</code>
          <span className={styles.scopeHint}>
            {scopeState.exists
              ? t('settings.claudePermissions.fileExists')
              : t('settings.claudePermissions.fileWillBeCreated')}
          </span>
        </div>
      )}
      <p className={styles.scopeExplain}>{t(`settings.claudePermissions.scopeDesc.${activeScope}`)}</p>

      {scopeState?.error && (
        <div className={styles.errorBox}>
          <span className="codicon codicon-error" />
          <span>{scopeState.error}</span>
        </div>
      )}

      {/* Rule buckets */}
      {PERMISSION_BUCKETS.map((bucket) => (
        <div key={bucket} className={styles.bucket}>
          <div className={styles.bucketHeader}>
            <span className={`codicon ${BUCKET_ICON[bucket]}`} />
            <span className={styles.bucketTitle}>{t(`settings.claudePermissions.bucket.${bucket}`)}</span>
            <span className={styles.bucketCount}>{activeRules[bucket].length}</span>
          </div>
          <p className={styles.bucketDesc}>{t(`settings.claudePermissions.bucketDesc.${bucket}`)}</p>

          {activeRules[bucket].length === 0 ? (
            <div className={styles.emptyState}>{t('settings.claudePermissions.noRules')}</div>
          ) : (
            <ul className={styles.ruleList}>
              {activeRules[bucket].map((entry, index) => {
                const findings = entry.findings ?? validatePermissionRule(entry.rule, bucket);
                const errored = hasBlockingError(findings);
                const overriddenBy = entry.enabled
                  ? findOverridingScopes(entry.rule, activeScope, payload)
                  : [];
                return (
                  <li
                    key={`${bucket}-${index}`}
                    className={`${styles.ruleItem} ${entry.enabled ? '' : styles.ruleDisabled}`}
                  >
                    <label className={styles.ruleToggle} title={t('settings.claudePermissions.toggleHint')}>
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={() => handleToggleRule(bucket, index)}
                      />
                    </label>
                    <input
                      type="text"
                      className={`${styles.ruleInput} ${errored ? styles.ruleInputError : ''}`}
                      value={entry.rule}
                      spellCheck={false}
                      onChange={(e) => handleEditRule(bucket, index, e.target.value)}
                    />
                    <button
                      type="button"
                      className={styles.deleteButton}
                      onClick={() => handleDeleteRule(bucket, index)}
                      title={t('common.delete')}
                    >
                      <span className="codicon codicon-trash" />
                    </button>
                    {findings.length > 0 && (
                      <div className={styles.findings}>
                        {findings.map((finding, findingIndex) => (
                          <div
                            key={findingIndex}
                            className={finding.severity === 'error' ? styles.findingError : styles.findingWarning}
                          >
                            <span className={`codicon ${finding.severity === 'error' ? 'codicon-error' : 'codicon-warning'}`} />
                            <span>{finding.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {overriddenBy.length > 0 && (
                      <div className={styles.findings}>
                        <div className={styles.findingWarning}>
                          <span className="codicon codicon-arrow-up" />
                          <span>
                            {t('settings.claudePermissions.overriddenBy', {
                              scopes: overriddenBy.map(scopeLabel).join(', '),
                            })}
                          </span>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className={styles.addRow}>
            <input
              type="text"
              className={styles.ruleInput}
              value={newRule[bucket]}
              placeholder={t(`settings.claudePermissions.placeholder.${bucket}`)}
              spellCheck={false}
              onChange={(e) => setNewRule((prev) => ({ ...prev, [bucket]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddRule(bucket);
                }
              }}
            />
            <button
              type="button"
              className={styles.addButton}
              onClick={() => handleAddRule(bucket)}
              disabled={!newRule[bucket].trim()}
            >
              <span className="codicon codicon-add" />
              <span>{t('settings.claudePermissions.addRule')}</span>
            </button>
          </div>
        </div>
      ))}

      {/* Save bar */}
      <div className={styles.saveBar}>
        {isDirty && (
          <span className={styles.unsavedLabel}>
            <span className="codicon codicon-circle-filled" />
            <span>{t('settings.claudePermissions.unsaved')}</span>
          </span>
        )}
        {invalidCount > 0 && (
          <span className={styles.invalidLabel}>
            {t('settings.claudePermissions.invalidCount', { count: invalidCount })}
          </span>
        )}
        <div className={styles.saveBarSpacer} />
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={handleRevert}
          disabled={!isDirty || saving}
        >
          {t('settings.claudePermissions.revert')}
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={handleSave}
          disabled={!isDirty || saving || invalidCount > 0}
        >
          <span className={`codicon ${saving ? 'codicon-loading codicon-modifier-spin' : 'codicon-save'}`} />
          <span>{t('common.save')}</span>
        </button>
      </div>

      <small className={styles.footNote}>
        <span className="codicon codicon-info" />
        <span>{t('settings.claudePermissions.disabledRuleNote')}</span>
      </small>
    </div>
  );
};

export default ClaudePermissionsPanel;
