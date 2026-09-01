import { describe, expect, test } from 'bun:test';
import type { AggregatedSession } from '../services/session.types.js';
import { buildAttentionOverview } from '../services/attention.prioritizer.js';
import type { SessionDigest } from '../domain/orchestrator/index.js';

const NOW = new Date('2026-06-29T12:00:00.000Z');
const RECENT = new Date('2026-06-29T11:55:00.000Z');
const OLD = new Date('2026-06-27T12:00:00.000Z');

function session(input: Partial<AggregatedSession> & {
  sessionId: string;
  status: AggregatedSession['status'];
}): AggregatedSession {
  return {
    id: input.sessionId,
    sessionId: input.sessionId,
    client: input.client ?? 'codex',
    directory: input.directory ?? '/tmp/keepline',
    status: input.status,
    title: input.title ?? input.sessionId,
    initialPrompt: input.initialPrompt ?? '',
    lastTool: input.lastTool,
    currentFile: input.currentFile,
    lastMessage: input.lastMessage,
    startedAt: RECENT,
    lastActiveAt: input.lastActiveAt ?? RECENT,
    completedAt: input.completedAt,
    pid: input.pid,
    tty: input.tty,
    toolCount: input.toolCount ?? 0,
    messageCount: input.messageCount ?? 0,
    usageStats: input.usageStats,
    processRunning: input.processRunning ?? false,
    cpuUsage: input.cpuUsage,
    memoryUsage: input.memoryUsage,
    createdAt: RECENT,
    updatedAt: RECENT,
  };
}

