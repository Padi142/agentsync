CREATE TABLE `skill_request` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`repo_id` integer NOT NULL,
	`repo_full_name` text NOT NULL,
	`source` text NOT NULL,
	`commit` text NOT NULL,
	`names` text,
	`skills` text NOT NULL,
	`audits` text,
	`status` text NOT NULL,
	`added` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_request_user_idx` ON `skill_request` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `skill_request_machine_idx` ON `skill_request` (`machine_id`,`source`);