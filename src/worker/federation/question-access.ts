import { type SQLWrapper, sql } from 'drizzle-orm';
import { QUESTION_SYNC_FRESH_MS } from '../../shared/federation-questions.ts';
import {
  federationDeletedInstances,
  federationPeers,
  federationPolicies,
  federationQuestionImports,
  federationQuestionLinks,
  instances,
  questionSubmissions,
} from '../db/schema.ts';

// Resolve eligibility separately from immutable content. Existing DO matches keep
// their fixed definition; every new allocation/start evaluates current leases.
export function sharedQuestionAvailableSQL(
  owner: SQLWrapper,
  questionId: SQLWrapper,
  now = Date.now(),
) {
  return sql<number>`not exists (
    select 1 from ${federationQuestionLinks}
    join ${questionSubmissions} on ${questionSubmissions.id}=${federationQuestionLinks.submissionId}
    join ${instances} on ${instances.id}=${federationQuestionLinks.instanceId}
    join ${federationQuestionImports} on ${federationQuestionImports.id}=${federationQuestionLinks.importId}
    left join ${federationPeers} on ${federationPeers.origin}=${federationQuestionLinks.peerOrigin}
    left join ${federationPolicies} on ${federationPolicies.instanceId}=${federationQuestionLinks.instanceId} and ${federationPolicies.peerOrigin}=${federationQuestionLinks.peerOrigin} and ${federationPolicies.peerInstanceId}=${federationQuestionLinks.sourceInstanceId}
    where ${instances.owner}=${owner} and ${questionSubmissions.publishedId}=${questionId}
      and (${federationQuestionLinks.excluded}=1 or ${federationQuestionImports.enabled}=0
        or ${federationQuestionLinks.cachePurgedAt} is not null
        or coalesce(${federationQuestionImports.activeSnapshot},'')<>${federationQuestionLinks.seenSnapshot}
        or ${federationQuestionImports.errorCode} is not null
        or ${federationQuestionImports.lastSuccessAt}<=${now - QUESTION_SYNC_FRESH_MS}
        or coalesce(${federationPeers.approved},0)=0
        or coalesce(json_extract(${federationPolicies.permissions},'$.receive.questions'),0)=0
        or (${questionSubmissions.authorId}=${federationQuestionLinks.sourceAuthorId} and not exists (
          select 1 from quiz_game_question_submissions original
          join quiz_game_instances source on source.id=original.instance_id and source.state='published'
          join quiz_game_question_availability available on available.owner=source.owner and available.question_id=original.published_id and available.retired_at is null
          join quiz_game_question_versions version on version.owner=source.owner and version.question_id=original.published_id
          join quiz_game_question_categories category on category.id=json_extract(version.payload,'$.categoryId') and category.active=1
          join quiz_federation_policies outbound on outbound.instance_id=source.id and outbound.peer_origin=${federationQuestionLinks.peerOrigin} and outbound.peer_instance_id=${federationQuestionLinks.instanceId}
          where source.id=${federationQuestionLinks.sourceInstanceId} and original.series_id=${federationQuestionLinks.sourceSeriesId} and original.published_id=${federationQuestionLinks.sourceQuestionId}
            and original.deleted_at is null and category.import_only=0 and json_extract(outbound.permissions,'$.send.questions')=1
        ))
        or exists(select 1 from ${federationDeletedInstances} where ${federationDeletedInstances.peerOrigin}=${federationQuestionLinks.peerOrigin} and ${federationDeletedInstances.instanceId}=${federationQuestionLinks.sourceInstanceId}))
  )`.mapWith(Number);
}
