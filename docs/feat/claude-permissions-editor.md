# Claude Code Permissions Editor

**Settings → Permissions** (Claude provider) manages the `permissions.allow` /
`ask` / `deny` rules Claude Code uses to decide which tools it may run without
asking. Previously this tab showed "coming soon" for Claude and only had a
Codex sandbox selector.

## Scopes

All three user-editable settings files are supported, presented highest
precedence first (Claude Code's own order: local → project → user):

| Scope | File | Meaning |
|---|---|---|
| Local | `<cwd>/.claude/settings.local.json` | Personal rules for this project, kept out of git |
| Project | `<cwd>/.claude/settings.json` | Committed, shared with the team |
| User | `~/.claude/settings.json` | Applies to every project (lowest priority) |

The project/local path is resolved from `HandlerContext.resolveEffectiveWorkingDirectory()`
— **not** the raw project base path — because the effective working directory is
what the CLI actually runs in, and therefore which `.claude/settings.json` it
loads. Using the base path would silently edit the wrong file when a custom
working directory is configured.

When a rule also exists in a higher-priority scope, the UI says so inline, since
the lower-priority copy has no effect.

## Enabling/disabling rules

Claude Code's schema has no representation for a disabled rule — a rule is
either present or absent. Toggling a rule off therefore **removes it from
settings.json** and remembers it in the plugin's own config
(`permissionRuleState.disabled`, keyed by scope and project path), so it can be
switched back on later without retyping. This keeps the settings file clean and
valid for the CLI. The UI states this explicitly rather than implying the file
holds a disabled flag.

## Validation

`PermissionRuleValidator` (Java) and `validatePermissionRule` (TypeScript) are
deliberate mirrors — the webview validates for instant inline feedback, and Java
validates again before writing, since a malformed entry makes the CLI reject the
whole `permissions` block.

**Errors** (block saving): empty rule, unbalanced or multiple parens, empty
`()`, surrounding whitespace, line breaks/tabs, malformed tool name.

**Warnings** (saved as-is, flagged):
- Unknown tool name — likely a typo; names are case sensitive.
- Regex syntax in a `Bash(...)` rule — Bash rules are **prefix** matches, so `^`
  / `$` match literally and `.*` is probably meant to be `:*`.
- MCP rule with a specifier — MCP rules match by name only.
- An `allow` rule for a path the plugin's own safety layer blocks anyway
  (`ai-bridge/permission-safety.js` `isDangerousPath`: `/etc/`, `~/.ssh/`,
  `~/.config/`, …). That check runs *before* settings rules are consulted, so
  such a rule can never take effect — worth saying rather than letting the user
  wonder why it does nothing.

## Why a separate settings writer

`PermissionSettingsManager` intentionally does **not** reuse
`ClaudeSettingsManager.writeClaudeSettings`, which has three properties that are
fine for its own use but wrong here:

1. It force-injects `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` into `env` on
   every write — saving a permission rule should not touch unrelated settings.
2. It writes non-atomically with a plain `FileWriter`, so an interrupted write
   truncates the file.
3. `readClaudeSettings()` swallows parse errors and returns a default object, so
   saving over a hand-edited malformed file would **destroy its contents**.

The new manager instead: strict-reads (a malformed file raises
`MalformedSettingsException`, and the save is refused with an explanatory
message rather than clobbering), writes via a temp file plus `ATOMIC_MOVE` (with
a non-atomic fallback for filesystems that reject it), preserves every unrelated
key — including keys inside `permissions` it was not asked to change, such as
`defaultMode` and `additionalDirectories` — removes empty buckets instead of
leaving `[]` noise, chmods the user settings file to `rw-------` (it can hold
auth tokens), and adds `.claude/settings.local.json` to `.gitignore` on first
create in a git repo, matching CLI behaviour.

## Session applicability

**Saved rules do not affect a conversation that is already running.** The Claude
CLI reads permission settings once, when a session's runtime (subprocess)
starts. Nothing in `buildRuntimeSignature` hashes settings content, and there is
no settings-reload control message, so a live runtime keeps its original rules.

The UI states this up front, and after a save offers an explicit **"Apply to
current session"** action that calls
`ClaudeSDKBridge.resetPersistentRuntime(epoch)` to restart the runtime. That is
an explicit action rather than something done silently on save, because it kills
the CLI subprocess.

Rules also take effect naturally on: a new session, loading a session from
history, starting from a template, a working-directory change, toggling Auto
(bypassPermissions) mode, or once an idle runtime is reaped (30 min idle / 6 h
absolute).

## Message flow

```
get_permission_settings                  -> window.updatePermissionSettings({workingDirectory, hasProject, scopes[], precedence[]})
save_permission_settings {scope, rules}  -> window.permissionSettingsSaved({success, scope, error?, requiresReload})
                                            (then re-pushes updatePermissionSettings with on-disk truth)
validate_permission_rules {rules,bucket} -> window.permissionRulesValidated({results[]})
reload_permissions_session               -> window.permissionSessionReloaded({success, error?})
```

## Key files

| Layer | File |
|---|---|
| Rule validation (Java) | `src/main/java/com/github/claudecodegui/permission/PermissionRuleValidator.java` |
| Settings file I/O | `src/main/java/com/github/claudecodegui/settings/PermissionSettingsManager.java` |
| Disabled-rule sidecar | `CodemossSettingsService.get/setDisabledPermissionRules` |
| Bridge handler | `src/main/java/com/github/claudecodegui/handler/PermissionSettingsHandler.java` |
| Rule validation (TS) | `webview/src/types/permissions.ts` |
| UI | `webview/src/components/settings/PermissionsSection/ClaudePermissionsPanel.tsx` |

Tests: `PermissionRuleValidatorTest` (11), `PermissionSettingsManagerTest` (14,
covering key preservation, malformed-file refusal, atomic-write cleanup and
`.gitignore` handling), `webview/src/types/permissions.test.ts` (11).
