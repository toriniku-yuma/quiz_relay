PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_quiz_federation_metadata` (
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`payload` text NOT NULL,
	`next_cursor` text,
	`last_success_at` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	PRIMARY KEY(`instance_id`, `peer_origin`),
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_quiz_federation_metadata`("instance_id", "peer_origin", "payload", "next_cursor", "last_success_at", "error_code") SELECT "instance_id", "peer_origin", "payload", "next_cursor", "last_success_at", "error_code" FROM `quiz_federation_metadata`;--> statement-breakpoint
DROP TABLE `quiz_federation_metadata`;--> statement-breakpoint
ALTER TABLE `__new_quiz_federation_metadata` RENAME TO `quiz_federation_metadata`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_quiz_federation_metadata_jobs` (
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`attempt_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	PRIMARY KEY(`instance_id`, `peer_origin`),
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_quiz_federation_metadata_jobs`("instance_id", "peer_origin", "next_attempt_at", "attempt_id", "lease_until", "failures", "error_code") SELECT "instance_id", "peer_origin", "next_attempt_at", "attempt_id", "lease_until", "failures", "error_code" FROM `quiz_federation_metadata_jobs`;--> statement-breakpoint
DROP TABLE `quiz_federation_metadata_jobs`;--> statement-breakpoint
ALTER TABLE `__new_quiz_federation_metadata_jobs` RENAME TO `quiz_federation_metadata_jobs`;--> statement-breakpoint
CREATE INDEX `federation_metadata_due` ON `quiz_federation_metadata_jobs` (`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `__new_quiz_federation_targets` (
	`source_instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`instance_id` text NOT NULL,
	`payload` text NOT NULL,
	`checked_at` integer NOT NULL,
	PRIMARY KEY(`source_instance_id`, `peer_origin`, `instance_id`),
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_quiz_federation_targets`("source_instance_id", "peer_origin", "instance_id", "payload", "checked_at") SELECT "source_instance_id", "peer_origin", "instance_id", "payload", "checked_at" FROM `quiz_federation_targets`;--> statement-breakpoint
DROP TABLE `quiz_federation_targets`;--> statement-breakpoint
ALTER TABLE `__new_quiz_federation_targets` RENAME TO `quiz_federation_targets`;--> statement-breakpoint
ALTER TABLE `quiz_federation_peers` ADD `receive_ranked` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `quiz_federation_peers` ADD `receive_casual` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `quiz_game_organizations` ADD `external_participation` text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE `quiz_game_organizations` ADD `federation_revision` integer DEFAULT 1 NOT NULL;