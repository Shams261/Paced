-- S3-006 slice C: read-only backup role, backup log, identity export, deletion cutoff and restore helpers.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sequence_backup') THEN
  CREATE ROLE sequence_backup NOLOGIN NOINHERIT NOBYPASSRLS;
 END IF;
END $$;
GRANT sequence_backup TO postgres;
GRANT USAGE ON SCHEMA public, sequence_private, sequence_meta TO sequence_backup;

CREATE TABLE sequence_private.backup_log (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('backup','restore-drill')),
 completed_at timestamptz NOT NULL DEFAULT now(),
 object_key text NOT NULL CHECK(length(object_key) BETWEEN 1 AND 200),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes bigint NOT NULL CHECK(size_bytes>=0),
 migration_version text NOT NULL CHECK(length(migration_version) BETWEEN 1 AND 100),
 details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object'),
 database_principal text NOT NULL DEFAULT session_user);
ALTER TABLE sequence_private.backup_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.backup_log FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_auth_runtime,sequence_backup;

-- The backup role reads only the tables that belong in a backup. Sessions, login transactions and
-- rate-limit counters are technical state that is never backed up and never granted.
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT format('%I.%I',n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='r' AND ((n.nspname='public' AND c.relname LIKE 'seq\_%')
   OR (n.nspname='sequence_private' AND c.relname NOT IN ('auth_sessions','login_transactions','auth_rate_limits')))
 LOOP
  EXECUTE format('GRANT SELECT ON %s TO sequence_backup',t);
  EXECUTE format('CREATE POLICY backup_read ON %s FOR SELECT TO sequence_backup USING (true)',t);
 END LOOP;
END $$;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA sequence_private TO sequence_backup;
GRANT SELECT ON sequence_meta.migrations, sequence_meta.environment TO sequence_backup;

-- Minimal identity rows needed to relink admission after a restore; no password hashes or tokens.
CREATE FUNCTION sequence_private.backup_identities() RETURNS TABLE(user_id uuid, email text, email_confirmed boolean, admitted boolean, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT u.id, u.email::text, u.email_confirmed_at IS NOT NULL, coalesce(a.active,false), u.created_at
 FROM auth.users u LEFT JOIN sequence_private.access_allowlist a ON a.user_id=u.id
 WHERE a.user_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.seq_workspaces w WHERE w.owner_id=u.id)
 ORDER BY u.created_at, u.id;
$$;
REVOKE ALL ON FUNCTION sequence_private.backup_identities() FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_auth_runtime;
GRANT EXECUTE ON FUNCTION sequence_private.backup_identities() TO sequence_backup;

CREATE FUNCTION sequence_private.backup_record(entry jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE new_id bigint;
BEGIN
 IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR entry-ARRAY['kind','objectKey','sha256','sizeBytes','migrationVersion','details'] <> '{}'
  OR coalesce(entry->>'kind','') NOT IN ('backup','restore-drill') OR jsonb_typeof(entry->'sizeBytes') IS DISTINCT FROM 'number'
  OR (entry ? 'details' AND jsonb_typeof(entry->'details') IS DISTINCT FROM 'object') THEN
  RAISE EXCEPTION 'Invalid backup record' USING ERRCODE='22023'; END IF;
 INSERT INTO sequence_private.backup_log(kind,object_key,sha256,size_bytes,migration_version,details)
 VALUES(entry->>'kind',entry->>'objectKey',entry->>'sha256',(entry->>'sizeBytes')::bigint,entry->>'migrationVersion',coalesce(entry->'details','{}'::jsonb))
 RETURNING id INTO new_id;
 RETURN new_id;
END $$;
REVOKE ALL ON FUNCTION sequence_private.backup_record(jsonb) FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_auth_runtime;
GRANT EXECUTE ON FUNCTION sequence_private.backup_record(jsonb) TO sequence_backup;

-- Operator-only restore helpers. The ledger is applied before any access; everything restarts held.
CREATE FUNCTION sequence_private.apply_deletion_ledger(entries jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb; w uuid; u uuid; applied integer := 0;
BEGIN
 IF jsonb_typeof(entries) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid ledger' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(entries) LOOP
  w := (item->>'workspaceId')::uuid; u := (item->>'userId')::uuid;
  IF w IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Invalid ledger entry' USING ERRCODE='22023'; END IF;
  UPDATE sequence_private.access_allowlist SET active=false WHERE user_id=u;
  DELETE FROM sequence_private.management_requests WHERE workspace_id=w;
  DELETE FROM sequence_private.send_reservations WHERE workspace_id=w;
  DELETE FROM sequence_private.attempt_results WHERE workspace_id=w;
  DELETE FROM sequence_private.attempts WHERE workspace_id=w;
  DELETE FROM sequence_private.execution_leases WHERE workspace_id=w;
  DELETE FROM sequence_private.account_execution_state WHERE workspace_id=w;
  DELETE FROM sequence_private.logical_actions WHERE workspace_id=w;
  DELETE FROM sequence_private.enrollments WHERE workspace_id=w;
  DELETE FROM sequence_private.observations WHERE workspace_id=w;
  DELETE FROM sequence_private.approval_recipients WHERE workspace_id=w;
  DELETE FROM sequence_private.approvals WHERE workspace_id=w;
  DELETE FROM sequence_private.content_revisions WHERE workspace_id=w;
  DELETE FROM public.seq_list_memberships WHERE workspace_id=w;
  DELETE FROM public.seq_campaigns WHERE workspace_id=w;
  DELETE FROM public.seq_lists WHERE workspace_id=w;
  DELETE FROM public.seq_prospects WHERE workspace_id=w;
  DELETE FROM public.seq_accounts WHERE workspace_id=w;
  DELETE FROM public.seq_workspaces WHERE id=w;
  INSERT INTO sequence_private.deletion_tombstones(workspace_id,user_id,request_id,deleted_at,backup_cutoff,result)
  VALUES(w,u,coalesce((item->>'requestId')::uuid,gen_random_uuid()),coalesce((item->>'deletedAt')::timestamptz,now()),(item->>'backupCutoff')::timestamptz,
   jsonb_build_object('deleted',true,'workspaceId',w,'source','ledger'))
  ON CONFLICT(workspace_id) DO NOTHING;
  applied := applied+1;
 END LOOP;
 RETURN applied;
END $$;
REVOKE ALL ON FUNCTION sequence_private.apply_deletion_ledger(jsonb) FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_auth_runtime,sequence_backup;

CREATE FUNCTION sequence_private.restore_finalize(details jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE held integer; cancelled integer; revoked integer;
BEGIN
 IF jsonb_typeof(details) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid restore details' USING ERRCODE='22023'; END IF;
 -- Restoring a queue is never permission to replay it: hold every nonterminal sequence for reconciliation.
 UPDATE sequence_private.enrollments SET status='Held',stop_reason='restore-reconciliation',revision=revision+1 WHERE status IN ('Active','Waiting','Paused','Held');
 GET DIAGNOSTICS held = ROW_COUNT;
 UPDATE sequence_private.logical_actions SET state='Cancelled',revision=revision+1 WHERE state NOT IN ('ConfirmedSent','MayHaveSent','OutcomeUnknown','Skipped','Cancelled');
 GET DIAGNOSTICS cancelled = ROW_COUNT;
 UPDATE sequence_private.account_execution_state SET fence=fence+1,lease_executor=NULL,lease_expires_at=NULL;
 UPDATE sequence_private.auth_sessions SET revoked_at=coalesce(revoked_at,now()),sealed_tokens='{}',refresh_owner=NULL,refresh_until=NULL WHERE revoked_at IS NULL;
 GET DIAGNOSTICS revoked = ROW_COUNT;
 RETURN jsonb_build_object('heldEnrollments',held,'cancelledActions',cancelled,'revokedSessions',revoked,'finalizedAt',now());
END $$;
REVOKE ALL ON FUNCTION sequence_private.restore_finalize(jsonb) FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_auth_runtime,sequence_backup;

-- Deletion now records the latest backup cutoff so the ledger can name which backups still hold the data.
CREATE OR REPLACE FUNCTION public.seq_delete_workspace(args jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid; w uuid; req uuid; t sequence_private.deletion_tombstones%ROWTYPE; sid uuid; created timestamptz;
 unresolved integer; removed jsonb; result jsonb; cutoff timestamptz;
BEGIN
 u := auth.uid();
 IF u IS NULL THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(args) IS DISTINCT FROM 'object' OR args-ARRAY['requestId','confirmation'] <> '{}'
  OR coalesce(args->>'requestId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RAISE EXCEPTION 'Invalid deletion request' USING ERRCODE='22023'; END IF;
 req := (args->>'requestId')::uuid;
 SELECT * INTO t FROM sequence_private.deletion_tombstones WHERE user_id=u AND request_id=req;
 IF FOUND THEN RETURN t.result; END IF;
 SELECT id INTO w FROM public.seq_workspaces WHERE owner_id=u;
 IF w IS NULL OR NOT sequence_private.owns_workspace(w) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.seq_workspaces WHERE id=w FOR UPDATE;
 IF NOT sequence_private.owns_workspace(w) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 IF args->>'confirmation' IS DISTINCT FROM 'DELETE MY WORKSPACE' THEN RAISE EXCEPTION 'Confirmation mismatch' USING ERRCODE='22023'; END IF;
 -- Reauthentication: the provider session must come from a sign-in within the last five minutes.
 sid := (auth.jwt()->>'session_id')::uuid;
 SELECT p.created_at INTO created FROM auth.sessions p WHERE p.id=sid AND p.user_id=u;
 IF created IS NULL OR created<now()-interval '5 minutes' THEN RAISE EXCEPTION 'Fresh sign-in required' USING ERRCODE='28000'; END IF;
 unresolved := (SELECT count(*) FROM sequence_private.send_reservations WHERE workspace_id=w AND resolved_at IS NULL);
 cutoff := (SELECT max(completed_at) FROM sequence_private.backup_log WHERE kind='backup');
 removed := jsonb_build_object(
  'prospects',(SELECT count(*) FROM public.seq_prospects WHERE workspace_id=w),
  'lists',(SELECT count(*) FROM public.seq_lists WHERE workspace_id=w),
  'campaigns',(SELECT count(*) FROM public.seq_campaigns WHERE workspace_id=w),
  'approvals',(SELECT count(*) FROM sequence_private.approvals WHERE workspace_id=w),
  'enrollments',(SELECT count(*) FROM sequence_private.enrollments WHERE workspace_id=w),
  'actions',(SELECT count(*) FROM sequence_private.logical_actions WHERE workspace_id=w),
  'observations',(SELECT count(*) FROM sequence_private.observations WHERE workspace_id=w),
  'requests',(SELECT count(*) FROM sequence_private.management_requests WHERE workspace_id=w));
 -- Fence first: admission off revokes every application session through the existing trigger.
 UPDATE sequence_private.access_allowlist SET active=false WHERE user_id=u;
 DELETE FROM sequence_private.management_requests WHERE workspace_id=w;
 DELETE FROM sequence_private.send_reservations WHERE workspace_id=w;
 DELETE FROM sequence_private.attempt_results WHERE workspace_id=w;
 DELETE FROM sequence_private.attempts WHERE workspace_id=w;
 DELETE FROM sequence_private.execution_leases WHERE workspace_id=w;
 DELETE FROM sequence_private.account_execution_state WHERE workspace_id=w;
 DELETE FROM sequence_private.logical_actions WHERE workspace_id=w;
 DELETE FROM sequence_private.enrollments WHERE workspace_id=w;
 DELETE FROM sequence_private.observations WHERE workspace_id=w;
 DELETE FROM sequence_private.approval_recipients WHERE workspace_id=w;
 DELETE FROM sequence_private.approvals WHERE workspace_id=w;
 DELETE FROM sequence_private.content_revisions WHERE workspace_id=w;
 DELETE FROM public.seq_list_memberships WHERE workspace_id=w;
 DELETE FROM public.seq_campaigns WHERE workspace_id=w;
 DELETE FROM public.seq_lists WHERE workspace_id=w;
 DELETE FROM public.seq_prospects WHERE workspace_id=w;
 DELETE FROM public.seq_accounts WHERE workspace_id=w;
 DELETE FROM public.seq_workspaces WHERE id=w;
 result := jsonb_build_object('deleted',true,'workspaceId',w,'deletedAt',now(),'removed',removed,'unresolvedSends',unresolved,
  'backupCutoff',cutoff,'identityRemovalDueBy',now()+interval '7 days',
  'note','Product records are removed now. Your sign-in identity is removed by the operator within seven days. Deleting product records does not withdraw LinkedIn invitations or remove LinkedIn messages.');
 INSERT INTO sequence_private.deletion_tombstones(workspace_id,user_id,request_id,unresolved_sends,backup_cutoff,result) VALUES(w,u,req,unresolved,cutoff,result);
 RETURN result;
END $$;

-- Quota status reports recovery from the backup log.
CREATE OR REPLACE FUNCTION sequence_private.quota_status() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE db jsonb; rq jsonb; eg jsonb; reasons jsonb='[]'; recovery jsonb; last_backup timestamptz; last_drill timestamptz;
 pdb numeric; pdb_at timestamptz; prq numeric; prq_at timestamptz; peg numeric; peg_at timestamptz;
BEGIN
 SELECT value,read_at INTO pdb,pdb_at FROM sequence_private.provider_readings WHERE meter='database_bytes';
 SELECT value,read_at INTO prq,prq_at FROM sequence_private.provider_readings WHERE meter='requests_day';
 SELECT value,read_at INTO peg,peg_at FROM sequence_private.provider_readings WHERE meter='egress_month_bytes';
 db := sequence_private.meter('database_bytes',pg_database_size(current_database()),coalesce(pdb,0),pdb_at,524288000,'pg_database_size');
 rq := sequence_private.meter('requests_day',coalesce((SELECT requests FROM sequence_private.usage_counters WHERE day=current_date),0),coalesce(prq,0),prq_at,100000,'worker-self-count');
 eg := sequence_private.meter('egress_month_bytes',coalesce((SELECT sum(response_bytes) FROM sequence_private.usage_counters WHERE day>=date_trunc('month',current_date)),0),coalesce(peg,0),peg_at,5368709120,'worker-response-bytes-partial');
 IF db->>'state'='deny' THEN reasons := reasons || '"database-70-percent"'; END IF;
 IF rq->>'state'='deny' THEN reasons := reasons || '"requests-70-percent"'; END IF;
 IF eg->>'state'='deny' THEN reasons := reasons || '"egress-70-percent"'; END IF;
 IF NOT (eg->>'providerVerified')::boolean THEN reasons := reasons || '"egress-unverified"'; eg := eg || '{"state":"unverified"}'; END IF;
 -- Recovery state is reported, not a growth gate: a stale backup blocks admission and sends, which have no self-service flow yet.
 SELECT max(completed_at) INTO last_backup FROM sequence_private.backup_log WHERE kind='backup';
 SELECT max(completed_at) INTO last_drill FROM sequence_private.backup_log WHERE kind='restore-drill';
 recovery := jsonb_build_object('lastBackupAt',last_backup,'lastRestoreDrillAt',last_drill,
  'ageSeconds',CASE WHEN last_backup IS NULL THEN NULL ELSE floor(extract(epoch FROM now()-last_backup)) END,
  'state',CASE WHEN last_backup IS NULL THEN 'unverified' WHEN last_backup<now()-interval '24 hours' THEN 'degraded' ELSE 'ok' END,
  'note',CASE WHEN last_backup IS NULL THEN 'No backup has been recorded yet.' WHEN last_backup<now()-interval '24 hours' THEN 'The last backup is older than 24 hours; admission and sends stay blocked until a good backup exists.' ELSE 'A backup younger than 24 hours is recorded.' END);
 RETURN jsonb_build_object('checkedAt',now(),'sendingEnabled',false,'growthAllowed',jsonb_array_length(reasons)=0,'reasons',reasons,
  'meters',jsonb_build_array(db,rq,eg),
  'recovery',recovery);
END $$;
NOTIFY pgrst, 'reload schema';
