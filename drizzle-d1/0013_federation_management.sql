CREATE TABLE `quiz_federation_favorites` (
	`actor_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`instance_id` text NOT NULL,
	PRIMARY KEY(`actor_id`, `peer_origin`, `instance_id`),
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_federation_nonces` (
	`issuer` text NOT NULL,
	`purpose` text NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`issuer`, `purpose`, `nonce`)
);
--> statement-breakpoint
CREATE INDEX `federation_nonce_expiry` ON `quiz_federation_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `quiz_federation_peer_keys` (
	`origin` text NOT NULL,
	`kid` text NOT NULL,
	`public_key` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`origin`, `kid`),
	FOREIGN KEY (`origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_federation_peers` (
	`origin` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kid` text NOT NULL,
	`public_key` text NOT NULL,
	`approved` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quiz_federation_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`peer_instance_id` text NOT NULL,
	`permissions` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_policy_peer` ON `quiz_federation_policies` (`peer_origin`);--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_federation_policies_instance_id_peer_origin_peer_instance_id_unique` ON `quiz_federation_policies` (`instance_id`,`peer_origin`,`peer_instance_id`);