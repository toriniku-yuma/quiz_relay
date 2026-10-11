CREATE TABLE `quiz_federation_control_deliveries` (
	`event_id` text NOT NULL,
	`peer_origin` text NOT NULL,
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
	PRIMARY KEY(`event_id`, `peer_origin`),
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_control_due` ON `quiz_federation_control_deliveries` (`applied_at`,`quarantined`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `quiz_federation_control_inbox` (
	`peer_origin` text NOT NULL,
	`event_id` text NOT NULL,
	`payload` text NOT NULL,
	`payload_hash` text NOT NULL,
	`message` text NOT NULL,
	`received_at` integer NOT NULL,
	`applied_at` integer,
	`room_cursor` text,
	`conflict_hash` text,
	PRIMARY KEY(`peer_origin`, `event_id`),
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_control_apply` ON `quiz_federation_control_inbox` (`applied_at`,`received_at`);--> statement-breakpoint
CREATE TABLE `quiz_federation_deleted_instances` (
	`peer_origin` text NOT NULL,
	`instance_id` text NOT NULL,
	`deleted_at` integer NOT NULL,
	PRIMARY KEY(`peer_origin`, `instance_id`),
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_federation_retired_identities` (
	`peer_origin` text NOT NULL,
	`actor_id` text NOT NULL,
	`retired_at` integer NOT NULL,
	PRIMARY KEY(`peer_origin`, `actor_id`),
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
