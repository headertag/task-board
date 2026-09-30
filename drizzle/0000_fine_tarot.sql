CREATE TABLE `task_events` (
	`owner` text NOT NULL,
	`request_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`task_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner`, `request_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_events_owner_task` ON `task_events` (`owner`,`task_id`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL,
	`last_mutation` text NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_owner_archived_status` ON `tasks` (`owner`,`archived`,`status`);