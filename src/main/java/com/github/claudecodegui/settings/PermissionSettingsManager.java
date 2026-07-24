package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads and writes the {@code permissions} block of Claude Code settings files
 * across the three user-editable scopes:
 *
 * <ul>
 *   <li>{@code user} — {@code ~/.claude/settings.json}</li>
 *   <li>{@code project} — {@code <cwd>/.claude/settings.json} (committed)</li>
 *   <li>{@code local} — {@code <cwd>/.claude/settings.local.json} (git-ignored)</li>
 * </ul>
 *
 * <p>Deliberately does <em>not</em> reuse {@link ClaudeSettingsManager}: that
 * class force-injects {@code CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC} into
 * {@code env} on every write, writes non-atomically, and silently substitutes a
 * default object when a file fails to parse — which would destroy a
 * hand-edited settings file the moment the user saved a permission rule. Here a
 * malformed file surfaces as an error instead, writes go through a temp file
 * plus atomic move, and every unrelated key is preserved via deep copy.</p>
 */
public class PermissionSettingsManager {

    private static final Logger LOG = Logger.getInstance(PermissionSettingsManager.class);

    public static final String SCOPE_USER = "user";
    public static final String SCOPE_PROJECT = "project";
    public static final String SCOPE_LOCAL = "local";

    private static final String PERMISSIONS_KEY = "permissions";
    private static final List<String> RULE_BUCKETS = List.of("allow", "ask", "deny");
    /** Refuse to parse absurdly large settings files rather than hanging the IDE. */
    private static final long MAX_SETTINGS_BYTES = 5L * 1024 * 1024;

    private final Gson gson;

    public PermissionSettingsManager() {
        this.gson = new GsonBuilder().setPrettyPrinting().create();
    }

    /** Thrown when a settings file exists but cannot be parsed. */
    public static class MalformedSettingsException extends IOException {
        private final Path path;

        public MalformedSettingsException(Path path, String message) {
            super(message);
            this.path = path;
        }

        public Path getPath() {
            return path;
        }
    }

    /**
     * Resolve the settings file for a scope.
     *
     * @param scope one of {@link #SCOPE_USER}, {@link #SCOPE_PROJECT}, {@link #SCOPE_LOCAL}
     * @param workingDirectory the effective working directory (the directory Claude
     *                         runs in — this is what determines which project
     *                         settings file the CLI actually loads)
     */
    public Path resolveSettingsPath(String scope, String workingDirectory) {
        switch (scope) {
            case SCOPE_USER:
                return Paths.get(PlatformUtils.getHomeDirectory(), ".claude", "settings.json");
            case SCOPE_PROJECT:
                requireWorkingDirectory(workingDirectory, scope);
                return Paths.get(workingDirectory, ".claude", "settings.json");
            case SCOPE_LOCAL:
                requireWorkingDirectory(workingDirectory, scope);
                return Paths.get(workingDirectory, ".claude", "settings.local.json");
            default:
                throw new IllegalArgumentException("Unknown settings scope: " + scope);
        }
    }

    private static void requireWorkingDirectory(String workingDirectory, String scope) {
        if (workingDirectory == null || workingDirectory.isBlank()) {
            throw new IllegalArgumentException("No project directory available for scope " + scope);
        }
    }

    /**
     * Read the whole settings object for a scope.
     *
     * @return the parsed object, or an empty object when the file does not exist
     * @throws MalformedSettingsException when the file exists but is not a JSON object
     */
    public JsonObject readSettings(String scope, String workingDirectory) throws IOException {
        Path path = resolveSettingsPath(scope, workingDirectory);
        if (!Files.exists(path)) {
            return new JsonObject();
        }
        if (Files.size(path) > MAX_SETTINGS_BYTES) {
            throw new MalformedSettingsException(path,
                    "Settings file is unexpectedly large (" + Files.size(path) + " bytes)");
        }

        try (Reader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            JsonElement parsed = JsonParser.parseReader(reader);
            if (parsed == null || parsed.isJsonNull()) {
                return new JsonObject();
            }
            if (!parsed.isJsonObject()) {
                throw new MalformedSettingsException(path, "Settings file root is not a JSON object");
            }
            return parsed.getAsJsonObject();
        } catch (JsonSyntaxException | IllegalStateException e) {
            throw new MalformedSettingsException(path, "Settings file is not valid JSON: " + e.getMessage());
        }
    }

    /**
     * Read just the permission rules for a scope.
     *
     * @return {allow: [...], ask: [...], deny: [...], defaultMode?, additionalDirectories?,
     *         disableBypassPermissionsMode?}
     */
    public JsonObject readPermissions(String scope, String workingDirectory) throws IOException {
        JsonObject settings = readSettings(scope, workingDirectory);
        JsonObject result = new JsonObject();

        JsonObject permissions = settings.has(PERMISSIONS_KEY) && settings.get(PERMISSIONS_KEY).isJsonObject()
                ? settings.getAsJsonObject(PERMISSIONS_KEY)
                : new JsonObject();

        for (String bucket : RULE_BUCKETS) {
            result.add(bucket, readStringArray(permissions, bucket));
        }
        result.add("additionalDirectories", readStringArray(permissions, "additionalDirectories"));

        if (permissions.has("defaultMode") && permissions.get("defaultMode").isJsonPrimitive()) {
            result.addProperty("defaultMode", permissions.get("defaultMode").getAsString());
        }
        if (permissions.has("disableBypassPermissionsMode")
                && permissions.get("disableBypassPermissionsMode").isJsonPrimitive()) {
            result.addProperty("disableBypassPermissionsMode",
                    permissions.get("disableBypassPermissionsMode").getAsString());
        }
        return result;
    }

