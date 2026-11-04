-- S4-001 slice 1: executor pairing and user-triggered observation. No send capability exists; execution_mode allows 'observe' at most.
-- Prospects keep the public profile path so the extension can recognise an enrolled person's page when the user opens it.
ALTER TABLE public.seq_prospects ADD COLUMN profile_path text CHECK(profile_path ~ '^/in/[A-Za-z0-9%._-]{1,200}/?$');
ALTER TABLE public.seq_accounts ADD COLUMN execution_mode text NOT NULL DEFAULT 'disabled' CHECK(execution_mode IN ('disabled','observe'));
ALTER TABLE public.seq_accounts ADD COLUMN execution_acknowledged_at timestamptz;

-- Executors are paired browsers. The token hash is a credential: never exported, never backed up, never readable by a client role.
CREATE TABLE sequence_private.executors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL, token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[A-Za-z0-9_-]{43}$'),
 adapter_version text NOT NULL CHECK(adapter_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'), label text NOT NULL DEFAULT '' CHECK(length(label)<=60),
 created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz, revoked_at timestamptz,
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id));
CREATE TABLE sequence_private.pairing_codes (
 code_hash text PRIMARY KEY CHECK(code_hash ~ '^[A-Za-z0-9_-]{43}$'), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL, label text NOT NULL DEFAULT '' CHECK(length(label)<=60),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, consumed_at timestamptz,
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id));
ALTER TABLE sequence_private.executors ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_private.pairing_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.executors, sequence_private.pairing_codes FROM PUBLIC, anon, authenticated, service_role, sequence_worker, sequence_auth_runtime, sequence_backup;
CREATE INDEX executors_by_account ON sequence_private.executors(account_id) WHERE revoked_at IS NULL;

