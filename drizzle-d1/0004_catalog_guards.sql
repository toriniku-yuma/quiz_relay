-- Custom SQL migration file, put your code below! --
-- Catalog originals stay immutable during cutover. Instance deletion and physical
-- author-name erasure require controlled batches before selecting this runtime.
CREATE TRIGGER d1_question_version_update BEFORE UPDATE ON quiz_game_question_versions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_question_version_delete BEFORE DELETE ON quiz_game_question_versions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_question_set_update BEFORE UPDATE ON quiz_game_question_sets
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_question_set_delete BEFORE DELETE ON quiz_game_question_sets
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_question_set_item_update BEFORE UPDATE ON quiz_game_question_set_items
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_question_set_item_delete BEFORE DELETE ON quiz_game_question_set_items
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_ruleset_update BEFORE UPDATE ON quiz_game_ruleset_versions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_ruleset_delete BEFORE DELETE ON quiz_game_ruleset_versions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_competition_update BEFORE UPDATE ON quiz_game_competitions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_competition_delete BEFORE DELETE ON quiz_game_competitions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
