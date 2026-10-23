DELETE FROM `quiz_federation_login_sessions`;
--> statement-breakpoint
ALTER TABLE `quiz_federation_login_sessions` ADD `grant` text NOT NULL;