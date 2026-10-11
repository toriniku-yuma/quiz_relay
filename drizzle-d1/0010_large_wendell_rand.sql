CREATE TABLE `quiz_maintenance_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`completed_day` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quiz_game_result_privacy_jobs` (
	`result_id` text PRIMARY KEY NOT NULL,
	`due_at` text NOT NULL,
	FOREIGN KEY (`result_id`) REFERENCES `quiz_game_match_results`(`result_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `result_privacy_due` ON `quiz_game_result_privacy_jobs` (`due_at`,`result_id`);