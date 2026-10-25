-- S3-006 slices A, B, D: export, authenticated deletion, quota meters. No dispatch authority.

-- D: Worker self-counted usage and operator-entered provider readings.
CREATE TABLE sequence_private.usage_counters (
 day date PRIMARY KEY, requests bigint NOT NULL DEFAULT 0 CHECK(requests>=0),
 response_bytes bigint NOT NULL DEFAULT 0 CHECK(response_bytes>=0),
 updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sequence_private.provider_readings (
 meter text PRIMARY KEY CHECK(meter IN ('database_bytes','requests_day','egress_month_bytes')),
 value numeric NOT NULL CHECK(value>=0), read_at timestamptz NOT NULL DEFAULT now(),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=200));
ALTER TABLE sequence_private.usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_private.provider_readings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.usage_counters,sequence_private.provider_readings FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_auth_runtime;

CREATE FUNCTION sequence_private.usage_record(bytes bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF bytes IS NULL OR bytes<0 OR bytes>1073741824 THEN RAISE EXCEPTION 'Invalid usage' USING ERRCODE='22023'; END IF;
 INSERT INTO sequence_private.usage_counters(day,requests,response_bytes) VALUES(current_date,1,bytes)
 ON CONFLICT(day) DO UPDATE SET requests=usage_counters.requests+1,
  response_bytes=usage_counters.response_bytes+excluded.response_bytes,updated_at=now();
END $$;
REVOKE ALL ON FUNCTION sequence_private.usage_record(bigint) FROM PUBLIC,anon,authenticated,service_role,sequence_worker;
GRANT EXECUTE ON FUNCTION sequence_private.usage_record(bigint) TO sequence_auth_runtime;

CREATE FUNCTION sequence_private.meter(name text, measured numeric, provider numeric, provider_at timestamptz, limit_value numeric, source text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE value numeric; pct numeric; state text; verified boolean;
BEGIN
 verified := provider_at IS NOT NULL AND provider_at>now()-interval '7 days';
 value := CASE WHEN verified THEN greatest(measured,provider) ELSE measured END;
 pct := round(value*100/limit_value,1);
 state := CASE WHEN pct>=70 THEN 'deny' WHEN pct>=60 THEN 'warn' ELSE 'ok' END;
 RETURN jsonb_build_object('name',name,'value',value,'limit',limit_value,'percent',pct,'state',state,
  'measuredAt',now(),'source',source,'providerReadingAt',provider_at,'providerVerified',verified);
END $$;
REVOKE ALL ON FUNCTION sequence_private.meter(text,numeric,numeric,timestamptz,numeric,text) FROM PUBLIC;

-- Computed at check time: self-measured values are never older than the check itself.
CREATE FUNCTION sequence_private.quota_status() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE db jsonb; rq jsonb; eg jsonb; reasons jsonb='[]'; pr sequence_private.provider_readings%ROWTYPE;
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
 RETURN jsonb_build_object('checkedAt',now(),'sendingEnabled',false,'growthAllowed',jsonb_array_length(reasons)=0,'reasons',reasons,
  'meters',jsonb_build_array(db,rq,eg),
  'recovery',jsonb_build_object('state','unverified','note','No backup has been recorded yet; backup and restore are later slices.'));
END $$;
REVOKE ALL ON FUNCTION sequence_private.quota_status() FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_auth_runtime;

-- A: tenant-scoped export pages. Read-only; the Worker streams each page unparsed.
CREATE FUNCTION public.seq_export(section text, page integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid; lim constant integer := 500; off integer; result jsonb;
BEGIN
 SELECT id INTO w FROM public.seq_workspaces WHERE owner_id=auth.uid();
 IF w IS NULL OR NOT sequence_private.owns_workspace(w) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 IF page IS NULL OR page<0 OR page>1000 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 off := page*lim;
 CASE section
 WHEN 'manifest' THEN
  RETURN jsonb_build_object('formatVersion','sequence-export-1','workspaceId',w,'generatedAt',now(),'pageSize',lim,'sendingEnabled',false,
   'counts',jsonb_build_object(
    'accounts',(SELECT count(*) FROM public.seq_accounts WHERE workspace_id=w),
    'prospects',(SELECT count(*) FROM public.seq_prospects WHERE workspace_id=w),
    'lists',(SELECT count(*) FROM public.seq_lists WHERE workspace_id=w),
    'memberships',(SELECT count(*) FROM public.seq_list_memberships WHERE workspace_id=w),
    'campaigns',(SELECT count(*) FROM public.seq_campaigns WHERE workspace_id=w),
    'revisions',(SELECT count(*) FROM sequence_private.content_revisions WHERE workspace_id=w),
    'approvals',(SELECT count(*) FROM sequence_private.approvals WHERE workspace_id=w),
    'approvalRecipients',(SELECT count(*) FROM sequence_private.approval_recipients WHERE workspace_id=w),
    'enrollments',(SELECT count(*) FROM sequence_private.enrollments WHERE workspace_id=w),
    'actions',(SELECT count(*) FROM sequence_private.logical_actions WHERE workspace_id=w),
    'attempts',(SELECT count(*) FROM sequence_private.attempts WHERE workspace_id=w),
    'results',(SELECT count(*) FROM sequence_private.attempt_results WHERE workspace_id=w),
    'observations',(SELECT count(*) FROM sequence_private.observations WHERE workspace_id=w),
    'reservations',(SELECT count(*) FROM sequence_private.send_reservations WHERE workspace_id=w)));
 WHEN 'accounts' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,external_identity,identity_verified_at,timezone,revision,sending_enabled FROM public.seq_accounts WHERE workspace_id=w ORDER BY id LIMIT lim OFFSET off) x;
 WHEN 'prospects' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,account_id,recipient_key,display_name,role_title,company,source,observed_at,connection,revision,created_at FROM public.seq_prospects WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 WHEN 'lists' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,account_id,name,created_at FROM public.seq_lists WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 WHEN 'memberships' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,list_id,prospect_id,created_at FROM public.seq_list_memberships WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 WHEN 'campaigns' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,account_id,name,status,revision,created_at FROM public.seq_campaigns WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 WHEN 'revisions' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,campaign_id,revision,invitation_note,first_message,followups,settings,created_at FROM sequence_private.content_revisions WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 WHEN 'approvals' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,campaign_id,content_revision_id,approved_at,settings_revision FROM sequence_private.approvals WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 WHEN 'approvalRecipients' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,approval_id,prospect_id,rendered_content,created_at FROM sequence_private.approval_recipients WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 WHEN 'enrollments' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,campaign_id,prospect_id,content_revision_id,approval_id,baseline_observation_id,status,stop_reason,revision,created_at FROM sequence_private.enrollments WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 WHEN 'actions' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,enrollment_id,content_revision_id,step,kind,due_at,state,revision,created_at FROM sequence_private.logical_actions WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 WHEN 'attempts' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,action_id,attempt_number,created_at FROM sequence_private.attempts WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 WHEN 'results' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,action_id,attempt_id,outcome,observed_at,evidence_reference,created_at FROM sequence_private.attempt_results WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 WHEN 'observations' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,prospect_id,observed_at,received_at,observer_version,connection,complete,message_direction,message_at,fingerprint,created_at FROM sequence_private.observations WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 WHEN 'reservations' THEN SELECT jsonb_agg(to_jsonb(x)) INTO result FROM (SELECT id,action_id,attempt_id,possible_send_at,resolved_at,resolution FROM sequence_private.send_reservations WHERE workspace_id=w ORDER BY created_at,id LIMIT lim OFFSET off) x;
 ELSE RAISE EXCEPTION 'Invalid section' USING ERRCODE='22023';
 END CASE;
 RETURN coalesce(result,'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.seq_export(text,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.seq_export(text,integer) TO authenticated;

-- B: tombstones persist outside ordinary tenant rows and without an identity foreign key,
-- so they survive identity removal until the deletion ledger drill retires them.
CREATE TABLE sequence_private.deletion_tombstones (
 workspace_id uuid PRIMARY KEY, user_id uuid NOT NULL, request_id uuid NOT NULL UNIQUE,
 deleted_at timestamptz NOT NULL DEFAULT now(), backup_cutoff timestamptz,
 unresolved_sends integer NOT NULL DEFAULT 0 CHECK(unresolved_sends>=0),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), identity_removed_at timestamptz);
CREATE INDEX tombstone_user ON sequence_private.deletion_tombstones(user_id);
ALTER TABLE sequence_private.deletion_tombstones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.deletion_tombstones FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_auth_runtime;

CREATE FUNCTION public.seq_delete_workspace(args jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid; w uuid; req uuid; t sequence_private.deletion_tombstones%ROWTYPE; sid uuid; created timestamptz;
 unresolved integer; removed jsonb; result jsonb;
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
  'backupCutoff',NULL,'identityRemovalDueBy',now()+interval '7 days',
  'note','Product records are removed now. Your sign-in identity is removed by the operator within seven days. Deleting product records does not withdraw LinkedIn invitations or remove LinkedIn messages.');
 INSERT INTO sequence_private.deletion_tombstones(workspace_id,user_id,request_id,unresolved_sends,result) VALUES(w,u,req,unresolved,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.seq_delete_workspace(jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.seq_delete_workspace(jsonb) TO authenticated;

-- Operator-only identity removal after a recorded deletion. Runtime and client roles cannot execute it.
CREATE FUNCTION sequence_private.operator_remove_identity(target uuid, correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t sequence_private.deletion_tombstones%ROWTYPE;
BEGIN
 IF target IS NULL OR correlation_id IS NULL THEN RAISE EXCEPTION 'Missing operator input' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(target::text,734004));
 SELECT * INTO t FROM sequence_private.deletion_tombstones WHERE user_id=target ORDER BY deleted_at DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'No recorded deletion for this identity' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM public.seq_workspaces WHERE owner_id=target) THEN RAISE EXCEPTION 'Workspace still exists' USING ERRCODE='55000'; END IF;
 DELETE FROM sequence_private.access_allowlist WHERE user_id=target;
 DELETE FROM auth.users WHERE id=target;
 UPDATE sequence_private.deletion_tombstones SET identity_removed_at=coalesce(identity_removed_at,now()) WHERE workspace_id=t.workspace_id;
 RETURN jsonb_build_object('workspaceId',t.workspace_id,'identityRemovedAt',now(),'correlationId',correlation_id);
END $$;
REVOKE ALL ON FUNCTION sequence_private.operator_remove_identity(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_auth_runtime;

-- Aggregate content-free counters follow the reconciled 90-day retention.
CREATE OR REPLACE FUNCTION sequence_private.auth_maintenance() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 DELETE FROM sequence_private.auth_rate_limits WHERE window_start<now()-interval '10 minutes';
 DELETE FROM sequence_private.login_transactions WHERE expires_at<=now();
 DELETE FROM sequence_private.auth_sessions WHERE expires_at<=now();
 DELETE FROM sequence_private.auth_audit WHERE user_id IS NULL AND created_at<now()-interval '30 days';
 DELETE FROM sequence_private.usage_counters WHERE day<current_date-90;
END $$;

-- Status operation and growth gate; the rest of the management transaction is unchanged from 0009.
CREATE OR REPLACE FUNCTION public.seq_manage(operation text, args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid; a uuid; cid uuid; rid uuid; lid uuid; pid uuid; oid uuid; apid uuid;
 c public.seq_campaigns%ROWTYPE; cr sequence_private.content_revisions%ROWTYPE; p public.seq_prospects%ROWTYPE;
 prior sequence_private.management_requests%ROWTYPE; item jsonb; content jsonb; selected jsonb; rendered jsonb; preview jsonb='[]';
 result jsonb; fingerprint text; req uuid; pg integer; stat text; reason text;
BEGIN
 IF jsonb_typeof(args) IS DISTINCT FROM 'object' OR octet_length(args::text)>32768 THEN RAISE EXCEPTION 'Invalid arguments' USING ERRCODE='22023'; END IF;
 SELECT id INTO w FROM public.seq_workspaces WHERE owner_id=auth.uid();
 IF w IS NULL OR NOT sequence_private.owns_workspace(w) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 -- Serialize owner mutations, preview snapshots and duplicate retries. Recheck authorization after lock.
 PERFORM 1 FROM public.seq_workspaces WHERE id=w FOR UPDATE;
 IF NOT sequence_private.owns_workspace(w) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 SELECT id INTO a FROM public.seq_accounts WHERE workspace_id=w;
 IF operation='snapshot' THEN
  IF args-ARRAY['page'] <> '{}' OR coalesce(args->>'page','') !~ '^[0-9]{1,3}$' THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
  pg=(args->>'page')::integer;
  IF pg>199 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('page',pg,'sendingEnabled',false,
   'totalProspects',(SELECT count(*) FROM public.seq_prospects WHERE workspace_id=w),
   'totalEnrollments',(SELECT count(*) FROM sequence_private.enrollments WHERE workspace_id=w),
   'prospects',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT id,display_name,role_title,company,connection,revision FROM public.seq_prospects WHERE workspace_id=w ORDER BY created_at,id LIMIT 50 OFFSET pg*50) x),'[]'),
   'lists',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT l.id,l.name,(SELECT count(*) FROM public.seq_list_memberships m WHERE m.list_id=l.id) AS count FROM public.seq_lists l WHERE l.workspace_id=w ORDER BY l.created_at,l.id LIMIT 100) x),'[]'),
   'campaigns',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT ca.id,ca.name,ca.revision,ca.status,
     (SELECT jsonb_build_object('note',coalesce(r.invitation_note,''),'firstMessage',r.first_message,'followups',r.followups) FROM sequence_private.content_revisions r WHERE r.campaign_id=ca.id ORDER BY r.revision DESC LIMIT 1) AS content,
     coalesce((SELECT r.settings->'recipients' FROM sequence_private.content_revisions r WHERE r.campaign_id=ca.id ORDER BY r.revision DESC LIMIT 1),'[]') AS recipients,
     EXISTS(SELECT 1 FROM sequence_private.approvals ap WHERE ap.campaign_id=ca.id AND ap.settings_revision=ca.revision) AS approved
     FROM public.seq_campaigns ca WHERE ca.workspace_id=w ORDER BY ca.created_at,ca.id LIMIT 100) x),'[]'),
   'enrollments',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT e.id,e.campaign_id,e.prospect_id,pr.display_name,e.status,e.stop_reason FROM sequence_private.enrollments e JOIN public.seq_prospects pr ON pr.id=e.prospect_id WHERE e.workspace_id=w ORDER BY e.created_at,e.id LIMIT 50 OFFSET pg*50) x),'[]'));
 END IF;
 IF operation='status' THEN
  IF args <> '{}' THEN RAISE EXCEPTION 'Invalid status request' USING ERRCODE='22023'; END IF;
  RETURN sequence_private.quota_status() || jsonb_build_object('totalProspects',(SELECT count(*) FROM public.seq_prospects WHERE workspace_id=w),'totalCampaigns',(SELECT count(*) FROM public.seq_campaigns WHERE workspace_id=w));
 END IF;
 IF operation NOT IN ('import-preview','import','save-draft','approval-preview','approve','control') OR operation IS NULL THEN RAISE EXCEPTION 'Invalid operation' USING ERRCODE='22023'; END IF;
 IF operation IN ('import','save-draft','approve','control') THEN
  IF coalesce(args->>'requestId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid request ID' USING ERRCODE='22023'; END IF;
  req=(args->>'requestId')::uuid;
  SELECT * INTO prior FROM sequence_private.management_requests WHERE workspace_id=w AND request_id=req;
  IF FOUND THEN
   IF prior.request <> jsonb_build_object('operation',operation,'args',args) THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='40001'; END IF;
   RETURN prior.result;
  END IF;
 END IF;
 -- S3-006 growth gate: quota deny or unverified egress blocks new data, never stop/export/delete.
 IF (operation IN ('import','approve') OR (operation='save-draft' AND args->>'campaignId' IS NULL))
    AND NOT (sequence_private.quota_status()->>'growthAllowed')::boolean THEN
  RAISE EXCEPTION 'Growth blocked by quota guard' USING ERRCODE='53400'; END IF;
 IF operation IN ('import-preview','import') THEN
  IF args-ARRAY['operation','requestId','keys','listName'] <> '{}' OR jsonb_typeof(args->'keys') IS DISTINCT FROM 'array' OR jsonb_array_length(args->'keys') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid import' USING ERRCODE='22023'; END IF;
  IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(args->'keys')) <> jsonb_array_length(args->'keys') THEN RAISE EXCEPTION 'Duplicate keys' USING ERRCODE='22023'; END IF;
  SELECT jsonb_agg(value ORDER BY value->>'key') INTO selected FROM jsonb_array_elements(sequence_private.management_catalog()) WHERE (args->'keys') ? (value->>'key');
  IF selected IS NULL OR jsonb_array_length(selected) <> jsonb_array_length(args->'keys') THEN RAISE EXCEPTION 'Unknown synthetic keys' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM public.seq_prospects WHERE workspace_id=w)+(SELECT count(*) FROM jsonb_array_elements(selected) x WHERE NOT EXISTS(SELECT 1 FROM public.seq_prospects pr WHERE pr.account_id=a AND pr.recipient_key=x.value->>'key'))>1000 THEN RAISE EXCEPTION 'Prospect limit' USING ERRCODE='22023'; END IF;
  IF operation='import-preview' THEN RETURN jsonb_build_object('source','fictional-catalog-v1','rows',selected); END IF;
  IF jsonb_typeof(args->'listName') IS DISTINCT FROM 'string' OR length(btrim(args->>'listName')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid list' USING ERRCODE='22023'; END IF;
  IF a IS NULL THEN INSERT INTO public.seq_accounts(workspace_id,external_identity) VALUES(w,'synthetic:'||w::text) RETURNING id INTO a; END IF;
  IF (SELECT count(*) FROM public.seq_lists WHERE workspace_id=w)>=100 THEN RAISE EXCEPTION 'List limit' USING ERRCODE='22023'; END IF;
  INSERT INTO public.seq_lists(workspace_id,account_id,name) VALUES(w,a,btrim(args->>'listName')) RETURNING id INTO lid;
  FOR item IN SELECT value FROM jsonb_array_elements(selected) LOOP
   SELECT id INTO pid FROM public.seq_prospects WHERE account_id=a AND recipient_key=item->>'key';
   IF pid IS NULL THEN
    INSERT INTO public.seq_prospects(workspace_id,account_id,recipient_key,display_name,role_title,company,source,observed_at,connection)
     VALUES(w,a,item->>'key',item->>'name',nullif(item->>'role',''),nullif(item->>'company',''),'synthetic',now(),item->>'connection') RETURNING id INTO pid;
   END IF;
   INSERT INTO public.seq_list_memberships(workspace_id,account_id,list_id,prospect_id) VALUES(w,a,lid,pid);
  END LOOP;
  result=jsonb_build_object('listId',lid,'count',jsonb_array_length(selected));
 ELSE
  IF operation='save-draft' THEN
   IF args-ARRAY['operation','requestId','campaignId','revision','name','recipients','content'] <> '{}' OR jsonb_typeof(args->'name') IS DISTINCT FROM 'string' OR length(btrim(args->>'name')) NOT BETWEEN 1 AND 100 OR jsonb_typeof(args->'recipients') IS DISTINCT FROM 'array' OR jsonb_array_length(args->'recipients') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid draft' USING ERRCODE='22023'; END IF;
   selected=args->'recipients'; content=args->'content';
   IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(selected))<>jsonb_array_length(selected) THEN RAISE EXCEPTION 'Duplicate recipients' USING ERRCODE='22023'; END IF;
   IF (SELECT count(*) FROM public.seq_prospects WHERE workspace_id=w AND source='synthetic' AND selected ? id::text)<>jsonb_array_length(selected) THEN RAISE EXCEPTION 'Recipient ownership or source' USING ERRCODE='42501'; END IF;
   -- Validate template structure without inventing profile values; missing real fields fail at preview.
   PERFORM sequence_private.render_management(content,'{"name":"sample","company":"sample","role":"sample"}'::jsonb);
   IF args->>'campaignId' IS NULL THEN
    IF args->>'revision' IS NOT NULL OR a IS NULL OR (SELECT count(*) FROM public.seq_campaigns WHERE workspace_id=w)>=100 THEN RAISE EXCEPTION 'Invalid new campaign' USING ERRCODE='22023'; END IF;
    INSERT INTO public.seq_campaigns(workspace_id,account_id,name) VALUES(w,a,btrim(args->>'name')) RETURNING * INTO c;
   END IF;
  END IF;
  IF c.id IS NULL THEN
   IF coalesce(args->>'campaignId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid campaign' USING ERRCODE='22023'; END IF;
   SELECT * INTO c FROM public.seq_campaigns WHERE id=(args->>'campaignId')::uuid AND workspace_id=w FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Campaign denied' USING ERRCODE='42501'; END IF;
   IF c.revision::text IS DISTINCT FROM args->>'revision' THEN RAISE EXCEPTION 'Stale revision' USING ERRCODE='40001'; END IF;
   IF c.status='Stopped' THEN RAISE EXCEPTION 'Terminal campaign' USING ERRCODE='40001'; END IF;
   IF operation='save-draft' THEN UPDATE public.seq_campaigns SET name=btrim(args->>'name') WHERE id=c.id RETURNING * INTO c; END IF;
  END IF;
  cid=c.id;
  IF operation='save-draft' THEN
   INSERT INTO sequence_private.content_revisions(workspace_id,account_id,campaign_id,revision,invitation_note,first_message,followups,settings)
    VALUES(w,a,cid,c.revision,content->>'note',content->>'firstMessage',content->'followups',jsonb_build_object('recipients',selected)) RETURNING id INTO rid;
   UPDATE sequence_private.enrollments SET status=CASE WHEN selected ? prospect_id::text THEN 'Held' ELSE 'Stopped' END,
    stop_reason=CASE WHEN selected ? prospect_id::text THEN 'approval-required' ELSE 'recipient-removed' END,revision=revision+1
    WHERE campaign_id=cid AND status NOT IN ('Stopped','Completed');
   result=jsonb_build_object('campaignId',cid,'revision',c.revision);
  ELSIF operation IN ('approval-preview','approve') THEN
   IF args-ARRAY['operation','requestId','campaignId','revision','preview'] <> '{}' OR c.status='Paused' THEN RAISE EXCEPTION 'Invalid approval' USING ERRCODE='22023'; END IF;
   SELECT * INTO cr FROM sequence_private.content_revisions WHERE campaign_id=cid ORDER BY revision DESC LIMIT 1;
   IF NOT FOUND THEN RAISE EXCEPTION 'No draft' USING ERRCODE='22023'; END IF;
   content=jsonb_build_object('note',coalesce(cr.invitation_note,''),'firstMessage',cr.first_message,'followups',cr.followups);
   FOR p IN SELECT * FROM public.seq_prospects WHERE workspace_id=w AND (cr.settings->'recipients') ? id::text ORDER BY id FOR UPDATE LOOP
    IF p.source <> 'synthetic' THEN RAISE EXCEPTION 'Unsupported source' USING ERRCODE='22023'; END IF;
    rendered=sequence_private.render_management(content,jsonb_build_object('name',p.display_name,'company',p.company,'role',p.role_title));
    stat=CASE p.connection WHEN 'Connected' THEN 'Excluded' WHEN 'Pending' THEN 'Waiting' WHEN 'RejectedConfirmed' THEN 'Stopped' WHEN 'WithdrawnConfirmed' THEN 'Stopped' ELSE 'Held' END;
    IF EXISTS(SELECT 1 FROM sequence_private.enrollments WHERE campaign_id=cid AND prospect_id=p.id AND status IN ('Stopped','Completed')) THEN stat='Terminal'; END IF;
    preview=preview || jsonb_build_array(jsonb_build_object('id',p.id,'name',p.display_name,'disposition',stat,'content',rendered,'profileRevision',p.revision));
   END LOOP;
   IF jsonb_array_length(preview)<>jsonb_array_length(cr.settings->'recipients') THEN RAISE EXCEPTION 'Recipients changed' USING ERRCODE='40001'; END IF;
   fingerprint=encode(extensions.digest(jsonb_build_object('campaign',cid,'revision',c.revision,'rows',preview)::text,'sha256'),'hex');
   IF operation='approval-preview' THEN RETURN jsonb_build_object('fingerprint',fingerprint,'recipients',preview); END IF;
   IF fingerprint IS DISTINCT FROM args->>'preview' THEN RAISE EXCEPTION 'Preview changed' USING ERRCODE='40001'; END IF;
   IF EXISTS(SELECT 1 FROM sequence_private.approvals WHERE campaign_id=cid AND settings_revision=c.revision) THEN RAISE EXCEPTION 'Already approved' USING ERRCODE='40001'; END IF;
   INSERT INTO sequence_private.approvals(workspace_id,account_id,campaign_id,content_revision_id,approver_id,settings_revision) VALUES(w,a,cid,cr.id,auth.uid(),c.revision) RETURNING id INTO apid;
   FOR item IN SELECT value FROM jsonb_array_elements(preview) LOOP
    pid=(item->>'id')::uuid; stat=item->>'disposition';
    INSERT INTO sequence_private.approval_recipients(workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id,rendered_content) VALUES(w,a,cid,cr.id,apid,pid,item->'content');
    IF stat IN ('Excluded','Terminal') THEN CONTINUE; END IF;
    SELECT * INTO p FROM public.seq_prospects WHERE id=pid;
    IF EXISTS(SELECT 1 FROM sequence_private.enrollments WHERE account_id=a AND prospect_id=pid AND campaign_id<>cid AND status IN ('Active','Waiting','Paused','Held')) THEN RAISE EXCEPTION 'Duplicate enrollment' USING ERRCODE='23505'; END IF;
    INSERT INTO sequence_private.observations(workspace_id,account_id,prospect_id,observed_at,observer_version,connection,complete) VALUES(w,a,pid,now(),'synthetic-catalog-v1',p.connection,true) RETURNING id INTO oid;
    reason=CASE stat WHEN 'Waiting' THEN 'pending-invitation' WHEN 'Stopped' THEN p.connection ELSE CASE WHEN p.connection='Unknown' THEN 'needs-verification' ELSE 'execution-disabled' END END;
    UPDATE sequence_private.enrollments SET content_revision_id=cr.id,approval_id=apid,baseline_observation_id=oid,status=stat,stop_reason=reason,revision=revision+1 WHERE campaign_id=cid AND prospect_id=pid AND status NOT IN ('Stopped','Completed');
    IF NOT FOUND THEN INSERT INTO sequence_private.enrollments(workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id,baseline_observation_id,status,stop_reason) VALUES(w,a,cid,cr.id,apid,pid,oid,stat,reason); END IF;
   END LOOP;
   result=jsonb_build_object('campaignId',cid,'approvalId',apid,'revision',c.revision);
  ELSIF operation='control' THEN
   IF args-ARRAY['operation','requestId','campaignId','revision','action'] <> '{}' OR coalesce(args->>'action','') NOT IN ('pause','resume','stop') THEN RAISE EXCEPTION 'Invalid control' USING ERRCODE='22023'; END IF;
   stat=CASE args->>'action' WHEN 'pause' THEN 'Paused' WHEN 'stop' THEN 'Stopped' ELSE 'Draft' END;
   UPDATE public.seq_campaigns SET status=stat WHERE id=cid RETURNING * INTO c;
   UPDATE sequence_private.enrollments SET status=CASE stat WHEN 'Draft' THEN 'Held' ELSE stat END,
    stop_reason=CASE stat WHEN 'Draft' THEN 'approval-required' WHEN 'Paused' THEN 'campaign-paused' ELSE 'user-stop' END,revision=revision+1 WHERE campaign_id=cid AND status NOT IN ('Stopped','Completed');
   result=jsonb_build_object('campaignId',cid,'revision',c.revision);
  END IF;
  IF operation IN ('save-draft','control') THEN
   UPDATE sequence_private.logical_actions SET state='Cancelled',revision=revision+1 WHERE enrollment_id IN (SELECT id FROM sequence_private.enrollments WHERE campaign_id=cid) AND state NOT IN ('ConfirmedSent','MayHaveSent','OutcomeUnknown','Skipped','Cancelled');
   UPDATE sequence_private.account_execution_state SET fence=fence+1,lease_executor=NULL,lease_expires_at=NULL WHERE account_id=a;
  END IF;
 END IF;
 IF result IS NULL THEN RAISE EXCEPTION 'Invalid request' USING ERRCODE='22023'; END IF;
 INSERT INTO sequence_private.management_requests(workspace_id,request_id,request,result) VALUES(w,req,jsonb_build_object('operation',operation,'args',args),result);
 RETURN result;
END $$;
NOTIFY pgrst, 'reload schema';
