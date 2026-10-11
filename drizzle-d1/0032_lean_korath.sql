CREATE TABLE `quiz_federation_participations` (
	`peer_origin` text NOT NULL,
	`reservation_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`source_instance_id` text NOT NULL,
	`host_instance_id` text NOT NULL,
	`match_id` text NOT NULL,
	`mode` text NOT NULL,
	`authorized_at` integer NOT NULL,
	PRIMARY KEY(`peer_origin`, `reservation_id`),
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_participation_actor` ON `quiz_federation_participations` (`actor_id`,`peer_origin`);--> statement-breakpoint
CREATE TABLE `quiz_federation_targets` (
	`source_instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`instance_id` text NOT NULL,
	`payload` text NOT NULL,
	`checked_at` integer NOT NULL,
	PRIMARY KEY(`source_instance_id`, `peer_origin`, `instance_id`),
	FOREIGN KEY (`source_instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `quiz_federation_peers` ADD `discovered` integer DEFAULT false NOT NULL;