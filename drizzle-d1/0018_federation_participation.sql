CREATE TABLE `quiz_federation_actors` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`peer_origin` text NOT NULL,
	`source_actor_id` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_federation_actors_peer_origin_source_actor_id_unique` ON `quiz_federation_actors` (`peer_origin`,`source_actor_id`);--> statement-breakpoint
CREATE TABLE `quiz_federation_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_origin` text NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`source_instance_id` text NOT NULL,
	`source_actor_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`mode` text NOT NULL,
	`display_name` text NOT NULL,
	`room_id` text,
	`match_id` text,
	`state` text DEFAULT 'creating' NOT NULL,
	`expires_at` integer NOT NULL,
	`session_expires_at` integer DEFAULT 0 NOT NULL,
	`allowed_until` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_reservation_actor` ON `quiz_federation_reservations` (`instance_id`,`actor_id`,`allowed_until`);--> statement-breakpoint
CREATE INDEX `federation_reservation_expiry` ON `quiz_federation_reservations` (`state`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_federation_reservations_peer_origin_operation_id_unique` ON `quiz_federation_reservations` (`peer_origin`,`operation_id`);--> statement-breakpoint
CREATE TABLE `quiz_federation_sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `quiz_federation_reservations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_session_expiry` ON `quiz_federation_sessions` (`expires_at`);