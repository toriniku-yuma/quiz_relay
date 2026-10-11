CREATE TABLE `quiz_information_entries` (
	`instance_id` text NOT NULL,
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`authoring_rules` text DEFAULT '' NOT NULL,
	`published` integer NOT NULL,
	`published_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`instance_id`, `id`, `revision`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `information_list` ON `quiz_information_entries` (`instance_id`,`updated_at`,`id`);