-- SHA-256 as base64url without padding, the same digest the Worker computes for session and pairing secrets.
CREATE FUNCTION sequence_private.digest_b64url(value text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT translate(rtrim(encode(extensions.digest(convert_to(value,'UTF8'),'sha256'),'base64'),'='),'+/','-_');
$$;
REVOKE ALL ON FUNCTION sequence_private.digest_b64url(text) FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_backup;

-- Dashboard side: pairing codes, connected browsers, revocation and the execution settings. Owner only.
CREATE FUNCTION public.seq_executors(operation text, args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid; a uuid; acc public.seq_accounts%ROWTYPE; code text; bytes bytea; alphabet text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; i integer; xid uuid; tz text; mode text; revoked boolean;
BEGIN
 IF jsonb_typeof(args) IS DISTINCT FROM 'object' OR octet_length(args::text)>4096 THEN RAISE EXCEPTION 'Invalid arguments' USING ERRCODE='22023'; END IF;
 SELECT id INTO w FROM public.seq_workspaces WHERE owner_id=auth.uid();
 IF w IS NULL OR NOT sequence_private.owns_workspace(w) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.seq_workspaces WHERE id=w FOR UPDATE;
 IF NOT sequence_private.owns_workspace(w) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO acc FROM public.seq_accounts WHERE workspace_id=w;
 a := acc.id;
 IF operation='list' THEN
  IF args <> '{}' THEN RAISE EXCEPTION 'Invalid list request' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('executionMode',coalesce(acc.execution_mode,'disabled'),'timezone',acc.timezone,'acknowledgedAt',acc.execution_acknowledged_at,
   'bound',coalesce(acc.external_identity,'') LIKE 'linkedin:%',
   'executors',coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'label',x.label,'adapterVersion',x.adapter_version,'createdAt',x.created_at,'lastSeenAt',x.last_seen_at,'revokedAt',x.revoked_at) ORDER BY x.created_at)
     FROM sequence_private.executors x WHERE x.account_id=a AND (x.revoked_at IS NULL OR x.revoked_at>now()-interval '7 days')),'[]'::jsonb));
 ELSIF operation='pair-code' THEN
  IF args-ARRAY['label'] <> '{}' OR length(coalesce(args->>'label',''))>60 THEN RAISE EXCEPTION 'Invalid pairing request' USING ERRCODE='22023'; END IF;
  IF a IS NULL OR coalesce(acc.external_identity,'') NOT LIKE 'linkedin:%' THEN RAISE EXCEPTION 'Account not bound to a LinkedIn identity' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM sequence_private.executors x WHERE x.account_id=a AND x.revoked_at IS NULL)>=5 THEN RAISE EXCEPTION 'Executor limit' USING ERRCODE='22023'; END IF;
  DELETE FROM sequence_private.pairing_codes WHERE account_id=a OR expires_at<now()-interval '1 day';
  bytes := extensions.gen_random_bytes(8); code := '';
  FOR i IN 0..7 LOOP code := code || substr(alphabet,(get_byte(bytes,i) % length(alphabet))+1,1); END LOOP;
  INSERT INTO sequence_private.pairing_codes(code_hash,workspace_id,account_id,label,expires_at) VALUES(sequence_private.digest_b64url(code),w,a,coalesce(args->>'label',''),now()+interval '5 minutes');
  RETURN jsonb_build_object('code',code,'expiresAt',now()+interval '5 minutes');
 ELSIF operation='revoke' THEN
  IF args-ARRAY['executorId'] <> '{}' OR coalesce(args->>'executorId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid executor' USING ERRCODE='22023'; END IF;
  xid := (args->>'executorId')::uuid;
  UPDATE sequence_private.executors SET revoked_at=now() WHERE id=xid AND workspace_id=w AND revoked_at IS NULL;
  revoked := FOUND;
  -- A revoked browser loses any live lease immediately; unresolved attempts stay for reconciliation.
  UPDATE sequence_private.account_execution_state SET fence=fence+1,lease_executor=NULL,lease_expires_at=NULL WHERE workspace_id=w AND lease_executor=xid;
  RETURN jsonb_build_object('revoked',revoked OR EXISTS(SELECT 1 FROM sequence_private.executors WHERE id=xid AND workspace_id=w AND revoked_at IS NOT NULL));
 ELSIF operation='settings' THEN
  IF args-ARRAY['timezone','executionMode','acknowledged'] <> '{}' OR jsonb_typeof(args->'acknowledged') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid settings' USING ERRCODE='22023'; END IF;
  IF a IS NULL THEN RAISE EXCEPTION 'No account yet' USING ERRCODE='22023'; END IF;
  tz := args->>'timezone'; mode := args->>'executionMode';
  IF tz IS NOT NULL AND (length(tz)>64 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names n WHERE n.name=tz)) THEN RAISE EXCEPTION 'Unknown timezone' USING ERRCODE='22023'; END IF;
  IF mode IS NULL OR mode NOT IN ('disabled','observe') THEN RAISE EXCEPTION 'Invalid execution mode' USING ERRCODE='22023'; END IF;
  IF mode='observe' AND (coalesce(acc.external_identity,'') NOT LIKE 'linkedin:%' OR coalesce(tz,acc.timezone) IS NULL OR NOT (args->'acknowledged')::boolean) THEN
   RAISE EXCEPTION 'Observation needs a bound account, a timezone and the acknowledgement' USING ERRCODE='22023'; END IF;
  UPDATE public.seq_accounts SET timezone=coalesce(tz,timezone),execution_mode=mode,
   execution_acknowledged_at=CASE WHEN (args->'acknowledged')::boolean THEN coalesce(execution_acknowledged_at,now()) ELSE execution_acknowledged_at END,revision=revision+1 WHERE id=a;
  RETURN public.seq_executors('list','{}'::jsonb);
 END IF;
 RAISE EXCEPTION 'Invalid operation' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION public.seq_executors(text,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.seq_executors(text,jsonb) TO authenticated;

-- Executor side, reached only through the Worker's runtime role with a device token. The extension reports what the user opened; it never navigates.
CREATE FUNCTION sequence_private.executor_operation(operation text, args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE x sequence_private.executors%ROWTYPE; acc public.seq_accounts%ROWTYPE; pc sequence_private.pairing_codes%ROWTYPE; h text := args->>'tokenHash';
 selfid text; identity text; item jsonb; msg jsonb; pid uuid; stored integer := 0; duplicates integer := 0; rejected integer := 0; at_time timestamptz;
BEGIN
 IF jsonb_typeof(args) IS DISTINCT FROM 'object' OR octet_length(args::text)>131072 THEN RAISE EXCEPTION 'Invalid arguments' USING ERRCODE='22023'; END IF;
 IF operation='pair' THEN
  IF coalesce(args->>'codeHash','') !~ '^[A-Za-z0-9_-]{43}$' OR coalesce(h,'') !~ '^[A-Za-z0-9_-]{43}$' OR coalesce(args->>'adapterVersion','') !~ '^[0-9]+\.[0-9]+\.[0-9]+$' THEN
   RAISE EXCEPTION 'Invalid pairing' USING ERRCODE='22023'; END IF;
  SELECT * INTO pc FROM sequence_private.pairing_codes WHERE code_hash=args->>'codeHash' FOR UPDATE;
  IF NOT FOUND OR pc.consumed_at IS NOT NULL OR pc.expires_at<=now() THEN RETURN NULL; END IF;
  UPDATE sequence_private.pairing_codes SET consumed_at=now() WHERE code_hash=pc.code_hash;
  INSERT INTO sequence_private.executors(workspace_id,account_id,token_hash,adapter_version,label,last_seen_at) VALUES(pc.workspace_id,pc.account_id,h,args->>'adapterVersion',pc.label,now()) RETURNING * INTO x;
  SELECT * INTO acc FROM public.seq_accounts WHERE id=x.account_id;
  RETURN jsonb_build_object('executorId',x.id,'executionMode',acc.execution_mode,'accountIdentity',acc.external_identity);
 END IF;
 IF coalesce(h,'') !~ '^[A-Za-z0-9_-]{43}$' THEN RAISE EXCEPTION 'Invalid token' USING ERRCODE='22023'; END IF;
 SELECT * INTO x FROM sequence_private.executors WHERE token_hash=h AND revoked_at IS NULL;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO acc FROM public.seq_accounts WHERE id=x.account_id;
 -- The signed-in LinkedIn identity the extension sees must be the bound one; otherwise nothing is accepted.
 selfid := CASE WHEN args->'self'->>'profileKey' IS NOT NULL THEN 'linkedin:'||(args->'self'->>'profileKey') WHEN args->'self'->>'profilePath' IS NOT NULL THEN 'linkedin:path:'||(args->'self'->>'profilePath') END;
 identity := CASE WHEN selfid IS NULL THEN 'unknown' WHEN selfid=acc.external_identity THEN 'match' ELSE 'mismatch' END;
 IF operation='heartbeat' THEN
  IF coalesce(args->>'adapterVersion','') !~ '^[0-9]+\.[0-9]+\.[0-9]+$' THEN RAISE EXCEPTION 'Invalid version' USING ERRCODE='22023'; END IF;
  UPDATE sequence_private.executors SET last_seen_at=now(),adapter_version=args->>'adapterVersion' WHERE id=x.id;
  RETURN jsonb_build_object('executorId',x.id,'executionMode',acc.execution_mode,'identity',identity,'pollSeconds',300);
 ELSIF operation='watchlist' THEN
  -- The enrolled people the extension may report on when the user opens their pages. Nothing is visited for the user.
  UPDATE sequence_private.executors SET last_seen_at=now() WHERE id=x.id;
  IF acc.execution_mode<>'observe' OR identity<>'match' THEN RETURN jsonb_build_object('executionMode',acc.execution_mode,'identity',identity,'people','[]'::jsonb); END IF;
  RETURN jsonb_build_object('executionMode',acc.execution_mode,'identity',identity,
   'people',coalesce((SELECT jsonb_agg(jsonb_build_object('prospectId',p.id,'profilePath',p.profile_path,'recipientKey',p.recipient_key,'displayName',p.display_name,'enrolledAt',e.enrolled_at) ORDER BY e.enrolled_at,p.id)
    FROM (SELECT en.prospect_id,min(en.created_at) AS enrolled_at FROM sequence_private.enrollments en WHERE en.account_id=acc.id AND en.status IN ('Active','Waiting','Paused','Held') GROUP BY en.prospect_id) e
    JOIN public.seq_prospects p ON p.id=e.prospect_id AND p.account_id=acc.id),'[]'::jsonb));
 ELSIF operation='observe' THEN
  IF identity<>'match' THEN RAISE EXCEPTION 'Signed-in account does not match the bound account' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(args->'observations') IS DISTINCT FROM 'array' OR jsonb_array_length(args->'observations') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid observations' USING ERRCODE='22023'; END IF;
  UPDATE sequence_private.executors SET last_seen_at=now() WHERE id=x.id;
  FOR item IN SELECT value FROM jsonb_array_elements(args->'observations') LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['prospectId','observedAt','connection','complete','messages','unreadable'] <> '{}'
     OR coalesce(item->>'prospectId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR coalesce(item->>'connection','') NOT IN ('Unknown','NotConnected','Pending','Connected')
     OR jsonb_typeof(item->'complete') IS DISTINCT FROM 'boolean' OR jsonb_typeof(coalesce(item->'messages','[]'::jsonb)) IS DISTINCT FROM 'array'
     OR jsonb_array_length(coalesce(item->'messages','[]'::jsonb))>50 THEN RAISE EXCEPTION 'Invalid observation' USING ERRCODE='22023'; END IF;
   BEGIN at_time := (item->>'observedAt')::timestamptz; EXCEPTION WHEN others THEN RAISE EXCEPTION 'Invalid observation time' USING ERRCODE='22023'; END;
   IF at_time IS NULL OR at_time<now()-interval '1 hour' OR at_time>now()+interval '5 minutes' THEN RAISE EXCEPTION 'Stale observation' USING ERRCODE='22023'; END IF;
   SELECT id INTO pid FROM public.seq_prospects WHERE id=(item->>'prospectId')::uuid AND account_id=acc.id;
   IF pid IS NULL THEN rejected := rejected+1; CONTINUE; END IF;
   -- Shadow phase: observations are evidence on record; they never change the prospect's state or any sequence here.
   INSERT INTO sequence_private.observations(workspace_id,account_id,prospect_id,observed_at,observer_version,connection,complete)
    VALUES(x.workspace_id,acc.id,pid,at_time,'adapter-v1',item->>'connection',(item->'complete')::boolean AND NOT coalesce((item->'unreadable')::boolean,false));
   stored := stored+1;
   FOR msg IN SELECT value FROM jsonb_array_elements(coalesce(item->'messages','[]'::jsonb)) LOOP
    IF jsonb_typeof(msg) IS DISTINCT FROM 'object' OR msg-ARRAY['direction','at','fingerprint'] <> '{}' OR coalesce(msg->>'direction','') NOT IN ('incoming','outgoing')
      OR coalesce(msg->>'fingerprint','') !~ '^[A-Za-z0-9_-]{16,64}$' THEN RAISE EXCEPTION 'Invalid message evidence' USING ERRCODE='22023'; END IF;
    BEGIN at_time := (msg->>'at')::timestamptz; EXCEPTION WHEN others THEN RAISE EXCEPTION 'Invalid message time' USING ERRCODE='22023'; END;
    IF at_time IS NULL OR at_time>now()+interval '5 minutes' THEN RAISE EXCEPTION 'Invalid message time' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM sequence_private.observations o WHERE o.account_id=acc.id AND o.prospect_id=pid AND o.fingerprint=msg->>'fingerprint') THEN duplicates := duplicates+1; CONTINUE; END IF;
    INSERT INTO sequence_private.observations(workspace_id,account_id,prospect_id,observed_at,observer_version,connection,complete,message_direction,message_at,fingerprint)
     VALUES(x.workspace_id,acc.id,pid,(item->>'observedAt')::timestamptz,'adapter-v1',item->>'connection',false,msg->>'direction',at_time,msg->>'fingerprint');
    stored := stored+1;
   END LOOP;
  END LOOP;
  RETURN jsonb_build_object('stored',stored,'duplicates',duplicates,'rejected',rejected);
 END IF;
 RAISE EXCEPTION 'Invalid operation' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION sequence_private.executor_operation(text,jsonb) FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_backup;
GRANT EXECUTE ON FUNCTION sequence_private.executor_operation(text,jsonb) TO sequence_auth_runtime;

-- Workspace health now reports paired browsers instead of a fixed label.
CREATE OR REPLACE FUNCTION sequence_private.workspace_health(w uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object(
  'oldestDueAt',(SELECT min(due_at) FROM sequence_private.logical_actions WHERE workspace_id=w AND state IN ('Planned','Due')),
  'dueCount',(SELECT count(*) FROM sequence_private.logical_actions WHERE workspace_id=w AND state IN ('Planned','Due') AND due_at<=now()),
  'heldCount',(SELECT count(*) FROM sequence_private.enrollments WHERE workspace_id=w AND status='Held'),
  'waitingCount',(SELECT count(*) FROM sequence_private.enrollments WHERE workspace_id=w AND status='Waiting'),
  'uncertainSends',(SELECT count(*) FROM sequence_private.send_reservations WHERE workspace_id=w AND resolved_at IS NULL),
  'unknownOutcomes',(SELECT count(*) FROM sequence_private.logical_actions WHERE workspace_id=w AND state IN ('MayHaveSent','OutcomeUnknown')),
  'executors',(SELECT CASE WHEN count(*)=0 THEN 'none-registered' WHEN count(*) FILTER (WHERE last_seen_at>now()-interval '10 minutes')>0 THEN (count(*) FILTER (WHERE last_seen_at>now()-interval '10 minutes'))||' connected' ELSE 'registered' END
    FROM sequence_private.executors WHERE workspace_id=w AND revoked_at IS NULL));
$$;

-- The external import now keeps the profile path; the rest of the management transaction is unchanged from migration 0014.
CREATE OR REPLACE FUNCTION public.seq_manage(operation text, args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid; a uuid; cid uuid; rid uuid; lid uuid; pid uuid; oid uuid; apid uuid; captured timestamptz; selfkey text; bound text; binding text; cur text;
 c public.seq_campaigns%ROWTYPE; cr sequence_private.content_revisions%ROWTYPE; p public.seq_prospects%ROWTYPE;
 prior sequence_private.management_requests%ROWTYPE; item jsonb; content jsonb; selected jsonb; rendered jsonb; preview jsonb='[]';
 result jsonb; fingerprint text; req uuid; pg integer; stat text; reason text;
BEGIN
 IF jsonb_typeof(args) IS DISTINCT FROM 'object' OR octet_length(args::text)>131072 THEN RAISE EXCEPTION 'Invalid arguments' USING ERRCODE='22023'; END IF;
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
   'prospects',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT id,display_name,role_title,company,connection,revision,source FROM public.seq_prospects WHERE workspace_id=w ORDER BY created_at,id LIMIT 50 OFFSET pg*50) x),'[]'),
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
  RETURN sequence_private.quota_status() || jsonb_build_object('totalProspects',(SELECT count(*) FROM public.seq_prospects WHERE workspace_id=w),'totalCampaigns',(SELECT count(*) FROM public.seq_campaigns WHERE workspace_id=w),'health',sequence_private.workspace_health(w));
 END IF;
 IF operation NOT IN ('import-preview','import','import-preview-external','import-external','save-draft','approval-preview','approve','control') OR operation IS NULL THEN RAISE EXCEPTION 'Invalid operation' USING ERRCODE='22023'; END IF;
 IF operation IN ('import','import-external','save-draft','approve','control') THEN
  IF coalesce(args->>'requestId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid request ID' USING ERRCODE='22023'; END IF;
  req=(args->>'requestId')::uuid;
  SELECT * INTO prior FROM sequence_private.management_requests WHERE workspace_id=w AND request_id=req;
  IF FOUND THEN
   IF prior.request <> jsonb_build_object('operation',operation,'args',args) THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='40001'; END IF;
   RETURN prior.result;
  END IF;
 END IF;
 -- S3-006 growth gate: quota deny or unverified egress blocks new data, never stop/export/delete.
 IF (operation IN ('import','import-external','approve') OR (operation='save-draft' AND args->>'campaignId' IS NULL))
    AND NOT (sequence_private.quota_status()->>'growthAllowed')::boolean THEN
  RAISE EXCEPTION 'Growth blocked by quota guard' USING ERRCODE='53400'; END IF;
 IF operation IN ('import-preview-external','import-external') THEN
  IF args-ARRAY['operation','requestId','selection','listName'] <> '{}' OR jsonb_typeof(args->'selection') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid selection' USING ERRCODE='22023'; END IF;
  selected := args->'selection';
  IF selected->>'contract' IS DISTINCT FROM 'paced-selection-1' OR coalesce(selected->>'extensionVersion','') !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
   OR selected->>'pageType' IS DISTINCT FROM 'people-search' OR jsonb_typeof(selected->'rows') IS DISTINCT FROM 'array'
   OR jsonb_array_length(selected->'rows') NOT BETWEEN 1 AND 100 OR jsonb_typeof(selected->'self') IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'Invalid selection' USING ERRCODE='22023'; END IF;
  BEGIN captured := (selected->>'capturedAt')::timestamptz; EXCEPTION WHEN others THEN RAISE EXCEPTION 'Invalid capture time' USING ERRCODE='22023'; END;
  IF captured IS NULL OR captured<now()-interval '24 hours' OR captured>now()+interval '5 minutes' THEN RAISE EXCEPTION 'Stale selection' USING ERRCODE='22023'; END IF;
  IF (SELECT count(DISTINCT value->>'profileKey') FROM jsonb_array_elements(selected->'rows') WHERE value->>'profileKey' IS NOT NULL)
     <> (SELECT count(*) FROM jsonb_array_elements(selected->'rows') WHERE value->>'profileKey' IS NOT NULL) THEN RAISE EXCEPTION 'Duplicate keys' USING ERRCODE='22023'; END IF;
  -- Self identity: a stable key when the page exposes one, otherwise the signed-in profile path read from the account menu.
  selfkey := CASE WHEN selected->'self'->>'profileKey' IS NOT NULL THEN selected->'self'->>'profileKey' WHEN selected->'self'->>'profilePath' IS NOT NULL THEN 'path:'||(selected->'self'->>'profilePath') END;
  IF selfkey IS NOT NULL AND selfkey !~ '^(urn:li:(fsd_profile:[A-Za-z0-9_-]{4,120}|member:[0-9]{1,20})|path:/in/[A-Za-z0-9%._-]{1,200}/?)$' THEN RAISE EXCEPTION 'Invalid self identity' USING ERRCODE='22023'; END IF;
  -- Account binding: the first real import binds the signed-in identity; a different identity later is a mismatch, never a rebinding.
  IF a IS NOT NULL THEN SELECT external_identity INTO bound FROM public.seq_accounts WHERE id=a; END IF;
  binding := CASE WHEN selfkey IS NULL THEN 'self-unavailable' WHEN bound IS NULL OR bound NOT LIKE 'linkedin:%' THEN 'will-bind' WHEN bound='linkedin:'||selfkey THEN 'bound' ELSE 'mismatch' END;
  preview := '[]';
  FOR item IN SELECT value FROM jsonb_array_elements(selected->'rows') LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['profileKey','profilePath','displayName','headline','location','current','relationship','action','missing'] <> '{}'
     OR length(coalesce(item->>'displayName',''))>200 OR length(coalesce(item->>'headline',''))>400 OR length(coalesce(item->>'location',''))>200 OR length(coalesce(item->>'current',''))>300
     OR coalesce(item->>'profilePath','/in/x/') !~ '^/in/[A-Za-z0-9%._-]{1,200}/?$' THEN RAISE EXCEPTION 'Invalid row' USING ERRCODE='22023'; END IF;
   reason := CASE WHEN item->>'profileKey' IS NULL OR item->>'profileKey' !~ '^urn:li:(fsd_profile:[A-Za-z0-9_-]{4,120}|member:[0-9]{1,20})$' THEN 'no-stable-key'
                  WHEN coalesce(btrim(item->>'displayName'),'')='' THEN 'no-name' ELSE NULL END;
   stat := CASE WHEN item->>'relationship'='1st' THEN 'Connected' WHEN item->>'action'='Pending' THEN 'Pending'
                WHEN item->>'action'='Connect' AND coalesce(item->>'relationship','')<>'1st' THEN 'NotConnected' ELSE 'Unknown' END;
   -- Role and company come from the visible "Current: role at company" line when present, else from the headline's " at ".
   cur := CASE WHEN coalesce(item->>'current','') ~* '^current:' THEN btrim(regexp_replace(item->>'current','^current:\s*','','i')) WHEN coalesce(item->>'headline','') LIKE '% at %' THEN item->>'headline' ELSE NULL END;
   rendered := jsonb_build_object('profileKey',item->>'profileKey','displayName',btrim(item->>'displayName'),
     'role',CASE WHEN cur IS NULL THEN nullif(btrim(coalesce(item->>'headline','')),'') ELSE nullif(btrim(split_part(cur,' at ',1)),'') END,
     'company',CASE WHEN cur LIKE '% at %' THEN nullif(btrim(substring(cur from position(' at ' in cur)+4)),'') ELSE NULL END,
     'location',nullif(btrim(coalesce(item->>'location','')),''),'connection',stat,'importable',reason IS NULL,'reason',reason,'profilePath',item->>'profilePath',
     'existing',EXISTS(SELECT 1 FROM public.seq_prospects pr WHERE pr.account_id=a AND pr.recipient_key=item->>'profileKey'));
   preview := preview || jsonb_build_array(rendered);
  END LOOP;
  IF (SELECT count(*) FROM public.seq_prospects WHERE workspace_id=w)+(SELECT count(*) FROM jsonb_array_elements(preview) x WHERE (x.value->>'importable')::boolean AND NOT (x.value->>'existing')::boolean)>1000 THEN RAISE EXCEPTION 'Prospect limit' USING ERRCODE='22023'; END IF;
  IF operation='import-preview-external' THEN RETURN jsonb_build_object('source','extension-v1','binding',binding,'rows',preview); END IF;
  IF binding IN ('self-unavailable','mismatch') THEN RAISE EXCEPTION 'Account identity unavailable or mismatched' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(preview) x WHERE (x.value->>'importable')::boolean) THEN RAISE EXCEPTION 'No importable rows' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(args->'listName') IS DISTINCT FROM 'string' OR length(btrim(args->>'listName')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid list' USING ERRCODE='22023'; END IF;
  IF a IS NULL THEN INSERT INTO public.seq_accounts(workspace_id,external_identity) VALUES(w,'linkedin:'||selfkey) RETURNING id INTO a;
  ELSIF binding='will-bind' THEN UPDATE public.seq_accounts SET external_identity='linkedin:'||selfkey,revision=revision+1 WHERE id=a; END IF;
  IF (SELECT count(*) FROM public.seq_lists WHERE workspace_id=w)>=100 THEN RAISE EXCEPTION 'List limit' USING ERRCODE='22023'; END IF;
  INSERT INTO public.seq_lists(workspace_id,account_id,name) VALUES(w,a,btrim(args->>'listName')) RETURNING id INTO lid;
  FOR item IN SELECT value FROM jsonb_array_elements(preview) WHERE (value->>'importable')::boolean LOOP
   SELECT id INTO pid FROM public.seq_prospects WHERE account_id=a AND recipient_key=item->>'profileKey';
   IF pid IS NULL THEN
    INSERT INTO public.seq_prospects(workspace_id,account_id,recipient_key,display_name,role_title,company,source,observed_at,connection,profile_path)
     VALUES(w,a,item->>'profileKey',item->>'displayName',item->>'role',item->>'company','extension-v1',captured,item->>'connection',item->>'profilePath') RETURNING id INTO pid;
   ELSE
    -- Changed visible fields update the person; the existing triggers invalidate affected approvals.
    UPDATE public.seq_prospects SET display_name=item->>'displayName',role_title=item->>'role',company=item->>'company',observed_at=captured,connection=item->>'connection',profile_path=coalesce(item->>'profilePath',profile_path)
     WHERE id=pid AND ROW(display_name,role_title,company,connection,profile_path) IS DISTINCT FROM ROW(item->>'displayName',item->>'role',item->>'company',item->>'connection',coalesce(item->>'profilePath',profile_path));
   END IF;
   INSERT INTO sequence_private.observations(workspace_id,account_id,prospect_id,observed_at,observer_version,connection,complete) VALUES(w,a,pid,captured,'extension-v1',item->>'connection',false);
   INSERT INTO public.seq_list_memberships(workspace_id,account_id,list_id,prospect_id) VALUES(w,a,lid,pid) ON CONFLICT DO NOTHING;
  END LOOP;
  result=jsonb_build_object('listId',lid,'count',(SELECT count(*) FROM jsonb_array_elements(preview) x WHERE (x.value->>'importable')::boolean),'skipped',(SELECT count(*) FROM jsonb_array_elements(preview) x WHERE NOT (x.value->>'importable')::boolean),'binding',binding);
 ELSIF operation IN ('import-preview','import') THEN
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
   IF (SELECT count(*) FROM public.seq_prospects WHERE workspace_id=w AND source IN ('synthetic','extension-v1') AND selected ? id::text)<>jsonb_array_length(selected) THEN RAISE EXCEPTION 'Recipient ownership or source' USING ERRCODE='42501'; END IF;
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
    IF p.source NOT IN ('synthetic','extension-v1') THEN RAISE EXCEPTION 'Unsupported source' USING ERRCODE='22023'; END IF;
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
    INSERT INTO sequence_private.observations(workspace_id,account_id,prospect_id,observed_at,observer_version,connection,complete) VALUES(w,a,pid,now(),CASE WHEN p.source='synthetic' THEN 'synthetic-catalog-v1' ELSE 'extension-v1' END,p.connection,p.source='synthetic') RETURNING id INTO oid;
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

-- Workspace deletion (latest definition from migration 0012) also removes paired browsers and codes.
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
  'requests',(SELECT count(*) FROM sequence_private.management_requests WHERE workspace_id=w),
  'executors',(SELECT count(*) FROM sequence_private.executors WHERE workspace_id=w));
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
 DELETE FROM sequence_private.executors WHERE workspace_id=w;
 DELETE FROM sequence_private.pairing_codes WHERE workspace_id=w;
 DELETE FROM public.seq_accounts WHERE workspace_id=w;
 DELETE FROM public.seq_workspaces WHERE id=w;
 result := jsonb_build_object('deleted',true,'workspaceId',w,'deletedAt',now(),'removed',removed,'unresolvedSends',unresolved,
  'backupCutoff',cutoff,'identityRemovalDueBy',now()+interval '7 days',
  'note','Product records are removed now. Your sign-in identity is removed by the operator within seven days. Deleting product records does not withdraw LinkedIn invitations or remove LinkedIn messages.');
 INSERT INTO sequence_private.deletion_tombstones(workspace_id,user_id,request_id,unresolved_sends,backup_cutoff,result) VALUES(w,u,req,unresolved,cutoff,result);
 RETURN result;
END $$;
