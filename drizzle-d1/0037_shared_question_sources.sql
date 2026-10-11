CREATE TABLE `quiz_federation_question_sources` (
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`source_instance_id` text NOT NULL,
	`categories` text DEFAULT '[]' NOT NULL,
	`last_success_at` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	PRIMARY KEY(`instance_id`, `peer_origin`, `source_instance_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `quiz_game_question_categories` ADD `import_only` integer DEFAULT false NOT NULL;