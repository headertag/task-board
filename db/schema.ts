import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';
export const tasks = sqliteTable('tasks', {
  owner: text('owner').notNull(), id: text('id').notNull(), payload: text('payload').notNull(),
  status: text('status').notNull(), archived: integer('archived').notNull().default(0),
  revision: integer('revision').notNull(), updatedAt: text('updated_at').notNull(), lastMutation: text('last_mutation').notNull(),
}, t => [primaryKey({columns:[t.owner,t.id]}), index('idx_tasks_owner_archived_status').on(t.owner,t.archived,t.status)]);
export const events = sqliteTable('task_events', {
  owner: text('owner').notNull(), requestKey: text('request_key').notNull(), fingerprint: text('fingerprint').notNull(),
  taskId: text('task_id').notNull(), action: text('action').notNull(), before: text('before_json'), after: text('after_json').notNull(), createdAt: text('created_at').notNull(),
},t=>[primaryKey({columns:[t.owner,t.requestKey]}),index('idx_events_owner_task').on(t.owner,t.taskId)]);
export const snapshots = sqliteTable('snapshots', {
  owner:text('owner').notNull(), id:text('id').notNull(), payload:text('payload').notNull(), createdAt:text('created_at').notNull(),
},t=>[primaryKey({columns:[t.owner,t.id]})]);