    private static JsonArray readStringArray(JsonObject parent, String key) {
        JsonArray out = new JsonArray();
        if (parent.has(key) && parent.get(key).isJsonArray()) {
            for (JsonElement element : parent.getAsJsonArray(key)) {
                if (element.isJsonPrimitive()) {
                    out.add(element.getAsString());
                }
            }
        }
        return out;
    }

    /**
     * Write permission rules into a scope, preserving every other key in the
     * file (and every other key inside {@code permissions}).
     *
     * <p>Empty rule arrays are removed rather than written as {@code []}, and a
     * {@code permissions} object left with no content is removed entirely, so
     * the file does not accumulate noise.</p>
     *
     * @param permissions {allow, ask, deny, additionalDirectories?, defaultMode?,
     *                    disableBypassPermissionsMode?}
     */
    public void writePermissions(String scope, String workingDirectory, JsonObject permissions)
            throws IOException {
        Path path = resolveSettingsPath(scope, workingDirectory);
        // Strict read first: refuse to clobber a file we could not parse.
        JsonObject existing = readSettings(scope, workingDirectory);
        JsonObject updated = existing.deepCopy();

        JsonObject target = updated.has(PERMISSIONS_KEY) && updated.get(PERMISSIONS_KEY).isJsonObject()
                ? updated.getAsJsonObject(PERMISSIONS_KEY).deepCopy()
                : new JsonObject();

        for (String bucket : RULE_BUCKETS) {
            applyArray(target, bucket, permissions);
        }
        applyArray(target, "additionalDirectories", permissions);
        applyScalar(target, "defaultMode", permissions);
        applyScalar(target, "disableBypassPermissionsMode", permissions);

        if (target.size() == 0) {
            updated.remove(PERMISSIONS_KEY);
        } else {
            updated.add(PERMISSIONS_KEY, target);
        }

        writeAtomically(path, updated, SCOPE_USER.equals(scope));

        if (SCOPE_LOCAL.equals(scope)) {
            ensureLocalSettingsIgnored(workingDirectory);
        }
        LOG.info("[PermissionSettings] Saved permissions to " + path);
    }

    private static void applyArray(JsonObject target, String key, JsonObject source) {
        if (!source.has(key)) {
            return;
        }
        JsonArray values = readStringArray(source, key);
        if (values.size() == 0) {
            target.remove(key);
        } else {
            target.add(key, values);
        }
    }

    private static void applyScalar(JsonObject target, String key, JsonObject source) {
        if (!source.has(key)) {
            return;
        }
        JsonElement value = source.get(key);
        if (value.isJsonNull()) {
            target.remove(key);
            return;
        }
        String text = value.getAsString();
        if (text.isBlank()) {
            target.remove(key);
        } else {
            target.addProperty(key, text);
        }
    }

    /**
     * Write via a temp file in the same directory plus an atomic move, so an
     * interrupted write can never leave a truncated settings file behind.
     *
     * @param restrictPermissions tighten to owner-only (the user settings file
     *                            can contain auth tokens)
     */
    private void writeAtomically(Path path, JsonObject content, boolean restrictPermissions)
            throws IOException {
        Path parent = path.getParent();
        if (parent != null && !Files.exists(parent)) {
            Files.createDirectories(parent);
        }

        Path tempFile = Files.createTempFile(parent, ".settings-", ".tmp");
        try {
            Files.writeString(tempFile, gson.toJson(content) + "\n", StandardCharsets.UTF_8);
            if (restrictPermissions) {
                hardenFilePermissions(tempFile);
            }
            try {
                Files.move(tempFile, path,
                        StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (java.nio.file.AtomicMoveNotSupportedException e) {
                // Some Windows/network filesystems reject ATOMIC_MOVE.
                Files.move(tempFile, path, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(tempFile);
        }
    }

    private static void hardenFilePermissions(Path path) {
        if (PlatformUtils.isWindows()) {
            return;
        }
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        } catch (IOException | UnsupportedOperationException e) {
            LOG.debug("[PermissionSettings] Could not restrict permissions on " + path);
        }
    }

    /**
     * Add {@code .claude/settings.local.json} to the project's {@code .gitignore}
     * when it is not already ignored — the Claude CLI does the same on first
     * create, and this file is explicitly meant to stay out of source control.
     */
    private void ensureLocalSettingsIgnored(String workingDirectory) {
        try {
            Path gitDir = Paths.get(workingDirectory, ".git");
            if (!Files.isDirectory(gitDir)) {
                return;
            }
            Path gitignore = Paths.get(workingDirectory, ".gitignore");
            String entry = ".claude/settings.local.json";

            if (Files.exists(gitignore)) {
                List<String> lines = Files.readAllLines(gitignore, StandardCharsets.UTF_8);
                for (String line : lines) {
                    String trimmed = line.trim();
                    if (entry.equals(trimmed) || ".claude/".equals(trimmed) || ".claude".equals(trimmed)) {
                        return;
                    }
                }
                List<String> updated = new ArrayList<>(lines);
                if (!updated.isEmpty() && !updated.get(updated.size() - 1).isBlank()) {
                    updated.add("");
                }
                updated.add(entry);
                Files.write(gitignore, updated, StandardCharsets.UTF_8);
            } else {
                Files.writeString(gitignore, entry + "\n", StandardCharsets.UTF_8);
            }
            LOG.info("[PermissionSettings] Added " + entry + " to .gitignore");
        } catch (IOException e) {
            // Non-fatal: the settings were already saved successfully.
            LOG.warn("[PermissionSettings] Could not update .gitignore: " + e.getMessage());
        }
    }
}
