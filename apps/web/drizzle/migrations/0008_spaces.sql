CREATE TABLE `space` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`share_token` text NOT NULL,
	`write_token_hash` text NOT NULL,
	`is_private` integer NOT NULL,
	`expires_at` integer,
	`total_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `space_share_token_unique` ON `space` (`share_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `space_write_token_hash_unique` ON `space` (`write_token_hash`);--> statement-breakpoint
CREATE INDEX `space_user_idx` ON `space` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `space_expires_idx` ON `space` (`expires_at`);--> statement-breakpoint
CREATE TABLE `space_file` (
	`space_id` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`content_type` text NOT NULL,
	`sha256` text NOT NULL,
	`r2_key` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `path`),
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
