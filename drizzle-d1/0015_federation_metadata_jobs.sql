CREATE TABLE `quiz_federation_metadata_jobs` (
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`attempt_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	PRIMARY KEY(`instance_id`, `peer_origin`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_metadata_due` ON `quiz_federation_metadata_jobs` (`next_attempt_at`,`lease_until`);