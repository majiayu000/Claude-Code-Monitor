import type { RuntimeDescriptor } from './types.js';

export const CLAUDE_CODE_DESCRIPTOR: RuntimeDescriptor = {
  id: 'claude-code',
  displayName: 'Claude Code',
  kind: 'cli',
  executableNames: ['claude', 'claude-code'],
  sessionPathHints: [
    '~/.claude/projects/<project>/<session>.jsonl',
    '~/.claude-work/projects/<project>/<session>.jsonl',
  ],
  capabilities: ['session-history', 'process-scan', 'resume', 'quota', 'plans', 'hooks'],
  compatibilityRoutes: {
    quota: ['/api/quota'],
    plans: ['/api/plans'],
    hooks: ['keepline hooks install', 'keepline hooks status'],
  },
};

export const CODEX_DESCRIPTOR: RuntimeDescriptor = {
  id: 'codex',
  displayName: 'Codex',
  kind: 'cli',
  executableNames: ['codex'],
  sessionPathHints: ['~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl'],
  capabilities: ['session-history', 'process-scan', 'resume', 'quota'],
  compatibilityRoutes: {
    quota: ['/api/codex/quota'],
  },
};

export const LOCAL_API_RUNTIME_DESCRIPTORS = [
  CLAUDE_CODE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
] as const;
