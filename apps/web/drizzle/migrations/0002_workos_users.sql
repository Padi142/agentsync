ALTER TABLE `user` ADD `workos_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `user_workos_id_unique` ON `user` (`workos_id`);