CREATE TABLE `quiz_database_revision` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "database_revision_singleton" CHECK("quiz_database_revision"."id" = 1)
);
--> statement-breakpoint
INSERT INTO `quiz_database_revision` (`id`, `revision`) VALUES (1, 0);
--> statement-breakpoint
CREATE TRIGGER `quiz_database_revision_guard`
BEFORE UPDATE ON `quiz_database_revision`
WHEN NEW.id <> OLD.id OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'STALE_D1_SNAPSHOT');
END;
