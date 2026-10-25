ALTER TABLE `machine` RENAME COLUMN "name" TO "hostname";--> statement-breakpoint
ALTER TABLE `machine` ADD `nickname` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Until now the one name was set from the hostname and could be renamed: keep it as the nickname.
UPDATE `machine` SET `nickname` = `hostname`;
