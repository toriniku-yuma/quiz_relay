CREATE TABLE `quiz_federation_reservation_closures` (
	`peer_origin` text NOT NULL,
	`operation_id` text NOT NULL,
	`source_actor_id` text NOT NULL,
	`confirmed` integer DEFAULT false NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`peer_origin`, `operation_id`),
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_closure_expiry` ON `quiz_federation_reservation_closures` (`expires_at`);