CREATE TABLE `machine_skill_report` (
	`machine_id` text PRIMARY KEY NOT NULL,
	`scan` text NOT NULL,
	`reported_at` integer NOT NULL,
	`results` text,
	`synced_at` integer,
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `skill` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`repo_id` integer NOT NULL,
	`repo_full_name` text NOT NULL,
	`path` text NOT NULL,
	`pin_commit` text NOT NULL,
	`pin_tree_sha` text NOT NULL,
	`pin_installed_hash` text NOT NULL,
	`pin_committed_at` integer NOT NULL,
	`assignment` text NOT NULL,
	`auto_update` integer NOT NULL,
	`newer` text NOT NULL,
	`update_pushed_at` integer,
	`audits` text,
	`checked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_user_name_idx` ON `skill` (`user_id`,`name`);--> statement-breakpoint
CREATE INDEX `skill_checked_idx` ON `skill` (`checked_at`);--> statement-breakpoint
CREATE TABLE `skill_folder_version` (
	`repo_id` integer NOT NULL,
	`commit` text NOT NULL,
	`path` text NOT NULL,
	`tree_sha` text NOT NULL,
	`installed_hash` text,
	PRIMARY KEY(`repo_id`, `commit`, `path`)
);
--> statement-breakpoint
CREATE INDEX `skill_folder_version_hash_idx` ON `skill_folder_version` (`repo_id`,`path`,`installed_hash`);--> statement-breakpoint
CREATE TABLE `skill_machine` (
	`skill_id` text NOT NULL,
	`machine_id` text NOT NULL,
	PRIMARY KEY(`skill_id`, `machine_id`),
	FOREIGN KEY (`skill_id`) REFERENCES `skill`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_machine_machine_idx` ON `skill_machine` (`machine_id`);--> statement-breakpoint
CREATE TABLE `skill_pin_move` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`from_commit` text,
	`to_commit` text NOT NULL,
	`to_installed_hash` text NOT NULL,
	`kind` text NOT NULL,
	`audits` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skill`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_pin_move_skill_idx` ON `skill_pin_move` (`skill_id`,`at`);--> statement-breakpoint
CREATE TABLE `skill_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`auto_update` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
