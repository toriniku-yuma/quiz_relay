CREATE TABLE `quiz_federation_question_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`source_instance_id` text NOT NULL,
	`config` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`snapshot` text,
	`cursor` text,
	`active_snapshot` text,
	`last_success_at` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`attempt_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_question_import_due` ON `quiz_federation_question_imports` (`enabled`,`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `quiz_federation_question_links` (
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`source_instance_id` text NOT NULL,
	`source_series_id` text NOT NULL,
	`import_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`source_question_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`source_category` text NOT NULL,
	`source_difficulty` integer NOT NULL,
	`source_author_id` text NOT NULL,
	`seen_snapshot` text NOT NULL,
	`excluded` integer DEFAULT false NOT NULL,
	`mapping_revision` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`instance_id`, `peer_origin`, `source_instance_id`, `source_series_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_id`) REFERENCES `quiz_federation_question_imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submission_id`) REFERENCES `quiz_game_question_submissions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_question_link_import` ON `quiz_federation_question_links` (`import_id`,`seen_snapshot`);--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_federation_question_links_submission_id_unique` ON `quiz_federation_question_links` (`submission_id`);--> statement-breakpoint
CREATE TABLE `quiz_federation_question_staging` (
	`import_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`series_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`import_id`, `snapshot`, `series_id`),
	FOREIGN KEY (`import_id`) REFERENCES `quiz_federation_question_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_federation_shared_categories` (
	`instance_id` text NOT NULL,
	`category_id` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`instance_id`, `category_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `quiz_game_question_categories`(`id`) ON UPDATE no action ON DELETE no action
);
