/**
 * Work item repository implementation.
 */

import { randomUUID } from 'crypto';
import { getDatabase, transaction } from '../sqlite.js';
import type {
  Area,
  WorkItem,
  WorkItemCreateInput,
  WorkItemFilters,
  WorkItemKind,
  WorkItemOverviewStats,
  WorkItemStatus,
  WorkItemUpdateInput,
} from '../../../domain/work-item/index.js';

interface AreaRow {
  id: string;
  name: string;
  project_root: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkItemRow {
  id: string;
  kind: string;
  status: string;
  title: string;
  body: string | null;
  project_root: string | null;
  area_id: string | null;
  area_name: string | null;
  status_source: string;
  external_source: string | null;
  external_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToArea(row: AreaRow): Area {
  return {
    id: row.id,
    name: row.name,
    projectRoot: row.project_root || undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    kind: row.kind as WorkItemKind,
    status: row.status as WorkItemStatus,
    title: row.title,
    body: row.body || undefined,
    projectRoot: row.project_root || undefined,
    areaId: row.area_id || undefined,
    area: row.area_name || undefined,
    statusSource: row.status_source as WorkItem['statusSource'],
    externalSource: row.external_source || undefined,
    externalId: row.external_id || undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function buildWorkItemSelect(whereClause = ''): string {
  return `
    SELECT
      work_items.*,
      areas.name AS area_name
    FROM work_items
    LEFT JOIN areas ON areas.id = work_items.area_id
    ${whereClause}
  `;
}

export interface IWorkItemRepository {
  findAreaById(id: string): Area | null;
  findOrCreateArea(name: string, projectRoot?: string): Area;
  findById(id: string): WorkItem | null;
  findByExternalIdentity(source: string, externalId: string): WorkItem | null;
  findAll(filters?: WorkItemFilters): WorkItem[];
  create(input: WorkItemCreateInput): WorkItem;
  update(id: string, input: WorkItemUpdateInput): WorkItem | null;
  delete(id: string): boolean;
  getOverviewStats(): WorkItemOverviewStats;
}

class WorkItemRepository implements IWorkItemRepository {
  findAreaById(id: string): Area | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM areas WHERE id = ?').get(id) as AreaRow | undefined;
    return row ? rowToArea(row) : null;
  }

  findOrCreateArea(name: string, projectRoot?: string): Area {
    const db = getDatabase();
    const normalizedName = name.trim();
    const normalizedProjectRoot = projectRoot?.trim() || null;

    const existing = db.prepare(`
      SELECT * FROM areas
      WHERE name = ?
        AND ((project_root IS NULL AND ? IS NULL) OR project_root = ?)
      ORDER BY created_at ASC
      LIMIT 1
    `).get(normalizedName, normalizedProjectRoot, normalizedProjectRoot) as AreaRow | undefined;

    if (existing) {
      return rowToArea(existing);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO areas (id, name, project_root, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, normalizedName, normalizedProjectRoot, now, now);

    return this.findAreaById(id)!;
  }

  findById(id: string): WorkItem | null {
    const db = getDatabase();
    const row = db.prepare(`${buildWorkItemSelect('WHERE work_items.id = ?')}`)
      .get(id) as WorkItemRow | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  findByExternalIdentity(source: string, externalId: string): WorkItem | null {
    const db = getDatabase();
    const row = db.prepare(buildWorkItemSelect(
      'WHERE work_items.external_source = ? AND work_items.external_id = ?'
    )).get(source, externalId) as WorkItemRow | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  findAll(filters: WorkItemFilters = {}): WorkItem[] {
    const db = getDatabase();
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];

    if (filters.status && filters.status.length > 0) {
      clauses.push(`work_items.status IN (${filters.status.map(() => '?').join(', ')})`);
      params.push(...filters.status);
    } else if (!filters.includeArchived) {
      clauses.push("work_items.status != 'archived'");
    }

    if (filters.kind) {
      clauses.push('work_items.kind = ?');
      params.push(filters.kind);
    }

    if (filters.projectRoot) {
      clauses.push('work_items.project_root = ?');
      params.push(filters.projectRoot);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      ${buildWorkItemSelect(where)}
      ORDER BY work_items.updated_at DESC
    `).all(...params) as WorkItemRow[];

    return rows.map(rowToWorkItem);
  }

  create(input: WorkItemCreateInput): WorkItem {
    const db = getDatabase();

    return transaction(() => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const kind = input.kind ?? 'todo';
      const status = input.status ?? 'inbox';
      const projectRoot = input.projectRoot?.trim() || null;
      const area = input.area ? this.findOrCreateArea(input.area, projectRoot ?? undefined) : null;
      const completedAt = status === 'done' ? now : null;

      db.prepare(`
        INSERT INTO work_items (
          id, kind, status, title, body, project_root, area_id, status_source,
          external_source, external_id, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        kind,
        status,
        input.title,
        input.body ?? null,
        projectRoot,
        area?.id ?? null,
        input.statusSource ?? 'user',
        input.externalSource ?? null,
        input.externalId ?? null,
        completedAt,
        now,
        now
      );

      return this.findById(id)!;
    });
  }

  update(id: string, input: WorkItemUpdateInput): WorkItem | null {
    const existing = this.findById(id);
    if (!existing) return null;

    const db = getDatabase();
    return transaction(() => {
      const now = new Date().toISOString();
      const setClauses: string[] = [];
      const params: Array<string | null> = [];

      if (input.kind) {
        setClauses.push('kind = ?');
        params.push(input.kind);
      }
      if (input.status) {
        setClauses.push('status = ?');
        params.push(input.status);
        setClauses.push('completed_at = ?');
        params.push(input.status === 'done' ? now : null);
      }
      if (input.title !== undefined) {
        setClauses.push('title = ?');
        params.push(input.title);
      }
      if (input.body !== undefined) {
        setClauses.push('body = ?');
        params.push(input.body);
      }
      if (input.projectRoot !== undefined) {
        setClauses.push('project_root = ?');
        params.push(input.projectRoot);
      }
      if (input.area !== undefined) {
        const area = input.area
          ? this.findOrCreateArea(input.area, input.projectRoot ?? existing.projectRoot)
          : null;
        setClauses.push('area_id = ?');
        params.push(area?.id ?? null);
      }
      if (input.statusSource) {
        setClauses.push('status_source = ?');
        params.push(input.statusSource);
      }

      if (setClauses.length === 0) {
        return existing;
      }

      setClauses.push('updated_at = ?');
      params.push(now);
      params.push(id);

      db.prepare(`
        UPDATE work_items
        SET ${setClauses.join(', ')}
        WHERE id = ?
      `).run(...params);

      return this.findById(id);
    });
  }

  delete(id: string): boolean {
    const db = getDatabase();
    const result = db.prepare('DELETE FROM work_items WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getOverviewStats(): WorkItemOverviewStats {
    const items = this.findAll({ includeArchived: true });
    return {
      total: items.length,
      inbox: items.filter((item) => item.status === 'inbox').length,
      planned: items.filter((item) => item.status === 'planned').length,
      active: items.filter((item) => item.status === 'active').length,
      blocked: items.filter((item) => item.status === 'blocked').length,
      done: items.filter((item) => item.status === 'done').length,
      archived: items.filter((item) => item.status === 'archived').length,
      todo: items.filter((item) => item.kind === 'todo').length,
      idea: items.filter((item) => item.kind === 'idea').length,
      note: items.filter((item) => item.kind === 'note').length,
      projectTask: items.filter((item) => item.kind === 'project_task').length,
    };
  }
}

export const workItemRepository = new WorkItemRepository();
