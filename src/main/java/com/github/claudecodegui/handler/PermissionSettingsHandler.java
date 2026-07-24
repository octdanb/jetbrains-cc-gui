package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.permission.PermissionRuleValidator;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.PermissionSettingsManager;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Manages Claude Code permission rules ({@code permissions.allow} / {@code ask}
 * / {@code deny}) in the user, project and local settings files.
 *
 * <pre>
 * get_permission_settings                 -> window.updatePermissionSettings({scopes:[...], ...})
 * save_permission_settings {scope, ...}   -> window.permissionSettingsSaved({success, scope, ...})
 * validate_permission_rules {rules:[...]} -> window.permissionRulesValidated({results:[...]})
 * reload_permissions_session              -> window.permissionSessionReloaded({success})
 * </pre>
 *
 * <p>Rules the user switches off are removed from the settings file and
 * remembered in the plugin's own config, because Claude Code's schema has no
 * notion of a disabled rule. This keeps the settings file valid for the CLI
 * while still letting a rule be parked instead of deleted.</p>
 */
public class PermissionSettingsHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(PermissionSettingsHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "get_permission_settings",
        "save_permission_settings",
        "validate_permission_rules",
        "reload_permissions_session"
    };

    private static final List<String> BUCKETS = List.of("allow", "ask", "deny");
    private static final List<String> SCOPES = List.of(
            PermissionSettingsManager.SCOPE_USER,
            PermissionSettingsManager.SCOPE_PROJECT,
            PermissionSettingsManager.SCOPE_LOCAL);

    private final Gson gson = new Gson();
    private final PermissionSettingsManager settingsManager = new PermissionSettingsManager();

    public PermissionSettingsHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_permission_settings":
                handleGet();
                return true;
            case "save_permission_settings":
                handleSave(content);
                return true;
            case "validate_permission_rules":
                handleValidate(content);
                return true;
            case "reload_permissions_session":
                handleReloadSession();
                return true;
            default:
                return false;
        }
    }

    /**
     * Scope identity for the disabled-rule sidecar. Project and local scopes are
     * per-directory; the user scope is global.
     */
    static String buildStorageKey(String scope, String workingDirectory) {
        if (PermissionSettingsManager.SCOPE_USER.equals(scope)) {
            return scope;
        }
        return scope + "@" + (workingDirectory == null ? "" : workingDirectory);
    }

    private void handleGet() {
        CompletableFuture.runAsync(() -> {
            JsonObject payload = new JsonObject();
            String workingDirectory = context.resolveEffectiveWorkingDirectory();
            payload.addProperty("workingDirectory", workingDirectory == null ? "" : workingDirectory);
            payload.addProperty("hasProject", workingDirectory != null && !workingDirectory.isBlank());

            JsonArray scopes = new JsonArray();
            for (String scope : SCOPES) {
                scopes.add(buildScopePayload(scope, workingDirectory));
            }
            payload.add("scopes", scopes);

            // Precedence is fixed by Claude Code: local overrides project overrides user.
            payload.add("precedence", gson.toJsonTree(List.of("local", "project", "user")));

            pushJson("window.updatePermissionSettings", payload);
        });
    }

    private JsonObject buildScopePayload(String scope, String workingDirectory) {
        JsonObject scopePayload = new JsonObject();
        scopePayload.addProperty("scope", scope);

        boolean applicable = !PermissionSettingsManager.SCOPE_USER.equals(scope)
                ? workingDirectory != null && !workingDirectory.isBlank()
                : true;
        scopePayload.addProperty("applicable", applicable);

        if (!applicable) {
            scopePayload.addProperty("path", "");
            scopePayload.addProperty("exists", false);
            scopePayload.add("rules", new JsonObject());
            return scopePayload;
        }

        try {
            Path path = settingsManager.resolveSettingsPath(scope, workingDirectory);
            scopePayload.addProperty("path", path.toString());
            scopePayload.addProperty("exists", Files.exists(path));

            JsonObject filePermissions = settingsManager.readPermissions(scope, workingDirectory);
            JsonObject disabled = context.getSettingsService()
                    .getDisabledPermissionRules(buildStorageKey(scope, workingDirectory));

            JsonObject rules = new JsonObject();
            for (String bucket : BUCKETS) {
                rules.add(bucket, mergeRules(
                        filePermissions.getAsJsonArray(bucket),
                        disabled.getAsJsonArray(bucket),
                        bucket));
            }
            scopePayload.add("rules", rules);

            if (filePermissions.has("defaultMode")) {
                scopePayload.add("defaultMode", filePermissions.get("defaultMode"));
            }
            if (filePermissions.has("additionalDirectories")) {
                scopePayload.add("additionalDirectories", filePermissions.get("additionalDirectories"));
            }
            if (filePermissions.has("disableBypassPermissionsMode")) {
                scopePayload.add("disableBypassPermissionsMode",
                        filePermissions.get("disableBypassPermissionsMode"));
            }
        } catch (PermissionSettingsManager.MalformedSettingsException e) {
            // Surface rather than silently replacing the file's contents.
            scopePayload.addProperty("error", e.getMessage());
            scopePayload.add("rules", emptyRules());
            LOG.warn("[PermissionSettings] " + e.getMessage());
        } catch (Exception e) {
            scopePayload.addProperty("error", "Could not read settings: " + e.getMessage());
            scopePayload.add("rules", emptyRules());
            LOG.warn("[PermissionSettings] Failed to read " + scope + " scope: " + e.getMessage());
        }
        return scopePayload;
    }

    private static JsonObject emptyRules() {
        JsonObject rules = new JsonObject();
        for (String bucket : BUCKETS) {
            rules.add(bucket, new JsonArray());
        }
        return rules;
    }

    /**
     * Combine the rules present in the file (enabled) with the remembered
     * disabled ones, annotating each with validation findings so the UI can flag
     * problems in rules that already exist on disk.
     */
    private JsonArray mergeRules(JsonArray enabled, JsonArray disabled, String bucket) {
        JsonArray out = new JsonArray();
        Set<String> seen = new LinkedHashSet<>();

        if (enabled != null) {
            for (JsonElement element : enabled) {
                String rule = element.getAsString();
                if (seen.add(PermissionRuleValidator.normalizeForComparison(rule))) {
                    out.add(describeRule(rule, true, bucket));
                }
            }
        }
        if (disabled != null) {
            for (JsonElement element : disabled) {
                String rule = element.getAsString();
                if (seen.add(PermissionRuleValidator.normalizeForComparison(rule))) {
                    out.add(describeRule(rule, false, bucket));
                }
            }
        }
        return out;
    }

    private JsonObject describeRule(String rule, boolean enabled, String bucket) {
        JsonObject entry = new JsonObject();
        entry.addProperty("rule", rule);
        entry.addProperty("enabled", enabled);
        entry.add("findings", describeFindings(rule, bucket));
        return entry;
    }

    private JsonArray describeFindings(String rule, String bucket) {
        JsonArray findings = new JsonArray();
        for (PermissionRuleValidator.Finding finding : PermissionRuleValidator.validate(rule, bucket)) {
            JsonObject item = new JsonObject();
            item.addProperty("severity",
                    finding.getSeverity() == PermissionRuleValidator.Severity.ERROR ? "error" : "warning");
            item.addProperty("message", finding.getMessage());
            findings.add(item);
        }
        return findings;
    }

    /**
     * Save one scope. Payload:
     * {scope, rules: {allow: [{rule, enabled}], ask: [...], deny: [...]},
     *  defaultMode?, additionalDirectories?}
     */
    private void handleSave(String content) {
        CompletableFuture.runAsync(() -> {
            JsonObject result = new JsonObject();
            String scope = null;
            try {
                JsonObject payload = gson.fromJson(content, JsonObject.class);
                scope = payload.get("scope").getAsString();
                result.addProperty("scope", scope);

                if (!SCOPES.contains(scope)) {
                    throw new IllegalArgumentException("Unknown scope: " + scope);
                }

                String workingDirectory = context.resolveEffectiveWorkingDirectory();
                JsonObject rules = payload.has("rules") && payload.get("rules").isJsonObject()
                        ? payload.getAsJsonObject("rules")
                        : new JsonObject();

                JsonObject toFile = new JsonObject();
                JsonObject toDisable = new JsonObject();
                List<String> rejected = new ArrayList<>();

                for (String bucket : BUCKETS) {
                    JsonArray enabledRules = new JsonArray();
                    JsonArray disabledRules = new JsonArray();
                    Set<String> seen = new LinkedHashSet<>();

                    if (rules.has(bucket) && rules.get(bucket).isJsonArray()) {
                        for (JsonElement element : rules.getAsJsonArray(bucket)) {
                            if (!element.isJsonObject()) {
                                continue;
                            }
                            JsonObject entry = element.getAsJsonObject();
                            String rule = entry.has("rule") ? entry.get("rule").getAsString() : "";
                            String normalized = PermissionRuleValidator.normalizeForComparison(rule);
                            if (normalized.isEmpty() || !seen.add(normalized)) {
                                continue;
                            }
                            // Never write a malformed rule into settings.json —
                            // the CLI would reject the whole permissions block.
                            if (!PermissionRuleValidator.isSavable(normalized, bucket)) {
                                rejected.add(normalized);
                                continue;
                            }
                            boolean isEnabled = !entry.has("enabled")
                                    || entry.get("enabled").getAsBoolean();
                            if (isEnabled) {
                                enabledRules.add(normalized);
                            } else {
                                disabledRules.add(normalized);
                            }
                        }
                    }
                    toFile.add(bucket, enabledRules);
                    toDisable.add(bucket, disabledRules);
                }

                if (!rejected.isEmpty()) {
                    throw new IllegalArgumentException(
                            "Fix these invalid rules before saving: " + String.join(", ", rejected));
                }

                if (payload.has("defaultMode")) {
                    toFile.add("defaultMode", payload.get("defaultMode"));
                }
                if (payload.has("additionalDirectories")) {
                    toFile.add("additionalDirectories", payload.get("additionalDirectories"));
                }

                settingsManager.writePermissions(scope, workingDirectory, toFile);
                context.getSettingsService()
                        .setDisabledPermissionRules(buildStorageKey(scope, workingDirectory), toDisable);

                result.addProperty("success", true);
                // Saved rules are read by the CLI when a session's runtime starts,
                // so an in-flight conversation keeps the old rules.
                result.addProperty("requiresReload", true);
                LOG.info("[PermissionSettings] Saved " + scope + " scope permissions");
            } catch (PermissionSettingsManager.MalformedSettingsException e) {
                result.addProperty("success", false);
                result.addProperty("error", "Not saved — " + e.getMessage()
                        + ". Fix the file by hand first so your existing settings are not lost.");
                LOG.warn("[PermissionSettings] Refused to overwrite malformed settings: " + e.getMessage());
            } catch (Exception e) {
                result.addProperty("success", false);
                result.addProperty("error", e.getMessage() == null ? "Save failed" : e.getMessage());
                LOG.warn("[PermissionSettings] Save failed: " + e.getMessage());
            }

            pushJson("window.permissionSettingsSaved", result);
            // Re-push authoritative state so the UI reflects what is on disk.
            handleGet();
        });
    }

    /** Validate a batch of rule strings without saving. */
    private void handleValidate(String content) {
        CompletableFuture.runAsync(() -> {
            JsonObject response = new JsonObject();
            JsonArray results = new JsonArray();
            try {
                JsonObject payload = gson.fromJson(content, JsonObject.class);
                String bucket = payload.has("bucket") ? payload.get("bucket").getAsString() : "allow";
                JsonArray rules = payload.has("rules") && payload.get("rules").isJsonArray()
                        ? payload.getAsJsonArray("rules")
                        : new JsonArray();

                for (JsonElement element : rules) {
                    String rule = element.isJsonPrimitive() ? element.getAsString() : "";
                    JsonObject item = new JsonObject();
                    item.addProperty("rule", rule);
                    item.add("findings", describeFindings(rule, bucket));
                    results.add(item);
                }
            } catch (Exception e) {
                LOG.warn("[PermissionSettings] Validation request failed: " + e.getMessage());
            }
            response.add("results", results);
            pushJson("window.permissionRulesValidated", response);
        });
    }

    /**
     * Restart the current session's Claude runtime so freshly saved rules are
     * read. This kills the CLI subprocess, so it is an explicit user action
     * rather than something done silently on save.
     */
    private void handleReloadSession() {
        CompletableFuture.runAsync(() -> {
            JsonObject result = new JsonObject();
            try {
                ClaudeSession session = context.getSession();
                String epoch = session != null ? session.getRuntimeSessionEpoch() : null;
                context.getClaudeSDKBridge().resetPersistentRuntime(epoch);
                result.addProperty("success", true);
                LOG.info("[PermissionSettings] Reset Claude runtime so new permission rules apply");
            } catch (Exception e) {
                result.addProperty("success", false);
                result.addProperty("error", e.getMessage() == null ? "Reload failed" : e.getMessage());
                LOG.warn("[PermissionSettings] Runtime reset failed: " + e.getMessage());
            }
            pushJson("window.permissionSessionReloaded", result);
        });
    }

    private void pushJson(String jsFunction, JsonObject payload) {
        String json = gson.toJson(payload);
        ApplicationManager.getApplication().invokeLater(() ->
                callJavaScript(jsFunction, escapeJs(json)));
    }
}
