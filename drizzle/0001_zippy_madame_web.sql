CREATE TABLE `attachments` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`task_id` text NOT NULL,
	`payload` text NOT NULL,
	`object_key` text NOT NULL,
	`request_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`ready` integer DEFAULT 0 NOT NULL,
	`size` integer NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_attachments_task` ON `attachments` (`owner`,`task_id`);--> statement-breakpoint
CREATE TABLE `backup_keys` (
	`owner` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `comment_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner` text NOT NULL,
	`request_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`comment_id` text NOT NULL,
	`task_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_comment_request` ON `comment_events` (`owner`,`request_key`);--> statement-breakpoint
CREATE INDEX `idx_comment_events_task` ON `comment_events` (`owner`,`task_id`);--> statement-breakpoint
CREATE TABLE `comments` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`task_id` text NOT NULL,
	`payload` text NOT NULL,
	`revision` integer NOT NULL,
	`last_mutation` text NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_comments_task` ON `comments` (`owner`,`task_id`);