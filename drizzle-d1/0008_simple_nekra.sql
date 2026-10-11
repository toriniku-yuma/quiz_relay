CREATE TABLE `quiz_game_difficulty_actors` (
	`owner` text NOT NULL,
	`generation` text NOT NULL,
	`band` integer NOT NULL,
	`players` integer NOT NULL,
	`rules_hash` text NOT NULL,
	`band_revision` integer NOT NULL,
	`actor_id` text NOT NULL,
	PRIMARY KEY(`owner`, `generation`, `band`, `players`, `rules_hash`, `band_revision`, `actor_id`)
);
--> statement-breakpoint
CREATE TABLE `quiz_game_difficulty_backfills` (
	`owner` text PRIMARY KEY NOT NULL,
	`finished_at` text NOT NULL,
	`result_id` text NOT NULL,
	`complete` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quiz_game_difficulty_samples` (
	`owner` text NOT NULL,
	`generation` text NOT NULL,
	`band` integer NOT NULL,
	`players` integer NOT NULL,
	`rules_hash` text NOT NULL,
	`band_revision` integer NOT NULL,
	`trials` integer DEFAULT 0 NOT NULL,
	`correct` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner`, `generation`, `band`, `players`, `rules_hash`, `band_revision`)
);
--> statement-breakpoint
CREATE TABLE `quiz_game_difficulty_trials` (
	`owner` text NOT NULL,
	`match_id` text NOT NULL,
	`question_id` text NOT NULL,
	`result_id` text NOT NULL,
	`generation` text NOT NULL,
	`band` integer NOT NULL,
	`players` integer NOT NULL,
	`rules_hash` text NOT NULL,
	`band_revision` integer NOT NULL,
	`correct` integer NOT NULL,
	`actors` text NOT NULL,
	PRIMARY KEY(`owner`, `match_id`, `question_id`),
	FOREIGN KEY (`result_id`) REFERENCES `quiz_game_match_results`(`result_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `difficulty_trials_result` ON `quiz_game_difficulty_trials` (`result_id`);--> statement-breakpoint
CREATE INDEX `difficulty_trials_generation` ON `quiz_game_difficulty_trials` (`owner`,`generation`);--> statement-breakpoint
ALTER TABLE `quiz_game_question_difficulty` ADD `statistics_revision` integer DEFAULT 0 NOT NULL;