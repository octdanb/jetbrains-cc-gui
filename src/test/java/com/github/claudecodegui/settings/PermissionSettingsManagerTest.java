package com.github.claudecodegui.settings;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Covers the behaviour that makes this manager safe to point at a user's
 * hand-maintained settings.json: unrelated keys survive, malformed files are
 * refused rather than replaced, and empty collections are cleaned up.
 */
public class PermissionSettingsManagerTest {

    private PermissionSettingsManager manager;
    private Path projectDir;

    @Before
    public void setUp() throws IOException {
        manager = new PermissionSettingsManager();
        projectDir = Files.createTempDirectory("cc-gui-perm-test");
    }

    @After
    public void tearDown() throws IOException {
        if (projectDir != null && Files.exists(projectDir)) {
            try (Stream<Path> paths = Files.walk(projectDir)) {
                paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (IOException ignored) {
                        // best effort cleanup
                    }
                });
            }
        }
    }

    private Path projectSettingsPath() {
        return projectDir.resolve(".claude").resolve("settings.json");
    }

    private void writeProjectSettings(String json) throws IOException {
        Path path = projectSettingsPath();
        Files.createDirectories(path.getParent());
        Files.writeString(path, json, StandardCharsets.UTF_8);
    }

    private JsonObject readRawProjectSettings() throws IOException {
        return JsonParser.parseString(
                Files.readString(projectSettingsPath(), StandardCharsets.UTF_8)).getAsJsonObject();
    }

    private static JsonObject rules(String[] allow, String[] ask, String[] deny) {
        JsonObject permissions = new JsonObject();
        permissions.add("allow", toArray(allow));
        permissions.add("ask", toArray(ask));
        permissions.add("deny", toArray(deny));
        return permissions;
    }

    private static JsonArray toArray(String[] values) {
        JsonArray array = new JsonArray();
        for (String value : values) {
            array.add(value);
        }
        return array;
    }

    @Test
    public void readsEmptyPermissionsWhenFileMissing() throws IOException {
        JsonObject permissions = manager.readPermissions(
                PermissionSettingsManager.SCOPE_PROJECT, projectDir.toString());
        assertEquals(0, permissions.getAsJsonArray("allow").size());
        assertEquals(0, permissions.getAsJsonArray("ask").size());
        assertEquals(0, permissions.getAsJsonArray("deny").size());
    }

    @Test
    public void readsExistingRules() throws IOException {
        writeProjectSettings("{\"permissions\":{\"allow\":[\"Bash(ls)\"],\"deny\":[\"Read(./.env)\"]}}");

        JsonObject permissions = manager.readPermissions(
                PermissionSettingsManager.SCOPE_PROJECT, projectDir.toString());
        assertEquals(1, permissions.getAsJsonArray("allow").size());
        assertEquals("Bash(ls)", permissions.getAsJsonArray("allow").get(0).getAsString());
        assertEquals("Read(./.env)", permissions.getAsJsonArray("deny").get(0).getAsString());
        assertEquals(0, permissions.getAsJsonArray("ask").size());
    }

    @Test
    public void preservesUnrelatedTopLevelAndPermissionKeys() throws IOException {
        writeProjectSettings("{"
                + "\"env\":{\"FOO\":\"bar\"},"
                + "\"hooks\":{\"PreToolUse\":[]},"
                + "\"permissions\":{\"allow\":[\"Bash(old)\"],\"defaultMode\":\"acceptEdits\","
                + "\"additionalDirectories\":[\"../docs/\"]}"
                + "}");

        manager.writePermissions(PermissionSettingsManager.SCOPE_PROJECT, projectDir.toString(),
                rules(new String[]{"Bash(new)"}, new String[]{}, new String[]{}));

        JsonObject saved = readRawProjectSettings();
        // Unrelated top-level keys survive.
        assertEquals("bar", saved.getAsJsonObject("env").get("FOO").getAsString());
        assertTrue(saved.has("hooks"));

        JsonObject permissions = saved.getAsJsonObject("permissions");
        assertEquals("Bash(new)", permissions.getAsJsonArray("allow").get(0).getAsString());
        // Keys inside permissions that we were not asked to change survive too.
        assertEquals("acceptEdits", permissions.get("defaultMode").getAsString());
        assertEquals("../docs/", permissions.getAsJsonArray("additionalDirectories").get(0).getAsString());
    }

    @Test
    public void removesEmptyBucketsAndEmptyPermissionsObject() throws IOException {
        writeProjectSettings("{\"permissions\":{\"allow\":[\"Bash(ls)\"]},\"env\":{}}");

        manager.writePermissions(PermissionSettingsManager.SCOPE_PROJECT, projectDir.toString(),
                rules(new String[]{}, new String[]{}, new String[]{}));

        JsonObject saved = readRawProjectSettings();
        // No empty "permissions": {} or "allow": [] noise left behind.
        assertFalse("empty permissions object should be removed", saved.has("permissions"));
        assertTrue("unrelated keys still preserved", saved.has("env"));
    }

    @Test
    public void createsClaudeDirectoryWhenMissing() throws IOException {
        assertFalse(Files.exists(projectDir.resolve(".claude")));

        manager.writePermissions(PermissionSettingsManager.SCOPE_PROJECT, projectDir.toString(),
                rules(new String[]{"Bash(ls)"}, new String[]{}, new String[]{}));

        assertTrue(Files.exists(projectSettingsPath()));
        assertEquals("Bash(ls)",
                readRawProjectSettings().getAsJsonObject("permissions")
                        .getAsJsonArray("allow").get(0).getAsString());
    }

    @Test
    public void refusesToOverwriteMalformedSettings() throws IOException {
        String original = "{ this is not valid json";
        writeProjectSettings(original);

        try {
            manager.writePermissions(PermissionSettingsManager.SCOPE_PROJECT, projectDir.toString(),
                    rules(new String[]{"Bash(ls)"}, new String[]{}, new String[]{}));
            fail("expected MalformedSettingsException instead of clobbering the file");
        } catch (PermissionSettingsManager.MalformedSettingsException expected) {
            // The user's file must be exactly as it was.
            assertEquals(original, Files.readString(projectSettingsPath(), StandardCharsets.UTF_8));
        }
    }

    @Test
    public void reportsMalformedSettingsOnRead() throws IOException {
        writeProjectSettings("[\"an array, not an object\"]");
        try {
            manager.readPermissions(PermissionSettingsManager.SCOPE_PROJECT, projectDir.toString());
            fail("expected MalformedSettingsException for a non-object root");
        } catch (PermissionSettingsManager.MalformedSettingsException expected) {
            assertTrue(expected.getMessage().contains("not a JSON object"));
        }
    }

    @Test
    public void ignoresNonStringRuleEntries() throws IOException {
        writeProjectSettings("{\"permissions\":{\"allow\":[\"Bash(ls)\", 42, null, {\"a\":1}]}}");

        JsonObject permissions = manager.readPermissions(
                PermissionSettingsManager.SCOPE_PROJECT, projectDir.toString());
        // 42 is a JSON primitive so it is read as "42"; the object and null are skipped.
        JsonArray allow = permissions.getAsJsonArray("allow");
        assertEquals(2, allow.size());
        assertEquals("Bash(ls)", allow.get(0).getAsString());
    }

    @Test
    public void resolvesDistinctPathsPerScope() {
        Path project = manager.resolveSettingsPath(
                PermissionSettingsManager.SCOPE_PROJECT, projectDir.toString());
        Path local = manager.resolveSettingsPath(
                PermissionSettingsManager.SCOPE_LOCAL, projectDir.toString());
        Path user = manager.resolveSettingsPath(
                PermissionSettingsManager.SCOPE_USER, projectDir.toString());

        assertTrue(project.endsWith(Path.of(".claude", "settings.json")));
        assertTrue(local.endsWith(Path.of(".claude", "settings.local.json")));
        assertTrue(user.endsWith(Path.of(".claude", "settings.json")));
        assertFalse("user scope must not resolve inside the project",
                user.startsWith(projectDir));
    }

    @Test
    public void rejectsProjectScopeWithoutWorkingDirectory() {
        try {
            manager.resolveSettingsPath(PermissionSettingsManager.SCOPE_PROJECT, "");
            fail("expected IllegalArgumentException when no project directory is available");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("project"));
        }
    }

    @Test
    public void rejectsUnknownScope() {
        try {
            manager.resolveSettingsPath("enterprise", projectDir.toString());
            fail("expected IllegalArgumentException for an unknown scope");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("Unknown settings scope"));
        }
    }

    @Test
    public void addsLocalSettingsToGitignoreOnlyInGitRepos() throws IOException {
        // No .git directory: .gitignore must not be invented.
        manager.writePermissions(PermissionSettingsManager.SCOPE_LOCAL, projectDir.toString(),
                rules(new String[]{"Bash(ls)"}, new String[]{}, new String[]{}));
        assertFalse(Files.exists(projectDir.resolve(".gitignore")));

        // With a .git directory the entry is added.
        Files.createDirectories(projectDir.resolve(".git"));
        manager.writePermissions(PermissionSettingsManager.SCOPE_LOCAL, projectDir.toString(),
                rules(new String[]{"Bash(ls)"}, new String[]{}, new String[]{}));

        String gitignore = Files.readString(projectDir.resolve(".gitignore"), StandardCharsets.UTF_8);
        assertTrue(gitignore.contains(".claude/settings.local.json"));

        // Saving again must not duplicate the entry.
        manager.writePermissions(PermissionSettingsManager.SCOPE_LOCAL, projectDir.toString(),
                rules(new String[]{"Bash(ls)", "Bash(pwd)"}, new String[]{}, new String[]{}));
        String updated = Files.readString(projectDir.resolve(".gitignore"), StandardCharsets.UTF_8);
        int occurrences = updated.split("\\.claude/settings\\.local\\.json", -1).length - 1;
        assertEquals(1, occurrences);
    }

    @Test
    public void respectsExistingBroadClaudeIgnoreEntry() throws IOException {
        Files.createDirectories(projectDir.resolve(".git"));
        Files.writeString(projectDir.resolve(".gitignore"), ".claude/\n", StandardCharsets.UTF_8);

        manager.writePermissions(PermissionSettingsManager.SCOPE_LOCAL, projectDir.toString(),
                rules(new String[]{"Bash(ls)"}, new String[]{}, new String[]{}));

        String gitignore = Files.readString(projectDir.resolve(".gitignore"), StandardCharsets.UTF_8);
        assertFalse("already covered by .claude/ — should not add a redundant entry",
                gitignore.contains("settings.local.json"));
    }

    @Test
    public void doesNotLeaveTempFilesBehind() throws IOException {
        manager.writePermissions(PermissionSettingsManager.SCOPE_PROJECT, projectDir.toString(),
                rules(new String[]{"Bash(ls)"}, new String[]{}, new String[]{}));

        try (Stream<Path> entries = Files.list(projectDir.resolve(".claude"))) {
            assertEquals("only settings.json should remain after an atomic write",
                    1, entries.count());
        }
    }
}
