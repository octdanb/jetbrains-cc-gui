import { describe, expect, it } from 'vitest';
import {
  findOverridingScopes,
  hasBlockingError,
  validatePermissionRule,
  type PermissionSettingsPayload,
} from './permissions';

const errors = (rule: string, bucket: 'allow' | 'ask' | 'deny' = 'allow') =>
  validatePermissionRule(rule, bucket).filter((f) => f.severity === 'error');
const warnings = (rule: string, bucket: 'allow' | 'ask' | 'deny' = 'allow') =>
  validatePermissionRule(rule, bucket).filter((f) => f.severity === 'warning');

describe('validatePermissionRule', () => {
  it('accepts the documented rule forms', () => {
    const valid = [
      'WebFetch',
      'Bash',
      'Bash(npm run lint)',
      'Bash(git diff:*)',
      'Read(~/.zshrc)',
      'Read(./.env)',
      'Read(./secrets/**)',
      'Read(.envrc)',
      'WebFetch(domain:example.com)',
      'mcp__github',
      'mcp__github__create_issue',
    ];
    valid.forEach((rule) => {
      expect(errors(rule), `${rule} should have no errors`).toHaveLength(0);
    });
  });

  it('rejects structurally broken rules', () => {
    expect(errors('')).toHaveLength(1);
    expect(errors('   ')).toHaveLength(1);
    expect(errors('Bash(npm')).toHaveLength(1);
    expect(errors('Bash npm)')).toHaveLength(1);
    expect(errors('Bash()')).toHaveLength(1);
    expect(errors('Bash(a)(b)')).toHaveLength(1);
    expect(errors(' Bash(x)')).toHaveLength(1);
    expect(errors('Bash(x) ')).toHaveLength(1);
    expect(errors('Bash(a\nb)')).toHaveLength(1);
    expect(errors('9Tool(x)')).toHaveLength(1);
  });

  it('flags an empty specifier with actionable advice', () => {
    const [error] = errors('Read()');
    expect(error.message).toMatch(/drop the parentheses/i);
  });

  it('warns about unknown tool names but still allows saving', () => {
    const findings = validatePermissionRule('Bsah(ls)', 'allow');
    expect(findings.some((f) => f.severity === 'error')).toBe(false);
    expect(findings.some((f) => f.severity === 'warning' && /Unknown tool/.test(f.message))).toBe(true);
    expect(hasBlockingError(findings)).toBe(false);
  });

  it('is case sensitive about tool names', () => {
    expect(warnings('bash(ls)').some((f) => /Unknown tool/.test(f.message))).toBe(true);
    expect(warnings('Bash(ls)')).toHaveLength(0);
  });

  it('warns when regex syntax is used in prefix-matched Bash rules', () => {
    expect(warnings('Bash(^npm)').some((f) => /prefix matching/.test(f.message))).toBe(true);
    expect(warnings('Bash(npm run.*)').some((f) => /":\*"/.test(f.message))).toBe(true);
    // A correct prefix wildcard should not warn.
    expect(warnings('Bash(npm run test:*)')).toHaveLength(0);
  });

  it('warns that the bridge safety layer overrides allow rules for blocked paths', () => {
    const findings = warnings('Read(~/.ssh/id_rsa)', 'allow');
    expect(findings.some((f) => /safety layer/.test(f.message))).toBe(true);

    // Only relevant for allow rules — a deny rule there is redundant, not broken.
    expect(warnings('Read(~/.ssh/id_rsa)', 'deny').some((f) => /safety layer/.test(f.message))).toBe(false);
    // Ordinary project paths are fine.
    expect(warnings('Read(./src/**)', 'allow')).toHaveLength(0);
  });

  it('warns that MCP specifiers are ignored', () => {
    expect(warnings('mcp__github(create_issue)').some((f) => /ignored/.test(f.message))).toBe(true);
  });
});

describe('findOverridingScopes', () => {
  const payload: PermissionSettingsPayload = {
    workingDirectory: '/repo',
    hasProject: true,
    precedence: ['local', 'project', 'user'],
    scopes: [
      {
        scope: 'local', applicable: true, path: '/repo/.claude/settings.local.json', exists: true,
        rules: { allow: [{ rule: 'Bash(ls)', enabled: true }], ask: [], deny: [] },
      },
      {
        scope: 'project', applicable: true, path: '/repo/.claude/settings.json', exists: true,
        rules: { allow: [{ rule: 'Bash(ls)', enabled: true }], ask: [], deny: [] },
      },
      {
        scope: 'user', applicable: true, path: '~/.claude/settings.json', exists: true,
        rules: { allow: [{ rule: 'Bash(ls)', enabled: true }], ask: [], deny: [] },
      },
    ],
  };

  it('reports higher-priority scopes that define the same rule', () => {
    expect(findOverridingScopes('Bash(ls)', 'user', payload)).toEqual(['local', 'project']);
    expect(findOverridingScopes('Bash(ls)', 'project', payload)).toEqual(['local']);
    // Nothing outranks the highest-priority scope.
    expect(findOverridingScopes('Bash(ls)', 'local', payload)).toEqual([]);
  });

  it('ignores rules that are disabled in the higher scope', () => {
    const withDisabled: PermissionSettingsPayload = {
      ...payload,
      scopes: payload.scopes.map((scope) =>
        scope.scope === 'local'
          ? { ...scope, rules: { ...scope.rules, allow: [{ rule: 'Bash(ls)', enabled: false }] } }
          : scope),
    };
    expect(findOverridingScopes('Bash(ls)', 'project', withDisabled)).toEqual([]);
  });

  it('ignores non-applicable scopes and unknown rules', () => {
    const noProject: PermissionSettingsPayload = {
      ...payload,
      scopes: payload.scopes.map((scope) =>
        scope.scope === 'local' ? { ...scope, applicable: false } : scope),
    };
    expect(findOverridingScopes('Bash(ls)', 'project', noProject)).toEqual([]);
    expect(findOverridingScopes('Bash(never-set)', 'user', payload)).toEqual([]);
    expect(findOverridingScopes('Bash(ls)', 'user', null)).toEqual([]);
  });
});
