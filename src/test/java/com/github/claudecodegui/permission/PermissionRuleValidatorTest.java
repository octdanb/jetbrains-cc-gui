package com.github.claudecodegui.permission;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Mirrors webview/src/types/permissions.test.ts — the two validators must agree,
 * because the webview validates for inline feedback and Java validates again
 * before anything is written to settings.json.
 */
public class PermissionRuleValidatorTest {

    private static long errorCount(String rule, String bucket) {
        return PermissionRuleValidator.validate(rule, bucket).stream()
                .filter(f -> f.getSeverity() == PermissionRuleValidator.Severity.ERROR)
                .count();
    }

    private static List<PermissionRuleValidator.Finding> warnings(String rule, String bucket) {
        return PermissionRuleValidator.validate(rule, bucket).stream()
                .filter(f -> f.getSeverity() == PermissionRuleValidator.Severity.WARNING)
                .toList();
    }

    private static boolean hasWarningMatching(String rule, String bucket, String needle) {
        return warnings(rule, bucket).stream()
                .anyMatch(f -> f.getMessage().toLowerCase().contains(needle.toLowerCase()));
    }

    @Test
    public void acceptsDocumentedRuleForms() {
        String[] valid = {
            "WebFetch", "Bash",
            "Bash(npm run lint)", "Bash(git diff:*)",
            "Read(~/.zshrc)", "Read(./.env)", "Read(./secrets/**)", "Read(.envrc)",
            "WebFetch(domain:example.com)",
            "mcp__github", "mcp__github__create_issue"
        };
        for (String rule : valid) {
            assertEquals("expected no errors for " + rule, 0, errorCount(rule, "allow"));
            assertTrue("expected savable: " + rule, PermissionRuleValidator.isSavable(rule, "allow"));
        }
    }

    @Test
    public void rejectsStructurallyBrokenRules() {
        String[] invalid = {
            "", "   ", "Bash(npm", "Bash npm)", "Bash()", "Bash(a)(b)",
            " Bash(x)", "Bash(x) ", "Bash(a\nb)", "9Tool(x)"
        };
        for (String rule : invalid) {
            assertTrue("expected an error for [" + rule + "]", errorCount(rule, "allow") > 0);
            assertFalse("must not be savable: [" + rule + "]",
                    PermissionRuleValidator.isSavable(rule, "allow"));
        }
    }

    @Test
    public void rejectsNullRule() {
        assertTrue(errorCount(null, "allow") > 0);
        assertFalse(PermissionRuleValidator.isSavable(null, "allow"));
    }

    @Test
    public void emptySpecifierSuggestsDroppingParentheses() {
        assertTrue(PermissionRuleValidator.validate("Read()", "allow").stream()
                .anyMatch(f -> f.getMessage().contains("drop the parentheses")));
    }

    @Test
    public void unknownToolWarnsButRemainsSavable() {
        assertTrue(hasWarningMatching("Bsah(ls)", "allow", "unknown tool"));
        assertTrue(PermissionRuleValidator.isSavable("Bsah(ls)", "allow"));
    }

    @Test
    public void toolNamesAreCaseSensitive() {
        assertTrue(hasWarningMatching("bash(ls)", "allow", "unknown tool"));
        assertTrue(warnings("Bash(ls)", "allow").isEmpty());
    }

    @Test
    public void warnsAboutRegexInPrefixMatchedBashRules() {
        assertTrue(hasWarningMatching("Bash(^npm)", "allow", "prefix matching"));
        assertTrue(hasWarningMatching("Bash(npm run.*)", "allow", "prefix matching"));
        assertTrue("a correct prefix wildcard should not warn",
                warnings("Bash(npm run test:*)", "allow").isEmpty());
    }

    @Test
    public void warnsWhenBridgeSafetyLayerOverridesAllowRule() {
        assertTrue(hasWarningMatching("Read(~/.ssh/id_rsa)", "allow", "safety layer"));
        // Only meaningful for allow rules.
        assertFalse(hasWarningMatching("Read(~/.ssh/id_rsa)", "deny", "safety layer"));
        assertTrue(warnings("Read(./src/**)", "allow").isEmpty());
    }

    @Test
    public void warnsThatMcpSpecifiersAreIgnored() {
        assertTrue(hasWarningMatching("mcp__github(create_issue)", "allow", "ignored"));
    }

    @Test
    public void validatesBucketNames() {
        assertTrue(PermissionRuleValidator.isValidBucket("allow"));
        assertTrue(PermissionRuleValidator.isValidBucket("ask"));
        assertTrue(PermissionRuleValidator.isValidBucket("deny"));
        assertFalse(PermissionRuleValidator.isValidBucket("allowed"));
        assertFalse(PermissionRuleValidator.isValidBucket(null));
    }

    @Test
    public void normalizesOnlySurroundingWhitespace() {
        assertEquals("Bash(ls)", PermissionRuleValidator.normalizeForComparison("  Bash(ls)  "));
        // Case must be preserved: tool names are case sensitive.
        assertEquals("BASH(ls)", PermissionRuleValidator.normalizeForComparison("BASH(ls)"));
        assertEquals("", PermissionRuleValidator.normalizeForComparison(null));
    }
}
