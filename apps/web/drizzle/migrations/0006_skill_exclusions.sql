CREATE TABLE `skill_exclusion` (
	`user_id` text NOT NULL,
	`repo` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`user_id`, `repo`, `name`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
