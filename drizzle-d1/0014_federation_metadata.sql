CREATE TABLE `quiz_federation_metadata` (
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`payload` text NOT NULL,
	`next_cursor` text,
	`last_success_at` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	PRIMARY KEY(`instance_id`, `peer_origin`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
