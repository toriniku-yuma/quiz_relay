CREATE TABLE `quiz_federation_login_sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`peer_origin` text NOT NULL,
	`source_organization_id` text NOT NULL,
	`source_actor_id` text NOT NULL,
	`display_name` text NOT NULL,
	`organization_name` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_login_expiry` ON `quiz_federation_login_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `federation_login_actor` ON `quiz_federation_login_sessions` (`peer_origin`,`source_actor_id`);--> statement-breakpoint
CREATE INDEX `federation_reservation_identity` ON `quiz_federation_reservations` (`peer_origin`,`source_actor_id`,`state`);