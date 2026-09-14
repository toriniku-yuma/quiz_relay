create function quiz_game.reject_version_change() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'IMMUTABLE_VERSION';
end;
$$;
--> statement-breakpoint

revoke all on function quiz_game.reject_version_change() from public, anon, authenticated;
--> statement-breakpoint

create trigger immutable_question before update or delete on quiz_game.question_versions
  for each row execute function quiz_game.reject_version_change();
--> statement-breakpoint
create trigger immutable_item before update or delete on quiz_game.question_set_items
  for each row execute function quiz_game.reject_version_change();
--> statement-breakpoint
create trigger immutable_rules before update or delete on quiz_game.ruleset_versions
  for each row execute function quiz_game.reject_version_change();
--> statement-breakpoint
create trigger immutable_set before update or delete on quiz_game.question_sets
  for each row execute function quiz_game.reject_version_change();
--> statement-breakpoint
create trigger immutable_competition before update or delete on quiz_game.competitions
  for each row execute function quiz_game.reject_version_change();
--> statement-breakpoint

revoke all on schema quiz_game, quiz_probe from public, anon, authenticated;
--> statement-breakpoint
grant usage on schema quiz_game to quiz_game_reader;
--> statement-breakpoint
grant usage on schema quiz_probe to quiz_probe;
--> statement-breakpoint
revoke all on all tables in schema quiz_game, quiz_probe from public, anon, authenticated;
--> statement-breakpoint
grant select on all tables in schema quiz_game to quiz_game_reader;
--> statement-breakpoint
grant select, insert, delete on quiz_probe.runs to quiz_probe;
--> statement-breakpoint
