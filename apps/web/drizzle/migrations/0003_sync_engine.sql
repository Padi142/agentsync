CREATE TABLE `conflict` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`base_revision` integer NOT NULL,
	`server_revision` integer NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conflict_user_status_idx` ON `conflict` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `device_authorization` (
	`device_code_hash` text PRIMARY KEY NOT NULL,
	`interval` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `machine` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`os` text NOT NULL,
	`targets` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `machine_user_idx` ON `machine` (`user_id`);--> statement-breakpoint
CREATE TABLE `machine_credential` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_credential_machine_id_unique` ON `machine_credential` (`machine_id`);--> statement-breakpoint
CREATE TABLE `machine_variables` (
	`machine_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `machine_variables_revision` (
	`machine_id` text NOT NULL,
	`revision` integer NOT NULL,
	`variables` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`machine_id`, `revision`),
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `template` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `template_revision` (
	`user_id` text NOT NULL,
	`revision` integer NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `revision`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP TABLE `file`;