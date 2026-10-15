CREATE TABLE `quiz_game_account_instance_selections` (
	`actor_id` text NOT NULL,
	`instance_id` text NOT NULL,
	PRIMARY KEY(`actor_id`, `instance_id`),
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `d1_accountInstanceSelections_1` ON `quiz_game_account_instance_selections` (`instance_id`);--> statement-breakpoint
CREATE TABLE `quiz_game_account_withdrawals` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`requested_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`auth_deleted_at` text,
	`erased_at` text,
	`audit_erased_at` text,
	`retry_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`room_cursor` text,
	`last_attempt_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `quiz_game_organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_game_account_withdrawals_actor_id_unique` ON `quiz_game_account_withdrawals` (`actor_id`);--> statement-breakpoint
CREATE TABLE `quiz_game_administrator_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`target_id` text NOT NULL,
	`keep_sender` integer NOT NULL,
	`read_at` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `quiz_game_organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transfer_state" CHECK("quiz_game_administrator_transfers"."state" IN ('pending','accepted','cancelled')),
	CONSTRAINT "transfer_target" CHECK("quiz_game_administrator_transfers"."sender_id" <> "quiz_game_administrator_transfers"."target_id")
);
--> statement-breakpoint
CREATE INDEX `d1_administratorTransfers_1` ON `quiz_game_administrator_transfers` (`target_id`,`state`);--> statement-breakpoint
CREATE TABLE `quiz_game_competitions` (
	`owner` text NOT NULL,
	`competition_id` text NOT NULL,
	`version` integer NOT NULL,
	`players_per_match` integer NOT NULL,
	`ruleset_id` text NOT NULL,
	`ruleset_version` integer NOT NULL,
	`set_id` text NOT NULL,
	`set_version` integer NOT NULL,
	PRIMARY KEY(`owner`, `competition_id`, `version`),
	FOREIGN KEY (`owner`,`ruleset_id`,`ruleset_version`) REFERENCES `quiz_game_ruleset_versions`(`owner`,`ruleset_id`,`version`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner`,`set_id`,`set_version`) REFERENCES `quiz_game_question_sets`(`owner`,`set_id`,`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "competitions_competition_id_check" CHECK((length(competition_id) BETWEEN 1 AND 64 AND competition_id NOT GLOB '*[^a-zA-Z0-9_-]*')),
	CONSTRAINT "competitions_players_per_match_check" CHECK((players_per_match >= 2) AND (players_per_match <= 4)),
	CONSTRAINT "competitions_version_check" CHECK(version > 0)
);
--> statement-breakpoint
CREATE TABLE `quiz_database_revision` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "database_revision_singleton" CHECK("quiz_database_revision"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `quiz_game_difficulty_actors` (
	`owner` text NOT NULL,
	`generation` text NOT NULL,
	`band` integer NOT NULL,
	`players` integer NOT NULL,
	`rules_hash` text NOT NULL,
	`band_revision` integer NOT NULL,
	`actor_id` text NOT NULL,
	PRIMARY KEY(`owner`, `generation`, `band`, `players`, `rules_hash`, `band_revision`, `actor_id`)
);
--> statement-breakpoint
CREATE TABLE `quiz_game_difficulty_samples` (
	`owner` text NOT NULL,
	`generation` text NOT NULL,
	`band` integer NOT NULL,
	`players` integer NOT NULL,
	`rules_hash` text NOT NULL,
	`band_revision` integer NOT NULL,
	`trials` integer DEFAULT 0 NOT NULL,
	`correct` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner`, `generation`, `band`, `players`, `rules_hash`, `band_revision`)
);
--> statement-breakpoint
CREATE TABLE `quiz_game_difficulty_trials` (
	`owner` text NOT NULL,
	`question_id` text NOT NULL,
	`match_id` text NOT NULL,
	`generation` text NOT NULL,
	`band` integer NOT NULL,
	`players` integer NOT NULL,
	`rules_hash` text NOT NULL,
	`band_revision` integer NOT NULL,
	`correct` integer NOT NULL,
	`actors` text NOT NULL,
	PRIMARY KEY(`owner`, `match_id`, `question_id`),
	FOREIGN KEY (`match_id`) REFERENCES `quiz_game_matches`(`match_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `difficulty_trials_result` ON `quiz_game_difficulty_trials` (`match_id`);--> statement-breakpoint
CREATE INDEX `difficulty_trials_generation` ON `quiz_game_difficulty_trials` (`owner`,`generation`);--> statement-breakpoint
CREATE TABLE `quiz_federation_actors` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`peer_origin` text NOT NULL,
	`source_actor_id` text NOT NULL,
	`display_name` text,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_federation_actors_peer_origin_source_actor_id_unique` ON `quiz_federation_actors` (`peer_origin`,`source_actor_id`);--> statement-breakpoint
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
CREATE TABLE `quiz_federation_favorites` (
	`actor_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`instance_id` text NOT NULL,
	PRIMARY KEY(`actor_id`, `peer_origin`, `instance_id`),
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
CREATE TABLE `quiz_federation_metadata` (
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
CREATE TABLE `quiz_federation_metadata_jobs` (
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
CREATE INDEX `federation_metadata_due` ON `quiz_federation_metadata_jobs` (`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `quiz_federation_nonces` (
	`issuer` text NOT NULL,
	`purpose` text NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`issuer`, `purpose`, `nonce`)
);
--> statement-breakpoint
CREATE INDEX `federation_nonce_expiry` ON `quiz_federation_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `quiz_federation_participations` (
	`peer_origin` text NOT NULL,
	`reservation_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`source_organization_id` text NOT NULL,
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
	`discovered` integer DEFAULT false NOT NULL,
	`participation_blocked` integer DEFAULT false NOT NULL,
	`receive_ranked` integer DEFAULT true NOT NULL,
	`receive_casual` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quiz_federation_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`peer_instance_id` text NOT NULL,
	`send_questions` integer DEFAULT false NOT NULL,
	`receive_questions` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_policy_peer` ON `quiz_federation_policies` (`peer_origin`);--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_federation_policies_instance_id_peer_origin_peer_instance_id_unique` ON `quiz_federation_policies` (`instance_id`,`peer_origin`,`peer_instance_id`);--> statement-breakpoint
CREATE TABLE `quiz_federation_question_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`source_instance_id` text NOT NULL,
	`config` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`snapshot` text,
	`cursor` text,
	`active_snapshot` text,
	`last_success_at` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`attempt_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_question_import_due` ON `quiz_federation_question_imports` (`enabled`,`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `quiz_federation_question_links` (
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`source_instance_id` text NOT NULL,
	`source_series_id` text NOT NULL,
	`import_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`source_question_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`source_category` text NOT NULL,
	`source_difficulty` integer NOT NULL,
	`source_author_id` text NOT NULL,
	`seen_snapshot` text NOT NULL,
	`excluded` integer DEFAULT false NOT NULL,
	`mapping_revision` integer DEFAULT 1 NOT NULL,
	`mapping_hash` text DEFAULT '' NOT NULL,
	`last_available_at` integer DEFAULT 0 NOT NULL,
	`cache_purged_at` integer,
	PRIMARY KEY(`instance_id`, `peer_origin`, `source_instance_id`, `source_series_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_id`) REFERENCES `quiz_federation_question_imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submission_id`) REFERENCES `quiz_game_question_submissions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_question_link_import` ON `quiz_federation_question_links` (`import_id`,`seen_snapshot`);--> statement-breakpoint
CREATE INDEX `federation_question_cache_due` ON `quiz_federation_question_links` (`cache_purged_at`,`last_available_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_federation_question_links_submission_id_unique` ON `quiz_federation_question_links` (`submission_id`);--> statement-breakpoint
CREATE TABLE `quiz_federation_question_sources` (
	`instance_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`source_instance_id` text NOT NULL,
	`categories` text DEFAULT '[]' NOT NULL,
	`last_success_at` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	PRIMARY KEY(`instance_id`, `peer_origin`, `source_instance_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_federation_question_staging` (
	`import_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`series_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`import_id`, `snapshot`, `series_id`),
	FOREIGN KEY (`import_id`) REFERENCES `quiz_federation_question_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
CREATE INDEX `federation_closure_expiry` ON `quiz_federation_reservation_closures` (`expires_at`);--> statement-breakpoint
CREATE TABLE `quiz_federation_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_origin` text NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`authorization_id` text DEFAULT '' NOT NULL,
	`source_organization_id` text NOT NULL,
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
CREATE INDEX `federation_reservation_identity` ON `quiz_federation_reservations` (`peer_origin`,`source_actor_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_federation_reservations_peer_origin_operation_id_unique` ON `quiz_federation_reservations` (`peer_origin`,`operation_id`);--> statement-breakpoint
CREATE TABLE `quiz_federation_result_deliveries` (
	`event_id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
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
CREATE UNIQUE INDEX `quiz_federation_result_deliveries_match_id_peer_origin_source_actor_id_unique` ON `quiz_federation_result_deliveries` (`match_id`,`peer_origin`,`source_actor_id`);--> statement-breakpoint
CREATE TABLE `quiz_federation_result_inbox` (
	`peer_origin` text NOT NULL,
	`event_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`source_organization_id` text NOT NULL,
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
CREATE INDEX `federation_result_history` ON `quiz_federation_result_inbox` (`actor_id`,`source_organization_id`,`finished_at`,`event_id`);--> statement-breakpoint
CREATE TABLE `quiz_federation_retired_identities` (
	`peer_origin` text NOT NULL,
	`actor_id` text NOT NULL,
	`retired_at` integer NOT NULL,
	PRIMARY KEY(`peer_origin`, `actor_id`),
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_federation_sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `quiz_federation_reservations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `federation_session_expiry` ON `quiz_federation_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `quiz_federation_targets` (
	`source_organization_id` text NOT NULL,
	`peer_origin` text NOT NULL,
	`instance_id` text NOT NULL,
	`payload` text NOT NULL,
	`checked_at` integer NOT NULL,
	PRIMARY KEY(`source_organization_id`, `peer_origin`, `instance_id`),
	FOREIGN KEY (`peer_origin`) REFERENCES `quiz_federation_peers`(`origin`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_game_guest_sessions` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `quiz_game_organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "guest_actor_hash" CHECK((length("quiz_game_guest_sessions"."actor_id") = 64 AND "quiz_game_guest_sessions"."actor_id" NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
CREATE INDEX `d1_guestSessions_1` ON `quiz_game_guest_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `quiz_game_instance_deletions` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`operator_id` text NOT NULL,
	`requested_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`accepted_at` text,
	`check_cursor` text,
	`room_cursor` text,
	`inventory_pending` integer DEFAULT false NOT NULL,
	`last_attempt_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `quiz_game_organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_game_instance_deletions_instance_id_unique` ON `quiz_game_instance_deletions` (`instance_id`);--> statement-breakpoint
CREATE TABLE `quiz_game_instance_grants` (
	`instance_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`permission` text NOT NULL,
	PRIMARY KEY(`instance_id`, `actor_id`, `permission`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "instance_permission" CHECK("quiz_game_instance_grants"."permission" IN ('questions', 'authors', 'users'))
);
--> statement-breakpoint
CREATE INDEX `d1_instanceGrants_1` ON `quiz_game_instance_grants` (`actor_id`);--> statement-breakpoint
CREATE TABLE `quiz_game_instance_rooms` (
	`room_id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`review_attempted_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `d1_instanceRooms_1` ON `quiz_game_instance_rooms` (`review_attempted_at`,`room_id`);--> statement-breakpoint
CREATE TABLE `quiz_game_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`state` text DEFAULT 'preparing' NOT NULL,
	`operation_revision` integer DEFAULT 0 NOT NULL,
	`pause_reason` text,
	`ranked_pause_reason` text,
	`casual_pause_reason` text,
	`casual_config` text DEFAULT '{"enabled":true,"players":4,"casualGuests":false,"roomGuests":false}' NOT NULL,
	`room_inventory_complete` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `quiz_game_organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "instance_name_length" CHECK(length(trim("quiz_game_instances"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "instance_owner_length" CHECK(length(trim("quiz_game_instances"."owner")) BETWEEN 1 AND 256),
	CONSTRAINT "instance_state" CHECK("quiz_game_instances"."state" IN ('preparing', 'published', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_game_instances_owner_unique` ON `quiz_game_instances` (`owner`);--> statement-breakpoint
CREATE INDEX `d1_instances_1` ON `quiz_game_instances` (`organization_id`);--> statement-breakpoint
CREATE TABLE `quiz_maintenance_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`completed_day` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quiz_game_matches` (
	`match_id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`parent_room_id` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`payload_hash` text,
	`payload` text NOT NULL,
	CONSTRAINT "match_status" CHECK("quiz_game_matches"."status" IN ('waiting', 'running', 'confirmed', 'invalid', 'conflict', 'cancelled')),
	CONSTRAINT "match_result_state" CHECK(("quiz_game_matches"."status" IN ('confirmed', 'invalid', 'conflict') AND json_type("quiz_game_matches"."payload", '$.result') = 'object' AND "quiz_game_matches"."payload_hash" IS NOT NULL AND "quiz_game_matches"."finished_at" IS NOT NULL) OR ("quiz_game_matches"."status" IN ('waiting', 'running', 'cancelled') AND json_type("quiz_game_matches"."payload", '$.result') = 'null' AND "quiz_game_matches"."payload_hash" IS NULL)),
	CONSTRAINT "match_results_hash" CHECK((length("quiz_game_matches"."payload_hash") = 64 AND "quiz_game_matches"."payload_hash" NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
CREATE INDEX `matches_finished` ON `quiz_game_matches` (`owner`,`finished_at`);--> statement-breakpoint
CREATE INDEX `matches_status` ON `quiz_game_matches` (`owner`,`status`);--> statement-breakpoint
CREATE TABLE `quiz_game_matchmaking_settings` (
	`owner` text NOT NULL,
	`profile` text NOT NULL,
	`competition_id` text NOT NULL,
	`competition_version` integer NOT NULL,
	PRIMARY KEY(`owner`, `profile`),
	FOREIGN KEY (`owner`,`competition_id`,`competition_version`) REFERENCES `quiz_game_competitions`(`owner`,`competition_id`,`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "matchmaking_settings_profile_check" CHECK((length(profile) BETWEEN 1 AND 64 AND profile NOT GLOB '*[^a-zA-Z0-9_-]*'))
);
--> statement-breakpoint
CREATE TABLE `quiz_game_moderation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`instance_id` text,
	`actor_id` text NOT NULL,
	`operator_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`request_hash` text NOT NULL,
	`before` text,
	`after` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`read_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `quiz_game_organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "moderation_action" CHECK("quiz_game_moderation_events"."action" IN ('add','change','revoke','inspect'))
);
--> statement-breakpoint
CREATE INDEX `d1_moderationEvents_1` ON `quiz_game_moderation_events` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `quiz_game_moderation_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`operator_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`details` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `quiz_game_organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_game_moderation_sanctions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`instance_id` text,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`restrictions` text NOT NULL,
	`reason` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `quiz_game_organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sanction_kind" CHECK("quiz_game_moderation_sanctions"."kind" IN ('timeout','ban','partial')),
	CONSTRAINT "sanction_scope" CHECK("quiz_game_moderation_sanctions"."instance_id" IS NOT NULL OR "quiz_game_moderation_sanctions"."kind" = 'ban'),
	CONSTRAINT "sanction_expiry" CHECK(("quiz_game_moderation_sanctions"."kind" = 'timeout') = ("quiz_game_moderation_sanctions"."expires_at" IS NOT NULL)),
	CONSTRAINT "sanction_revision" CHECK("quiz_game_moderation_sanctions"."revision" > 0)
);
--> statement-breakpoint
CREATE INDEX `d1_moderationSanctions_1` ON `quiz_game_moderation_sanctions` (`actor_id`,`instance_id`);--> statement-breakpoint
CREATE TABLE `quiz_game_organization_accounts` (
	`organization_id` text NOT NULL,
	`subject` text NOT NULL,
	`actor_id` text PRIMARY KEY NOT NULL,
	`administrator` integer DEFAULT false NOT NULL,
	`display_name` text,
	`profile_revision` integer DEFAULT 0 NOT NULL,
	`withdrawn_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `quiz_game_organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "profile_revision_valid" CHECK("quiz_game_organization_accounts"."profile_revision" >= 0),
	CONSTRAINT "account_subject_length" CHECK(length(trim("quiz_game_organization_accounts"."subject")) BETWEEN 1 AND 256),
	CONSTRAINT "account_actor_hash" CHECK((length("quiz_game_organization_accounts"."actor_id") = 64 AND "quiz_game_organization_accounts"."actor_id" NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `d1_organizationAccounts_1` ON `quiz_game_organization_accounts` (`organization_id`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_display_name_unique` ON `quiz_game_organization_accounts` (`organization_id`,`display_name`);--> statement-breakpoint
CREATE TABLE `quiz_game_organization_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`instance_id` text,
	`action` text NOT NULL,
	`occurred_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`details` text NOT NULL,
	CONSTRAINT "organization_event_actor_hash" CHECK((length("quiz_game_organization_events"."actor_id") = 64 AND "quiz_game_organization_events"."actor_id" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "organization_event_action" CHECK("quiz_game_organization_events"."action" IN ('setup', 'add', 'publish', 'rename', 'grants'))
);
--> statement-breakpoint
CREATE INDEX `d1_organizationEvents_1` ON `quiz_game_organization_events` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `quiz_game_organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton` integer DEFAULT true NOT NULL,
	`name` text NOT NULL,
	`identity_namespace` text NOT NULL,
	`external_participation` text DEFAULT 'approved' NOT NULL,
	`federation_revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "one_organization" CHECK("quiz_game_organizations"."singleton" = true),
	CONSTRAINT "organization_name_length" CHECK(length(trim("quiz_game_organizations"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "organization_namespace_length" CHECK(length(trim("quiz_game_organizations"."identity_namespace")) BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_game_organizations_singleton_unique` ON `quiz_game_organizations` (`singleton`);--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_game_organizations_identity_namespace_unique` ON `quiz_game_organizations` (`identity_namespace`);--> statement-breakpoint
CREATE TABLE `quiz_game_personal_question_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`author_id` text NOT NULL,
	`name` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`questions` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `quiz_game_organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "personal_set_revision" CHECK("quiz_game_personal_question_sets"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `d1_personalQuestionSets_1` ON `quiz_game_personal_question_sets` (`organization_id`,`author_id`);--> statement-breakpoint
CREATE TABLE `quiz_probe_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quiz_game_question_authors` (
	`instance_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`retry_at` text,
	`revision` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`instance_id`, `actor_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_author_status" CHECK("quiz_game_question_authors"."status" IN ('pending','qualified','rejected','revoked'))
);
--> statement-breakpoint
CREATE TABLE `quiz_game_question_availability` (
	`owner` text NOT NULL,
	`question_id` text NOT NULL,
	`retired_at` text,
	PRIMARY KEY(`owner`, `question_id`),
	CONSTRAINT "question_availability_owner_check" CHECK((length(owner) >= 1) AND (length(owner) <= 256)),
	CONSTRAINT "question_availability_question_id_check" CHECK((length(question_id) BETWEEN 1 AND 64 AND question_id NOT GLOB '*[^a-zA-Z0-9_-]*'))
);
--> statement-breakpoint
CREATE TABLE `quiz_game_question_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`import_only` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `d1_questionCategories_1` ON `quiz_game_question_categories` (`instance_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `d1_questionCategories_2` ON `quiz_game_question_categories` (`instance_id`,`id`);--> statement-breakpoint
CREATE TABLE `quiz_game_question_difficulty` (
	`instance_id` text NOT NULL,
	`series_id` text NOT NULL,
	`generation` text NOT NULL,
	`current` integer NOT NULL,
	`fixed` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`last_day` text,
	`statistics_revision` integer DEFAULT 0 NOT NULL,
	`cursor` text,
	`stats` text DEFAULT '[]' NOT NULL,
	`reason` text DEFAULT '自己申告' NOT NULL,
	PRIMARY KEY(`instance_id`, `series_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_difficulty_range" CHECK("quiz_game_question_difficulty"."current" BETWEEN 0 AND 2)
);
--> statement-breakpoint
CREATE TABLE `quiz_game_question_imports` (
	`instance_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`hash` text NOT NULL,
	`ids` text NOT NULL,
	PRIMARY KEY(`instance_id`, `actor_id`, `request_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_game_question_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`message` text NOT NULL,
	`target` text,
	`read` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `d1_questionNotifications_1` ON `quiz_game_question_notifications` (`instance_id`,`actor_id`);--> statement-breakpoint
CREATE TABLE `quiz_game_question_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`question_id` text NOT NULL,
	`kind` text NOT NULL,
	`round` integer NOT NULL,
	`actor_id` text NOT NULL,
	`reason` text NOT NULL,
	`suggested_category` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_report_kind" CHECK("quiz_game_question_reports"."kind" IN ('defect','category'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `d1_questionReports_1` ON `quiz_game_question_reports` (`instance_id`,`question_id`,`kind`,`round`,`actor_id`);--> statement-breakpoint
CREATE TABLE `quiz_game_question_review_cases` (
	`instance_id` text NOT NULL,
	`question_id` text NOT NULL,
	`kind` text NOT NULL,
	`round` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`resolved_at` text,
	PRIMARY KEY(`instance_id`, `question_id`, `kind`, `round`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "review_case_kind" CHECK("quiz_game_question_review_cases"."kind" IN ('defect','category'))
);
--> statement-breakpoint
CREATE TABLE `quiz_game_question_set_items` (
	`owner` text NOT NULL,
	`set_id` text NOT NULL,
	`set_version` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`question_id` text NOT NULL,
	`question_version` integer NOT NULL,
	PRIMARY KEY(`owner`, `set_id`, `set_version`, `ordinal`),
	FOREIGN KEY (`owner`,`question_id`,`question_version`) REFERENCES `quiz_game_question_versions`(`owner`,`question_id`,`version`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner`,`set_id`,`set_version`) REFERENCES `quiz_game_question_sets`(`owner`,`set_id`,`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_set_items_ordinal_check" CHECK((ordinal >= 1) AND (ordinal <= 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_set_items_owner_set_id_set_version_question_id_key` ON `quiz_game_question_set_items` (`owner`,`set_id`,`set_version`,`question_id`);--> statement-breakpoint
CREATE TABLE `quiz_game_question_sets` (
	`owner` text NOT NULL,
	`set_id` text NOT NULL,
	`version` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`selection` text,
	PRIMARY KEY(`owner`, `set_id`, `version`),
	CONSTRAINT "question_sets_manifest_hash_check" CHECK((length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "question_sets_owner_check" CHECK((length(owner) >= 1) AND (length(owner) <= 256)),
	CONSTRAINT "question_sets_set_id_check" CHECK((length(set_id) BETWEEN 1 AND 64 AND set_id NOT GLOB '*[^a-zA-Z0-9_-]*')),
	CONSTRAINT "question_sets_version_check" CHECK(version > 0)
);
--> statement-breakpoint
CREATE TABLE `quiz_game_question_settings` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`config` text NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_settings_revision" CHECK("quiz_game_question_settings"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `quiz_game_question_submission_events` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`revision` integer NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`input` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `quiz_game_question_submissions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `d1_questionSubmissionEvents_1` ON `quiz_game_question_submission_events` (`submission_id`,`revision`);--> statement-breakpoint
CREATE TABLE `quiz_game_question_submissions` (
	`author_name` text DEFAULT '作問者' NOT NULL,
	`provenance` text,
	`deleted_at` text,
	`review_hold` integer DEFAULT false NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`series_id` text NOT NULL,
	`author_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`input` text NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`published_id` text,
	`stopped` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_submission_revision" CHECK("quiz_game_question_submissions"."revision" > 0),
	CONSTRAINT "question_submission_status" CHECK("quiz_game_question_submissions"."status" IN ('draft','pending','returned','approved','rejected','ended'))
);
--> statement-breakpoint
CREATE INDEX `d1_questionSubmissions_1` ON `quiz_game_question_submissions` (`instance_id`,`author_id`);--> statement-breakpoint
CREATE INDEX `d1_questionSubmissions_2` ON `quiz_game_question_submissions` (`instance_id`,`status`);--> statement-breakpoint
CREATE TABLE `quiz_game_question_tags` (
	`instance_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`instance_id`, `key`),
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_game_question_versions` (
	`owner` text NOT NULL,
	`question_id` text NOT NULL,
	`version` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`owner`, `question_id`, `version`),
	CONSTRAINT "question_versions_check" CHECK((json_type(payload) = 'object') AND (length(CAST(payload AS BLOB)) <= 16384) AND ((payload ->> 'id') = question_id) AND (CAST(payload ->> 'version' AS INTEGER) = version) AND (json_type(payload, '$.id') IS NOT NULL) AND (json_type(payload, '$.version') IS NOT NULL)),
	CONSTRAINT "question_versions_owner_check" CHECK((length(owner) >= 1) AND (length(owner) <= 256)),
	CONSTRAINT "question_versions_question_id_check" CHECK((length(question_id) BETWEEN 1 AND 64 AND question_id NOT GLOB '*[^a-zA-Z0-9_-]*')),
	CONSTRAINT "question_versions_version_check" CHECK(version = 1)
);
--> statement-breakpoint
CREATE TABLE `quiz_game_result_outbox` (
	`match_id` text PRIMARY KEY NOT NULL,
	`payload_hash` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `quiz_game_matches`(`match_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_game_result_players` (
	`match_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`name` text NOT NULL,
	`rating_delta` integer NOT NULL,
	PRIMARY KEY(`match_id`, `actor_id`),
	FOREIGN KEY (`match_id`) REFERENCES `quiz_game_matches`(`match_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "result_players_delta" CHECK("quiz_game_result_players"."rating_delta" IN (-20, 0, 20))
);
--> statement-breakpoint
CREATE INDEX `d1_resultPlayers_1` ON `quiz_game_result_players` (`actor_id`);--> statement-breakpoint
CREATE TABLE `quiz_game_result_privacy_changes` (
	`match_id` text PRIMARY KEY NOT NULL,
	`previous_hash` text NOT NULL,
	`payload_hash` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `quiz_game_matches`(`match_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_game_result_privacy_jobs` (
	`match_id` text PRIMARY KEY NOT NULL,
	`due_at` text NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `quiz_game_matches`(`match_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `result_privacy_due` ON `quiz_game_result_privacy_jobs` (`due_at`,`match_id`);--> statement-breakpoint
CREATE TABLE `quiz_game_room_directory` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`public` integer NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `d1_roomDirectory_1` ON `quiz_game_room_directory` (`instance_id`,`public`,`closed`);--> statement-breakpoint
CREATE TABLE `quiz_game_room_inventory_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_ids` text NOT NULL,
	`cursor` text,
	`complete` integer DEFAULT false NOT NULL,
	`local_hash` text
);
--> statement-breakpoint
CREATE TABLE `quiz_game_ruleset_versions` (
	`owner` text NOT NULL,
	`ruleset_id` text NOT NULL,
	`version` integer NOT NULL,
	`rules_hash` text NOT NULL,
	`config` text NOT NULL,
	PRIMARY KEY(`owner`, `ruleset_id`, `version`),
	CONSTRAINT "ruleset_versions_config_check" CHECK((json_type(config) = 'object') AND (length(CAST(config AS BLOB)) <= 4096)),
	CONSTRAINT "ruleset_versions_owner_check" CHECK((length(owner) >= 1) AND (length(owner) <= 256)),
	CONSTRAINT "ruleset_versions_rules_hash_check" CHECK((length(rules_hash) = 64 AND rules_hash NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "ruleset_versions_ruleset_id_check" CHECK((length(ruleset_id) BETWEEN 1 AND 64 AND ruleset_id NOT GLOB '*[^a-zA-Z0-9_-]*')),
	CONSTRAINT "ruleset_versions_version_check" CHECK(version > 0)
);
--> statement-breakpoint
CREATE TABLE `quiz_game_sanction_appeals` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`sanction_id` text NOT NULL,
	`sanction_revision` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`resolved_at` text,
	`operator_id` text,
	`resolution` text,
	`decision` text,
	`read_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `quiz_game_organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sanction_id`) REFERENCES `quiz_game_moderation_sanctions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "appeal_reason" CHECK(length(trim("quiz_game_sanction_appeals"."reason")) BETWEEN 1 AND 1000),
	CONSTRAINT "appeal_revision" CHECK("quiz_game_sanction_appeals"."sanction_revision" > 0),
	CONSTRAINT "appeal_decision" CHECK("quiz_game_sanction_appeals"."decision" IS NULL OR "quiz_game_sanction_appeals"."decision" IN ('maintain','revoke')),
	CONSTRAINT "appeal_resolution" CHECK(("quiz_game_sanction_appeals"."resolved_at" IS NULL AND "quiz_game_sanction_appeals"."operator_id" IS NULL AND "quiz_game_sanction_appeals"."resolution" IS NULL AND "quiz_game_sanction_appeals"."decision" IS NULL) OR ("quiz_game_sanction_appeals"."resolved_at" IS NOT NULL AND "quiz_game_sanction_appeals"."operator_id" IS NOT NULL AND "quiz_game_sanction_appeals"."decision" IS NOT NULL AND "quiz_game_sanction_appeals"."resolution" IS NOT NULL AND length(trim("quiz_game_sanction_appeals"."resolution")) BETWEEN 1 AND 1000))
);
--> statement-breakpoint
CREATE INDEX `d1_sanctionAppeals_1` ON `quiz_game_sanction_appeals` (`actor_id`,`resolved_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `d1_sanctionAppeals_2` ON `quiz_game_sanction_appeals` (`sanction_id`) WHERE "quiz_game_sanction_appeals"."resolved_at" IS NULL;--> statement-breakpoint
CREATE TABLE `quiz_game_user_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`reporter_id` text NOT NULL,
	`match_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`resolved_at` text,
	`operator_id` text,
	`resolution` text,
	FOREIGN KEY (`organization_id`) REFERENCES `quiz_game_organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instance_id`) REFERENCES `quiz_game_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `quiz_game_organization_accounts`(`actor_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_report_other" CHECK("quiz_game_user_reports"."actor_id" <> "quiz_game_user_reports"."reporter_id"),
	CONSTRAINT "user_report_resolution" CHECK(("quiz_game_user_reports"."resolved_at" IS NULL AND "quiz_game_user_reports"."operator_id" IS NULL AND "quiz_game_user_reports"."resolution" IS NULL) OR ("quiz_game_user_reports"."resolved_at" IS NOT NULL AND "quiz_game_user_reports"."operator_id" IS NOT NULL AND "quiz_game_user_reports"."resolution" IS NOT NULL AND length(trim("quiz_game_user_reports"."resolution")) BETWEEN 1 AND 1000)),
	CONSTRAINT "user_report_reason" CHECK(length(trim("quiz_game_user_reports"."reason")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE INDEX `d1_userReports_1` ON `quiz_game_user_reports` (`instance_id`,`actor_id`,`resolved_at`);