package com.github.claudecodegui.permission;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Validates Claude Code permission rule strings, as used in the
 * {@code permissions.allow} / {@code ask} / {@code deny} arrays of
 * {@code settings.json}.
 *
 * <p>Accepted forms (per docs/sdk/claude-settings.md):</p>
 * <ul>
 *   <li>a bare tool name — {@code WebFetch}, {@code Bash}</li>
 *   <li>a tool with a specifier — {@code Bash(npm run lint)},
 *       {@code Bash(git diff:*)}, {@code Read(./secrets/**)},
 *       {@code Read(~/.zshrc)}, {@code WebFetch(domain:example.com)}</li>
 *   <li>an MCP tool — {@code mcp__server}, {@code mcp__server__tool}</li>
 * </ul>
 *
 * <p>The distinction between {@link Severity#ERROR} and {@link Severity#WARNING}
 * matters: errors are malformed rules Claude Code cannot use and are blocked
 * from being saved, warnings are rules that are syntactically fine but likely
 * not to behave as the author expects.</p>
 */
public final class PermissionRuleValidator {

    /** Tool names shipped by Claude Code, used to spot likely typos. */
    private static final Set<String> KNOWN_TOOLS = Set.of(
            "Agent", "Task", "Bash", "BashOutput", "KillShell", "Edit", "MultiEdit", "Write",
            "NotebookEdit", "Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch",
            "TodoWrite", "ExitPlanMode", "AskUserQuestion", "SlashCommand", "ListMcpResources",
            "ReadMcpResource"
    );

    /** Tools whose specifier is interpreted as a filesystem path. */
    private static final Set<String> PATH_TOOLS = Set.of(
            "Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Glob", "Grep", "LS"
    );

    /**
     * Paths the ai-bridge safety layer blocks before any settings rule is
     * consulted (see ai-bridge/permission-safety.js isDangerousPath). An allow
     * rule for one of these cannot take effect, which is worth telling the user
     * rather than letting them wonder.
     */
    private static final List<String> BRIDGE_BLOCKED_PREFIXES = List.of(
            "/etc/", "/System/", "/usr/", "/bin/", "/sbin/",
            "~/.ssh/", "~/.aws/", "~/.gnupg/", "~/.kube/", "~/.docker/",
            "~/.config/", "~/.local/"
    );

    private static final Pattern RULE_PATTERN =
            Pattern.compile("^([A-Za-z_][A-Za-z0-9_]*)(?:\\((.*)\\))?$", Pattern.DOTALL);

    public enum Severity { ERROR, WARNING }

    /** A single validation finding. */
    public static final class Finding {
        private final Severity severity;
        private final String message;

        Finding(Severity severity, String message) {
            this.severity = severity;
            this.message = message;
        }

        public Severity getSeverity() {
            return severity;
        }

        public String getMessage() {
            return message;
        }
    }

    private PermissionRuleValidator() {
    }

    /**
     * Validate one rule string.
     *
     * @param rule raw rule text
     * @param bucket "allow", "ask" or "deny" — some checks only apply to allow
     * @return findings, empty when the rule is clean
     */
    public static List<Finding> validate(String rule, String bucket) {
        List<Finding> findings = new ArrayList<>();

        if (rule == null || rule.isBlank()) {
            findings.add(new Finding(Severity.ERROR, "Rule is empty"));
            return findings;
        }
        if (!rule.equals(rule.strip())) {
            findings.add(new Finding(Severity.ERROR, "Rule has leading or trailing whitespace"));
            return findings;
        }
        if (rule.contains("\n") || rule.contains("\r") || rule.contains("\t")) {
            findings.add(new Finding(Severity.ERROR, "Rule contains a line break or tab"));
            return findings;
        }

        // Balanced-paren check before the regex, so the message is specific.
        int open = countChar(rule, '(');
        int close = countChar(rule, ')');
        if (open != close) {
            findings.add(new Finding(Severity.ERROR, "Unbalanced parentheses"));
            return findings;
        }
        if (open > 1) {
            findings.add(new Finding(Severity.ERROR, "Rule may contain at most one (specifier)"));
            return findings;
        }

        Matcher matcher = RULE_PATTERN.matcher(rule);
        if (!matcher.matches()) {
            findings.add(new Finding(Severity.ERROR,
                    "Expected a tool name, optionally followed by (specifier) — e.g. Bash(npm run test:*)"));
            return findings;
        }

        String tool = matcher.group(1);
        String specifier = matcher.group(2);

        if (open == 1 && (specifier == null || specifier.isBlank())) {
            findings.add(new Finding(Severity.ERROR,
                    "Empty specifier — drop the parentheses to match every use of " + tool));
            return findings;
        }

        boolean isMcp = tool.startsWith("mcp__");
        if (!isMcp && !KNOWN_TOOLS.contains(tool)) {
            findings.add(new Finding(Severity.WARNING,
                    "Unknown tool \"" + tool + "\" — check the spelling (tool names are case sensitive)"));
        }
        if (isMcp && specifier != null) {
            findings.add(new Finding(Severity.WARNING,
                    "MCP rules match by name only; the (specifier) will be ignored"));
        }

        if (specifier != null) {
            findings.addAll(validateSpecifier(tool, specifier, bucket));
        }

        return findings;
    }

    private static List<Finding> validateSpecifier(String tool, String specifier, String bucket) {
        List<Finding> findings = new ArrayList<>();

        // Bash rules are prefix matches, not regex. Regex metacharacters are a
        // common and silent mistake.
        if ("Bash".equals(tool)) {
            if (specifier.startsWith("^") || specifier.endsWith("$")) {
                findings.add(new Finding(Severity.WARNING,
                        "Bash rules use prefix matching, not regex — \"^\" and \"$\" are matched literally"));
            }
            if (specifier.contains(".*")) {
                findings.add(new Finding(Severity.WARNING,
                        "Bash rules use prefix matching — did you mean \":*\" instead of \".*\"?"));
            }
        }

        if (PATH_TOOLS.contains(tool) && "allow".equals(bucket)) {
            String normalized = specifier.trim();
            for (String blocked : BRIDGE_BLOCKED_PREFIXES) {
                if (normalized.startsWith(blocked)) {
                    findings.add(new Finding(Severity.WARNING,
                            "This plugin's safety layer blocks \"" + blocked
                            + "\" regardless of allow rules, so this rule will not take effect"));
                    break;
                }
            }
        }

        return findings;
    }

    /** True when the rule has no ERROR-level findings, i.e. it is safe to save. */
    public static boolean isSavable(String rule, String bucket) {
        return validate(rule, bucket).stream()
                .noneMatch(finding -> finding.getSeverity() == Severity.ERROR);
    }

    /**
     * Normalize a rule for duplicate detection. Tool names are case sensitive in
     * Claude Code, so only surrounding whitespace is normalized.
     */
    public static String normalizeForComparison(String rule) {
        return rule == null ? "" : rule.strip();
    }

    /** Valid bucket names. */
    public static boolean isValidBucket(String bucket) {
        if (bucket == null) {
            return false;
        }
        String lower = bucket.toLowerCase(Locale.ROOT);
        return "allow".equals(lower) || "ask".equals(lower) || "deny".equals(lower);
    }

    private static int countChar(String value, char target) {
        int count = 0;
        for (int i = 0; i < value.length(); i++) {
            if (value.charAt(i) == target) {
                count++;
            }
        }
        return count;
    }
}
