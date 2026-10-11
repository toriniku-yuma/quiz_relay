-- Custom SQL migration file, put your code below! --
-- Public information and approved key history are append-only originals.
create trigger information_entry_update before update on quiz_information_entries BEGIN select raise(abort, 'IMMUTABLE_INFORMATION'); END;
--> statement-breakpoint
create trigger information_entry_delete before delete on quiz_information_entries when not exists(select 1 from quiz_game_instance_deletions job join quiz_game_instances scope on scope.id=job.instance_id where job.instance_id=OLD.instance_id and job.organization_id=scope.organization_id and job.owner=scope.owner and job.name=scope.name and job.accepted_at is not null and scope.state='archived' and scope.room_inventory_complete=1) BEGIN select raise(abort, 'IMMUTABLE_INFORMATION'); END;
--> statement-breakpoint
create trigger federation_peer_key_update before update on quiz_federation_peer_keys BEGIN select raise(abort, 'IMMUTABLE_PEER_KEY'); END;
--> statement-breakpoint
create trigger federation_peer_key_delete before delete on quiz_federation_peer_keys BEGIN select raise(abort, 'IMMUTABLE_PEER_KEY'); END;
--> statement-breakpoint
insert into quiz_federation_metadata_jobs(instance_id,peer_origin,next_attempt_at) select instance_id,peer_origin,last_success_at+60000 from quiz_federation_metadata where 1 on conflict(instance_id,peer_origin) do nothing;
