ALTER TABLE `quiz_federation_question_links` ADD `last_available_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quiz_federation_question_links` ADD `cache_purged_at` integer;