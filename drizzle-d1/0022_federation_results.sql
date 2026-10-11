CREATE TABLE `quiz_federation_result_deliveries` (
	`event_id` text PRIMARY KEY NOT NULL,
	`result_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`source_actor_id` text NOT NULL,
	`payload` text NOT NULL,
	`payload_hash` text NOT NULL,
	`message` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`received_at` integer,
	`applied_at` integer,
	`error_code` text,
	`quarantined` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_result_due` ON `quiz_federation_result_deliveries` (`received_at`,`quarantined`,`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_federation_result_deliveries_result_id_peer_origin_source_actor_id_unique` ON `quiz_federation_result_deliveries` (`result_id`,`peer_origin`,`source_actor_id`);--> statement-breakpoint
CREATE TABLE `quiz_federation_result_inbox` (
	`peer_origin` text NOT NULL,
	`event_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`source_instance_id` text NOT NULL,
	`payload` text NOT NULL,
	`payload_hash` text NOT NULL,
	`message` text NOT NULL,
	`received_at` integer NOT NULL,
	`applied_at` integer,
	`finished_at` integer NOT NULL,
	`conflict_hash` text,
	PRIMARY KEY(`peer_origin`, `event_id`),
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_result_history` ON `quiz_federation_result_inbox` (`actor_id`,`source_instance_id`,`finished_at`,`event_id`);