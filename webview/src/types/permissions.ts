/**
 * Claude Code permission-rule types and client-side validation.
 *
 * The Java side is the authority (it validates again before writing), but
 * validating here too gives immediate inline feedback while typing, and keeps
 * obviously broken rules from being submitted at all.
 */

export type PermissionBucket = 'allow' | 'ask' | 'deny';
export type PermissionScope = 'user' | 'project' | 'local';

export const PERMISSION_BUCKETS: PermissionBucket[] = ['allow', 'ask', 'deny'];
export const PERMISSION_SCOPES: PermissionScope[] = ['user', 'project', 'local'];

export interface RuleFinding {
  severity: 'error' | 'warning';
  message: string;
}

export interface PermissionRule {
  rule: string;
  /**
   * Disabled rules are removed from settings.json and remembered by the plugin,
   * because Claude Code has no representation for a switched-off rule.
   */
  enabled: boolean;
  findings?: RuleFinding[];
}

export interface PermissionScopeState {
  scope: PermissionScope;
  /** False for project/local when no project directory is available. */
  applicable: boolean;
  path: string;
  exists: boolean;
  rules: Record<PermissionBucket, PermissionRule[]>;
  defaultMode?: string;
  additionalDirectories?: string[];
  disableBypassPermissionsMode?: string;
  /** Set when the file could not be read (e.g. malformed JSON). */
  error?: string;
}

export interface PermissionSettingsPayload {
  workingDirectory: string;
  hasProject: boolean;
  scopes: PermissionScopeState[];
  /** Highest-priority scope first. */
  precedence: PermissionScope[];
}

/** Tool names shipped by Claude Code — mirrors PermissionRuleValidator.KNOWN_TOOLS. */
const KNOWN_TOOLS = new Set([
  'Agent', 'Task', 'Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Write',
  'NotebookEdit', 'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch',
  'TodoWrite', 'ExitPlanMode', 'AskUserQuestion', 'SlashCommand', 'ListMcpResources',
  'ReadMcpResource',
]);

const PATH_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'LS']);

/**
 * Paths the plugin's own safety layer blocks before settings rules are
 * consulted (ai-bridge/permission-safety.js isDangerousPath), so an allow rule
 * for them cannot take effect.
 */
const BRIDGE_BLOCKED_PREFIXES = [
  '/etc/', '/System/', '/usr/', '/bin/', '/sbin/',
  '~/.ssh/', '~/.aws/', '~/.gnupg/', '~/.kube/', '~/.docker/',
  '~/.config/', '~/.local/',
];

const RULE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/s;

/**
 * Validate a rule string. Keep in sync with
 * `src/main/java/com/github/claudecodegui/permission/PermissionRuleValidator.java`.
 */
export function validatePermissionRule(rule: string, bucket: PermissionBucket): RuleFinding[] {
  const findings: RuleFinding[] = [];

  if (!rule || !rule.trim()) {
    return [{ severity: 'error', message: 'Rule is empty' }];
  }
  if (rule !== rule.trim()) {
    return [{ severity: 'error', message: 'Rule has leading or trailing whitespace' }];
  }
  if (/[\n\r\t]/.test(rule)) {
    return [{ severity: 'error', message: 'Rule contains a line break or tab' }];
  }

  const open = (rule.match(/\(/g) || []).length;
  const close = (rule.match(/\)/g) || []).length;
  if (open !== close) {
    return [{ severity: 'error', message: 'Unbalanced parentheses' }];
  }
  if (open > 1) {
    return [{ severity: 'error', message: 'Rule may contain at most one (specifier)' }];
  }

  const match = RULE_PATTERN.exec(rule);
  if (!match) {
    return [{
      severity: 'error',
      message: 'Expected a tool name, optionally followed by (specifier) — e.g. Bash(npm run test:*)',
    }];
  }

  const tool = match[1];
  const specifier = match[2];

  if (open === 1 && (specifier === undefined || !specifier.trim())) {
    return [{
      severity: 'error',
      message: `Empty specifier — drop the parentheses to match every use of ${tool}`,
    }];
  }

  const isMcp = tool.startsWith('mcp__');
  if (!isMcp && !KNOWN_TOOLS.has(tool)) {
    findings.push({
      severity: 'warning',
      message: `Unknown tool "${tool}" — check the spelling (tool names are case sensitive)`,
    });
  }
  if (isMcp && specifier !== undefined) {
    findings.push({
      severity: 'warning',
      message: 'MCP rules match by name only; the (specifier) will be ignored',
    });
  }

  if (specifier !== undefined) {
    if (tool === 'Bash') {
      if (specifier.startsWith('^') || specifier.endsWith('$')) {
        findings.push({
          severity: 'warning',
          message: 'Bash rules use prefix matching, not regex — "^" and "$" are matched literally',
        });
      }
      if (specifier.includes('.*')) {
        findings.push({
          severity: 'warning',
          message: 'Bash rules use prefix matching — did you mean ":*" instead of ".*"?',
        });
      }
    }

    if (PATH_TOOLS.has(tool) && bucket === 'allow') {
      const blocked = BRIDGE_BLOCKED_PREFIXES.find((prefix) => specifier.trim().startsWith(prefix));
      if (blocked) {
        findings.push({
          severity: 'warning',
          message: `This plugin's safety layer blocks "${blocked}" regardless of allow rules, so this rule will not take effect`,
        });
      }
    }
  }

  return findings;
}

export function hasBlockingError(findings: RuleFinding[] | undefined): boolean {
  return !!findings?.some((finding) => finding.severity === 'error');
}

/** Normalize for duplicate detection (tool names are case sensitive). */
export function normalizeRule(rule: string): string {
  return rule.trim();
}

/**
 * Rules in higher-priority scopes override the same rule in lower ones.
 * Returns the scopes (highest priority first) that also define `rule`.
 */
export function findOverridingScopes(
  rule: string,
  scope: PermissionScope,
  payload: PermissionSettingsPayload | null,
): PermissionScope[] {
  if (!payload) {
    return [];
  }
  const normalized = normalizeRule(rule);
  const order = payload.precedence ?? PERMISSION_SCOPES;
  const myRank = order.indexOf(scope);
  if (myRank < 0) {
    return [];
  }

  return order.slice(0, myRank).filter((candidate) => {
    const state = payload.scopes.find((entry) => entry.scope === candidate);
    if (!state?.applicable) {
      return false;
    }
    return PERMISSION_BUCKETS.some((bucket) =>
      (state.rules?.[bucket] ?? []).some(
        (entry) => entry.enabled && normalizeRule(entry.rule) === normalized,
      ),
    );
  });
}
