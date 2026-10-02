CREATE TABLE `access_events` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`email` text NOT NULL,
	`action` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`access` text NOT NULL,
	`active` integer NOT NULL,
	`google_provider_id` text,
	`workos_user_id` text,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_access_events_member` ON `access_events` (`owner`,`email`);--> statement-breakpoint
CREATE TABLE `access_grants` (
	`owner` text NOT NULL,
	`email` text NOT NULL,
	`access` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`google_provider_id` text,
	`workos_user_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_action_id` text NOT NULL,
	`last_actor_user_id` text NOT NULL,
	PRIMARY KEY(`owner`, `email`),
	CONSTRAINT "access_role" CHECK("access_grants"."access" IN ('read','write')),
	CONSTRAINT "access_active" CHECK("access_grants"."active" IN (0,1)),
	CONSTRAINT "access_email_lower" CHECK("access_grants"."email"=lower("access_grants"."email")),
	CONSTRAINT "access_pin_pair" CHECK(("access_grants"."google_provider_id" IS NULL AND "access_grants"."workos_user_id" IS NULL) OR ("access_grants"."google_provider_id" IS NOT NULL AND "access_grants"."workos_user_id" IS NOT NULL)),
	CONSTRAINT "access_version" CHECK("access_grants"."version">0)
);
--> statement-breakpoint
CREATE INDEX `idx_access_email_active` ON `access_grants` (`email`,`active`);