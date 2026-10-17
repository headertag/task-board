CREATE TABLE `attachment_upload_parts` (
	`owner` text NOT NULL,
	`attachment_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`sha256` text NOT NULL,
	`etag` text,
	PRIMARY KEY(`owner`, `attachment_id`, `part_number`)
);
--> statement-breakpoint
CREATE TABLE `attachment_uploads` (
	`owner` text NOT NULL,
	`attachment_id` text NOT NULL,
	`upload_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner`, `attachment_id`)
);
--> statement-breakpoint
CREATE TABLE `backup_manifests` (
	`owner` text NOT NULL,
	`backup_id` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`owner`, `backup_id`)
);
