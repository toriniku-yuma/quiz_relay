CREATE TRIGGER difficulty_trial_append AFTER INSERT ON quiz_game_difficulty_trials BEGIN
  INSERT INTO quiz_game_difficulty_samples(owner,generation,band,players,rules_hash,band_revision,trials,correct)
    VALUES(NEW.owner,NEW.generation,NEW.band,NEW.players,NEW.rules_hash,NEW.band_revision,1,NEW.correct)
    ON CONFLICT(owner,generation,band,players,rules_hash,band_revision) DO UPDATE SET trials=trials+1,correct=correct+NEW.correct;
  INSERT INTO quiz_game_difficulty_actors(owner,generation,band,players,rules_hash,band_revision,actor_id)
    SELECT NEW.owner,NEW.generation,NEW.band,NEW.players,NEW.rules_hash,NEW.band_revision,value FROM json_each(NEW.actors) WHERE 1
    ON CONFLICT DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER difficulty_trial_immutable BEFORE UPDATE ON quiz_game_difficulty_trials BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DIFFICULTY_TRIAL'); END;
