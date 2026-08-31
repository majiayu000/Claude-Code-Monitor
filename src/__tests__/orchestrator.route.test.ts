import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import orchestrator from '../web/api/routes/orchestrator.js';
import { app } from '../web/api/server.js';
import { setupUser } from '../services/auth.service.js';
import { resetDatabase } from '../db/migrations.js';
import { closeDatabase } from '../infrastructure/database/sqlite.js';
import { sessionRepository } from '../infrastructure/database/repositories/session.repository.js';

const RECENT_SESSION_OFFSET_MS = 5 * 60 * 1000;
const OLD_LOST_SESSION_OFFSET_MS = 2 * 60 * 60 * 1000;

function recentSessionDate(): Date {
  return new Date(Date.now() - RECENT_SESSION_OFFSET_MS);
}

function oldLostSessionDate(): Date {
  return new Date(Date.now() - OLD_LOST_SESSION_OFFSET_MS);
}

describe('Orchestrator Route Contract', () => {
  beforeEach(() => {
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
  });

  test('overview returns serialized attention queue with auth', async () => {
    const lastActiveAt = recentSessionDate();

    sessionRepository.upsert({
      sessionId: 'orchestrator-route-cost',
      client: 'codex',
      directory: '/tmp/keepline-orchestrator',
      status: 'running',
      title: 'Expensive local run',
      initialPrompt: 'Track cost',
      lastMessage: 'Cost is high, review before continuing',
      lastTool: 'Read',
      currentFile: '/tmp/keepline-orchestrator/report.md',
      lastActiveAt,
      toolCount: 2,
      messageCount: 4,
      usageStats: {
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalTokens: 150,
        totalCost: 5,
        apiCalls: 2,
      },
    });

    const { token } = await setupUser('orchestrator-route-user', 'password123');
    const response = await orchestrator.fetch(new Request(
      'http://localhost/overview?limit=10&highCostThreshold=1',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);

    const body = await response.json() as {
      success: boolean;
      data: {
        generatedAt: string;
        items: Array<{
          sessionId: string;
          lastActiveAt: string;
          context: {
            initialPrompt?: string;
            lastMessage?: string;
            lastTool?: string;
            currentFile?: string;
            messageCount: number;
            toolCount: number;
          };
          intent: {
            task?: string;
            taskSource: string;
            currentState?: string;
            nextAction: string;
            whyAttention: string;
            confidence: string;
            noiseFlags: string[];
          };
          reasons: Array<{ code: string }>;
        }>;
        stats: { totalCandidates: number };
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.generatedAt).toEqual(expect.any(String));
    expect(body.data.stats.totalCandidates).toBe(1);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      sessionId: 'orchestrator-route-cost',
      lastActiveAt: lastActiveAt.toISOString(),
      context: {
        initialPrompt: 'Track cost',
        lastMessage: 'Cost is high, review before continuing',
        lastTool: 'Read',
        currentFile: '/tmp/keepline-orchestrator/report.md',
        messageCount: 4,
        toolCount: 2,
      },
      intent: {
        task: 'Track cost',
        taskSource: 'initial_prompt',
        currentState: 'Cost is high, review before continuing',
        nextAction: 'Recover this session and continue around keepline-orchestrator/report.md.',
        whyAttention: 'Session is lost and may be recoverable; Session cost is $5.00',
        confidence: 'high',
      },
    });
    expect(body.data.items[0].reasons.map((reason) => reason.code)).toContain('high_cost');
  });

  test('overview marks tasks derived from noisy prompt fallbacks as last-message sourced', async () => {
    sessionRepository.upsert({
      sessionId: 'orchestrator-last-message-derived',
      client: 'codex',
      directory: '/tmp/keepline-derived-intent',
      status: 'waiting',
      title: '# AGENTS.md instructions <INSTRUCTIONS> vibeguard-start',
      initialPrompt: '# AGENTS.md instructions <INSTRUCTIONS> Files called AGENTS.md commonly appear in many places.',
      lastMessage: 'Continue: 首页已经看到新定位，项目页这次正则没有命中，我会查一下 dev server 输出。',
      lastActiveAt: recentSessionDate(),
      toolCount: 3,
      messageCount: 8,
    });

    const { token } = await setupUser('orchestrator-derived-intent-user', 'password123');
    const response = await orchestrator.fetch(new Request(
      'http://localhost/overview?limit=1',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      success: boolean;
      data: {
        items: Array<{
          sessionId: string;
          intent: {
            task?: string;
            taskSource: string;
            noiseFlags: string[];
          };
        }>;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.items[0]).toMatchObject({
      sessionId: 'orchestrator-last-message-derived',
      intent: {
        taskSource: 'last_message',
        noiseFlags: expect.arrayContaining([
          'instructions_heavy',
          'derived_from_last_message',
          'missing_user_goal',
        ]),
      },
    });
    expect(body.data.items[0].intent.task).toStartWith('Continue:');
  });

  test('server mounts the orchestrator overview route', async () => {
    sessionRepository.upsert({
      sessionId: 'mounted-orchestrator-route',
      client: 'claude',
      directory: '/tmp/keepline-mounted-orchestrator',
      status: 'running',
      title: 'Mounted route',
      initialPrompt: 'Mounted',
      lastActiveAt: recentSessionDate(),
      toolCount: 1,
      messageCount: 1,
    });

    const { token } = await setupUser('mounted-orchestrator-user', 'password123');
    const response = await app.fetch(new Request(
      'http://localhost/api/orchestrator/overview?limit=1',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      success: boolean;
      data: { items: Array<{ sessionId: string }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].sessionId).toBe('mounted-orchestrator-route');
  });

  test('generates deterministic digest for a requested session', async () => {
    sessionRepository.upsert({
      sessionId: 'orchestrator-digest-generate',
      client: 'codex',
      directory: '/tmp/keepline-digest-generate',
      status: 'waiting',
      title: 'Digest generate',
      lastMessage: 'Needs human review',
      lastActiveAt: recentSessionDate(),
    });

    const { token } = await setupUser('orchestrator-digest-user', 'password123');
    const response = await orchestrator.fetch(new Request(
      'http://localhost/digests/generate',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: 'deterministic',
          sessionId: 'orchestrator-digest-generate',
        }),
      }
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      success: boolean;
      data: {
        digests: Array<{
          sessionId: string;
          summary: string;
          blockers: string[];
          source: string;
          status: string;
          waitingForHuman: boolean;
        }>;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.digests).toHaveLength(1);
    expect(body.data.digests[0]).toMatchObject({
      sessionId: 'orchestrator-digest-generate',
      summary: 'Needs human review',
      blockers: ['Session is lost and may need recovery'],
      source: 'deterministic',
      status: 'fresh',
      waitingForHuman: false,
    });
  });

  test('overview includes persisted digest payloads', async () => {
    sessionRepository.upsert({
      sessionId: 'orchestrator-overview-digest',
      client: 'claude',
      directory: '/tmp/keepline-overview-digest',
      status: 'waiting',
      title: 'Overview digest',
      lastMessage: 'Digest visible in overview',
      lastActiveAt: recentSessionDate(),
    });

    const { token } = await setupUser('orchestrator-overview-digest-user', 'password123');
    await orchestrator.fetch(new Request(
      'http://localhost/digests/generate',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: 'deterministic',
          sessionId: 'orchestrator-overview-digest',
        }),
      }
    ));

    const response = await orchestrator.fetch(new Request(
      'http://localhost/overview?limit=1',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      success: boolean;
      data: {
        items: Array<{
          sessionId: string;
          digest?: {
            sessionId: string;
            summary: string;
            source: string;
            status: string;
          };
        }>;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.items[0]).toMatchObject({
      sessionId: 'orchestrator-overview-digest',
      digest: {
        sessionId: 'orchestrator-overview-digest',
        summary: 'Digest visible in overview',
        source: 'deterministic',
        status: 'fresh',
      },
    });
  });

  test('rejects invalid numeric query values', async () => {
    const { token } = await setupUser('orchestrator-invalid-user', 'password123');
    const response = await orchestrator.fetch(new Request(
      'http://localhost/overview?limit=abc',
      { headers: { Authorization: `Bearer ${token}` } }
    ));

    expect(response.status).toBe(400);
    const body = await response.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('limit must be a positive number');
  });

  test('hides old lost sessions by default and can include them explicitly', async () => {
    sessionRepository.upsert({
      sessionId: 'old-lost-route-session',
      client: 'codex',
      directory: '/tmp/keepline-old-lost',
      status: 'lost',
      wasProcessObserved: true,
      title: 'Old lost',
      lastActiveAt: oldLostSessionDate(),
    });

    const { token } = await setupUser('orchestrator-old-lost-user', 'password123');
    const defaultResponse = await orchestrator.fetch(new Request(
      'http://localhost/overview?limit=10',
      { headers: { Authorization: `Bearer ${token}` } }
    ));
    const defaultBody = await defaultResponse.json() as {
      data: {
        items: Array<{ sessionId: string }>;
        stats: { hiddenOldLost: number; lostWindowHours?: number };
      };
    };

    expect(defaultResponse.status).toBe(200);
    expect(defaultBody.data.items).toHaveLength(0);
    expect(defaultBody.data.stats).toMatchObject({
      hiddenOldLost: 1,
      lostWindowHours: 1,
    });

    const explicitResponse = await orchestrator.fetch(new Request(
      'http://localhost/overview?limit=10&includeOldLost=true',
      { headers: { Authorization: `Bearer ${token}` } }
    ));
    const explicitBody = await explicitResponse.json() as {
      data: {
        items: Array<{ sessionId: string }>;
        stats: { hiddenOldLost: number; lostWindowHours?: number };
      };
    };

    expect(explicitResponse.status).toBe(200);
    expect(explicitBody.data.items[0].sessionId).toBe('old-lost-route-session');
    expect(explicitBody.data.stats.hiddenOldLost).toBe(0);
    expect(explicitBody.data.stats.lostWindowHours).toBeUndefined();
  });

  test('requires authentication', async () => {
    const response = await orchestrator.fetch(new Request('http://localhost/overview'));

    expect(response.status).toBe(401);
  });
});