describe('buildAttentionOverview', () => {
  test('projects runtime states into board lanes and orders lanes by ownership', () => {
    const overview = buildAttentionOverview([
      session({ sessionId: 'running', status: 'running' }),
      session({ sessionId: 'completed', status: 'completed' }),
      session({ sessionId: 'idle', status: 'idle' }),
      session({ sessionId: 'stale', status: 'running', lastActiveAt: OLD }),
      session({
        sessionId: 'high-cost',
        status: 'running',
        usageStats: {
          totalInputTokens: 10,
          totalOutputTokens: 20,
          totalTokens: 30,
          totalCost: 5,
          apiCalls: 1,
        },
      }),
      session({ sessionId: 'lost', status: 'lost' }),
      session({ sessionId: 'waiting', status: 'waiting' }),
    ], {
      includeCompleted: true,
      now: NOW,
      highCostThreshold: 1,
      staleHours: 24,
    });

    expect(overview.items.map((item) => item.sessionId)).toEqual([
      'waiting',
      'lost',
      'high-cost',
      'running',
      'stale',
      'completed',
      'idle',
    ]);
    expect(overview.items[0]).toMatchObject({
      rank: 1,
      recommendedAction: 'review',
      reasons: [expect.objectContaining({ code: 'waiting_for_human' })],
    });
    expect(overview.items[1].recommendedAction).toBe('recover');
    expect(overview.items.map((item) => item.lane)).toEqual([
      'needs_you',
      'needs_you',
      'working',
      'working',
      'working',
      'finished',
      'paused',
    ]);
  });

  test('keeps waiting before lost and uses recency inside working', () => {
    const overview = buildAttentionOverview([
      session({
        sessionId: 'lost-high-cost',
        status: 'lost',
        usageStats: {
          totalInputTokens: 100,
          totalOutputTokens: 200,
          totalTokens: 300,
          totalCost: 100,
          apiCalls: 5,
        },
      }),
      session({
        sessionId: 'running-high-cost-stale',
        status: 'running',
        lastActiveAt: OLD,
        usageStats: {
          totalInputTokens: 100,
          totalOutputTokens: 200,
          totalTokens: 300,
          totalCost: 100,
          apiCalls: 5,
        },
      }),
      session({ sessionId: 'waiting-only', status: 'waiting' }),
    ], {
      now: NOW,
      highCostThreshold: 1,
      staleHours: 24,
    });

    expect(overview.items.map((item) => item.sessionId)).toEqual([
      'waiting-only',
      'lost-high-cost',
      'running-high-cost-stale',
    ]);
  });

  test('does not create cost reasons without persisted usage cost', () => {
    const overview = buildAttentionOverview([
      session({ sessionId: 'no-usage', status: 'running' }),
      session({
        sessionId: 'below-threshold',
        status: 'running',
        usageStats: {
          totalInputTokens: 1,
          totalOutputTokens: 1,
          totalTokens: 2,
          totalCost: 0.5,
          apiCalls: 1,
        },
      }),
    ], {
      now: NOW,
      highCostThreshold: 1,
    });

    for (const item of overview.items) {
      expect(item.reasons.some((reason) => reason.code === 'high_cost')).toBe(false);
    }
  });

  test('uses deterministic tie breakers for equal scores', () => {
    const overview = buildAttentionOverview([
      session({ sessionId: 'b-session', status: 'idle', lastActiveAt: RECENT }),
      session({ sessionId: 'a-session', status: 'idle', lastActiveAt: RECENT }),
      session({ sessionId: 'newer-session', status: 'idle', lastActiveAt: NOW }),
    ], { now: NOW });

    expect(overview.items.map((item) => item.sessionId)).toEqual([
      'newer-session',
      'a-session',
      'b-session',
    ]);
  });

  test('can include completed sessions explicitly', () => {
    const overview = buildAttentionOverview([
      session({ sessionId: 'completed', status: 'completed' }),
    ], {
      includeCompleted: true,
      now: NOW,
    });

    expect(overview.items).toHaveLength(1);
    expect(overview.items[0]).toMatchObject({
      sessionId: 'completed',
      lane: 'finished',
      recommendedAction: 'none',
      score: 0,
    });
  });

  test('hides old lost sessions from the default recovery queue', () => {
    const overview = buildAttentionOverview([
      session({ sessionId: 'recent-lost', status: 'lost', lastActiveAt: RECENT }),
      session({ sessionId: 'old-lost', status: 'lost', lastActiveAt: OLD }),
      session({ sessionId: 'waiting', status: 'waiting', lastActiveAt: OLD }),
    ], { now: NOW });

    expect(overview.items.map((item) => item.sessionId)).toEqual([
      'waiting',
      'recent-lost',
    ]);
    expect(overview.stats).toMatchObject({
      totalCandidates: 2,
      hiddenOldLost: 1,
      lostWindowHours: 1,
      critical: 2,
    });
  });

  test('can include old lost sessions explicitly', () => {
    const overview = buildAttentionOverview([
      session({ sessionId: 'old-lost', status: 'lost', lastActiveAt: OLD }),
    ], {
      now: NOW,
      includeOldLost: true,
    });

    expect(overview.items).toHaveLength(1);
    expect(overview.items[0].sessionId).toBe('old-lost');
    expect(overview.stats.hiddenOldLost).toBe(0);
    expect(overview.stats.lostWindowHours).toBeUndefined();
  });

  test('includes compact session context for actionable review cards', () => {
    const overview = buildAttentionOverview([
      session({
        sessionId: 'context-session',
        status: 'waiting',
        initialPrompt: '  Investigate issue 62\n\nand explain next step.  ',
        lastMessage: 'I need human approval before merging the PR.',
        lastTool: 'apply_patch',
        currentFile: '/tmp/keepline/src/services/attention.prioritizer.ts',
        messageCount: 12,
        toolCount: 4,
      }),
    ], { now: NOW });

    expect(overview.items[0].context).toEqual({
      initialPrompt: 'Investigate issue 62 and explain next step.',
      lastMessage: 'I need human approval before merging the PR.',
      lastTool: 'apply_patch',
      currentFile: '/tmp/keepline/src/services/attention.prioritizer.ts',
      messageCount: 12,
      toolCount: 4,
    });
  });

  test('truncates long context previews in the overview payload', () => {
    const overview = buildAttentionOverview([
      session({
        sessionId: 'long-context-session',
        status: 'waiting',
        lastMessage: 'x'.repeat(900),
      }),
    ], { now: NOW });

    expect(overview.items[0].context.lastMessage).toHaveLength(700);
    expect(overview.items[0].context.lastMessage?.endsWith('...')).toBe(true);
  });

  test('extracts actionable intent when prompt and title are instruction noise', () => {
    const overview = buildAttentionOverview([
      session({
        sessionId: 'intent-session',
        status: 'lost',
        title: '# AGENTS.md instructions <INSTRUCTIONS> vibeguard-start',
        initialPrompt: '# AGENTS.md instructions <INSTRUCTIONS> Files called AGENTS.md commonly appear in many places.',
        lastMessage: 'Denoise probe 第一次启动失败了，我先看 stderr。通常这种是脚本路径或 OpenVINO Async API 细节。',
        currentFile: '/Users/lifcc/Desktop/code/work/infra/vsr/runs/topaz_dragon_cleanup_20260629T035947Z/cleanup_standard.png',
        lastTool: 'exec_command',
      }),
    ], { now: NOW });

    expect(overview.items[0].intent).toMatchObject({
      task: 'Investigate: Denoise probe 第一次启动失败了，我先看 stderr',
      taskSource: 'last_message',
      currentState: 'Denoise probe 第一次启动失败了，我先看 stderr。通常这种是脚本路径或 OpenVINO Async API 细节。',
      nextAction: 'Recover this session and continue around topaz_dragon_cleanup_20260629T035947Z/cleanup_standard.png.',
      whyAttention: 'Session is lost and may be recoverable',
      confidence: 'medium',
      noiseFlags: [
        'instructions_heavy',
        'derived_from_last_message',
        'missing_user_goal',
      ],
      evidence: {
        lastTool: 'exec_command',
        currentFile: '/Users/lifcc/Desktop/code/work/infra/vsr/runs/topaz_dragon_cleanup_20260629T035947Z/cleanup_standard.png',
      },
    });
  });

  test('does not present attachment markup as the agent task', () => {
    const attachmentDigest: SessionDigest = {
      id: 'attachment-digest-id',
      sessionId: 'image-prompt-session',
      summary: '<image name=[Image #1] path="/tmp/capture.png">',
      nextActions: [],
      blockers: [],
      waitingForHuman: false,
      source: 'deterministic',
      status: 'fresh',
      sourceUpdatedAt: RECENT,
      generatedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const overview = buildAttentionOverview([
      session({
        sessionId: 'image-prompt-session',
        status: 'waiting',
        title: '<image name=[Image #1] path="/tmp/captu...',
        initialPrompt: '<image name=[Image #1] path="/tmp/capture.png">',
        lastMessage: 'The dashboard spacing needs a clearer compact layout.',
      }),
    ], {
      now: NOW,
      digests: new Map([['image-prompt-session', attachmentDigest]]),
    });

    expect(overview.items[0].intent).toMatchObject({
      task: 'Continue: The dashboard spacing needs a clearer compact layout',
      taskSource: 'last_message',
      confidence: 'medium',
    });
  });

  test('skips low-information response openers when deriving intent', () => {
    const overview = buildAttentionOverview([
      session({
        sessionId: 'filler-session',
        status: 'lost',
        title: '# AGENTS.md instructions <INSTRUCTIONS> vibeguard-start',
        initialPrompt: '# AGENTS.md instructions <INSTRUCTIONS> Files called AGENTS.md commonly appear in many places.',
        lastMessage: '看了。结论是：gh21 应该学习产品行为和交互契约，不是照搬原型 UI。',
      }),
    ], { now: NOW });

    expect(overview.items[0].intent.task).toBe(
      'Continue: 结论是：gh21 应该学习产品行为和交互契约，不是照搬原型 UI'
    );
    expect(overview.items[0].intent.taskSource).toBe('last_message');
  });

  test('does not use low-information responses as derived tasks', () => {
    const overview = buildAttentionOverview([
      session({
        sessionId: 'low-info-session',
        status: 'waiting',
        title: '# AGENTS.md instructions <INSTRUCTIONS> vibeguard-start',
        initialPrompt: '# AGENTS.md instructions <INSTRUCTIONS> Files called AGENTS.md commonly appear in many places.',
        lastMessage: '继续正常。',
      }),
    ], { now: NOW });

    expect(overview.items[0].intent.task).toBeUndefined();
    expect(overview.items[0].intent.taskSource).toBe('none');
    expect(overview.items[0].intent.currentState).toBe('继续正常。');
    expect(overview.items[0].intent.noiseFlags).toEqual([
      'instructions_heavy',
      'missing_user_goal',
    ]);
  });

  test('ignores greeting and citation footer responses when deriving intent', () => {
    const overview = buildAttentionOverview([
      session({
        sessionId: 'greeting-session',
        status: 'waiting',
        title: '# AGENTS.md instructions <INSTRUCTIONS> vibeguard-start',
        initialPrompt: '# AGENTS.md instructions <INSTRUCTIONS> Files called AGENTS.md commonly appear in many places.',
        lastMessage: '你好，我在。 Memory citations: none',
      }),
    ], { now: NOW });

    expect(overview.items[0].intent.task).toBeUndefined();
    expect(overview.items[0].intent.taskSource).toBe('none');
    expect(overview.items[0].intent.currentState).toBe('你好，我在。 Memory citations: none');
  });

  test('attaches serialized digest without changing queue order', () => {
    const digest: SessionDigest = {
      id: 'digest-id',
      sessionId: 'digest-session',
      summary: 'Digest summary',
      nextActions: ['Next action'],
      blockers: [],
      waitingForHuman: false,
      source: 'deterministic',
      status: 'fresh',
      sourceUpdatedAt: RECENT,
      generatedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };

    const overview = buildAttentionOverview([
      session({ sessionId: 'waiting-session', status: 'waiting' }),
      session({ sessionId: 'digest-session', status: 'running' }),
    ], {
      now: NOW,
      digests: new Map([['digest-session', digest]]),
    });

    expect(overview.items.map((item) => item.sessionId)).toEqual([
      'waiting-session',
      'digest-session',
    ]);
    expect(overview.items[1].digest).toMatchObject({
      sessionId: 'digest-session',
      summary: 'Digest summary',
      nextActions: ['Next action'],
      source: 'deterministic',
      status: 'fresh',
      generatedAt: '2026-06-29T12:00:00.000Z',
    });
    expect(overview.items[1].intent.taskSource).toBe('digest');
  });
});
