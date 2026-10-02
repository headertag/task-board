import { sqliteTable, text, integer, primaryKey, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
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

export const comments=sqliteTable('comments',{
 owner:text('owner').notNull(),id:text('id').notNull(),taskId:text('task_id').notNull(),payload:text('payload').notNull(),revision:integer('revision').notNull(),lastMutation:text('last_mutation').notNull(),
},t=>[primaryKey({columns:[t.owner,t.id]}),index('idx_comments_task').on(t.owner,t.taskId)]);
export const commentEvents=sqliteTable('comment_events',{
 sequence:integer('sequence').primaryKey({autoIncrement:true}),owner:text('owner').notNull(),requestKey:text('request_key').notNull(),fingerprint:text('fingerprint').notNull(),commentId:text('comment_id').notNull(),taskId:text('task_id').notNull(),action:text('action').notNull(),before:text('before_json'),after:text('after_json').notNull(),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('idx_comment_request').on(t.owner,t.requestKey),index('idx_comment_events_task').on(t.owner,t.taskId)]);
export const attachments=sqliteTable('attachments',{
 owner:text('owner').notNull(),id:text('id').notNull(),taskId:text('task_id').notNull(),payload:text('payload').notNull(),objectKey:text('object_key').notNull(),requestKey:text('request_key').notNull(),fingerprint:text('fingerprint').notNull(),ready:integer('ready').notNull().default(0),size:integer('size').notNull(),
},t=>[primaryKey({columns:[t.owner,t.id]}),index('idx_attachments_task').on(t.owner,t.taskId)]);

export const backupKeys=sqliteTable('backup_keys',{owner:text('owner').primaryKey(),secret:text('secret').notNull()});

// Short-lived OAuth state hashes only; task owners and provider tokens are never stored here.
export const oauthTransactions=sqliteTable('oauth_transactions',{
 stateHash:text('state_hash').primaryKey(),expiresAt:integer('expires_at').notNull(),
},t=>[index('idx_oauth_transactions_expiry').on(t.expiresAt)]);

// Revoked invitations retain their first verified identity pins.
export const accessGrants=sqliteTable('access_grants',{
 owner:text('owner').notNull(),email:text('email').notNull(),access:text('access').notNull(),active:integer('active').notNull().default(1),
 googleProviderId:text('google_provider_id'),workosUserId:text('workos_user_id'),version:integer('version').notNull().default(1),
 createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),lastActionId:text('last_action_id').notNull(),lastActorUserId:text('last_actor_user_id').notNull(),
},t=>[primaryKey({columns:[t.owner,t.email]}),index('idx_access_email_active').on(t.email,t.active),
 check('access_role',sql`${t.access} IN ('read','write')`),check('access_active',sql`${t.active} IN (0,1)`),check('access_email_lower',sql`${t.email}=lower(${t.email})`),
 check('access_pin_pair',sql`(${t.googleProviderId} IS NULL AND ${t.workosUserId} IS NULL) OR (${t.googleProviderId} IS NOT NULL AND ${t.workosUserId} IS NOT NULL)`),check('access_version',sql`${t.version}>0`)]);
export const accessEvents=sqliteTable('access_events',{
 owner:text('owner').notNull(),id:text('id').notNull(),email:text('email').notNull(),action:text('action').notNull(),actorUserId:text('actor_user_id').notNull(),
 access:text('access').notNull(),active:integer('active').notNull(),googleProviderId:text('google_provider_id'),workosUserId:text('workos_user_id'),version:integer('version').notNull(),createdAt:text('created_at').notNull(),
},t=>[primaryKey({columns:[t.owner,t.id]}),index('idx_access_events_member').on(t.owner,t.email)]);
