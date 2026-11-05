-- S4-001 slice 2: the manual send queue. The user performs every LinkedIn action by hand and answers here; Paced schedules,
-- records and enforces workload limits. No send capability exists and sending_enabled stays false by its check constraint.
DO $$ DECLARE c text; BEGIN
 SELECT conname INTO c FROM pg_constraint WHERE conrelid='public.seq_accounts'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%execution_mode%';
 IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE public.seq_accounts DROP CONSTRAINT %I',c); END IF;
END $$;
ALTER TABLE public.seq_accounts ADD CONSTRAINT seq_accounts_execution_mode_check CHECK(execution_mode IN ('disabled','observe','manual'));
-- Workload controls for the manual queue; they bound what the queue offers, they are not safety guarantees.
ALTER TABLE public.seq_accounts ADD COLUMN invitation_cap integer NOT NULL DEFAULT 18 CHECK(invitation_cap BETWEEN 1 AND 20);
ALTER TABLE public.seq_accounts ADD COLUMN message_cap integer NOT NULL DEFAULT 20 CHECK(message_cap BETWEEN 1 AND 40);
ALTER TABLE public.seq_accounts ADD COLUMN spacing_minutes integer NOT NULL DEFAULT 5 CHECK(spacing_minutes BETWEEN 1 AND 60);

-- The connection state the queue acts on: the user's latest report for this enrollment, else the approval baseline.
-- The prospect row is never updated here, because a changed prospect invalidates the campaign approval by design.
CREATE FUNCTION sequence_private.queue_connection(e sequence_private.enrollments) RETURNS text LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce(
  (SELECT o.connection FROM sequence_private.observations o WHERE o.account_id=e.account_id AND o.prospect_id=e.prospect_id
    AND o.observer_version='user-report-v1' AND o.message_direction IS NULL AND o.observed_at>=e.created_at ORDER BY o.observed_at DESC,o.created_at DESC LIMIT 1),
  (SELECT o.connection FROM sequence_private.observations o WHERE o.id=e.baseline_observation_id),'Unknown');
$$;
REVOKE ALL ON FUNCTION sequence_private.queue_connection(sequence_private.enrollments) FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_backup,sequence_auth_runtime;

-- The queue as the dashboard sees it. Materialises the first step for enrollments approval left waiting for execution.
CREATE FUNCTION sequence_private.queue_view(w uuid, a uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE acc public.seq_accounts%ROWTYPE; tz text; today date; inv_today integer; msg_today integer; next_allowed timestamptz; busy boolean; items jsonb; current jsonb; people jsonb;
BEGIN
 SELECT * INTO acc FROM public.seq_accounts WHERE id=a AND workspace_id=w;
 tz := coalesce(acc.timezone,'UTC'); today := (now() AT TIME ZONE tz)::date;
 INSERT INTO sequence_private.logical_actions(workspace_id,account_id,enrollment_id,content_revision_id,step,kind,due_at,state)
  SELECT w,a,en.id,en.content_revision_id,0,'Invitation',en.created_at,'Due' FROM sequence_private.enrollments en
  WHERE en.account_id=a AND en.status='Held' AND en.stop_reason IN ('execution-disabled','needs-verification')
 ON CONFLICT(enrollment_id,step) DO UPDATE SET state='Due',content_revision_id=EXCLUDED.content_revision_id,revision=sequence_private.logical_actions.revision+1
  WHERE sequence_private.logical_actions.state='Cancelled';
 SELECT count(*) FILTER (WHERE la.kind='Invitation'),count(*) FILTER (WHERE la.kind='Message') INTO inv_today,msg_today
  FROM sequence_private.attempt_results r JOIN sequence_private.logical_actions la ON la.id=r.action_id
  WHERE r.account_id=a AND r.outcome='ConfirmedSent' AND (r.observed_at AT TIME ZONE tz)::date=today;
 SELECT max(possible_send_at)+make_interval(mins=>acc.spacing_minutes) INTO next_allowed FROM sequence_private.send_reservations WHERE account_id=a;
 busy := EXISTS(SELECT 1 FROM sequence_private.send_reservations WHERE account_id=a AND resolved_at IS NULL);
 SELECT jsonb_build_object('attemptId',res.attempt_id,'actionId',la.id,'startedAt',res.possible_send_at,'displayName',p.display_name,'profilePath',p.profile_path,'step',la.step,'kind',la.kind,
   'text',CASE la.step WHEN 0 THEN coalesce(ar.rendered_content->>'note','') WHEN 1 THEN ar.rendered_content->>'firstMessage' ELSE ar.rendered_content->'followups'->(la.step-2)->>'text' END)
  INTO current FROM sequence_private.send_reservations res JOIN sequence_private.logical_actions la ON la.id=res.action_id
  JOIN sequence_private.enrollments en ON en.id=la.enrollment_id JOIN public.seq_prospects p ON p.id=en.prospect_id
  JOIN sequence_private.approval_recipients ar ON ar.approval_id=en.approval_id AND ar.prospect_id=en.prospect_id
  WHERE res.account_id=a AND res.resolved_at IS NULL;
 SELECT coalesce(jsonb_agg(jsonb_build_object('actionId',q.id,'enrollmentId',q.enrollment_id,'prospectId',q.prospect_id,'displayName',q.display_name,'profilePath',q.profile_path,
   'campaignName',q.campaign_name,'step',q.step,'kind',q.kind,'dueAt',q.due_at,'text',q.text,
   'blocked',CASE WHEN busy THEN 'busy' WHEN q.campaign_status<>'Draft' THEN 'campaign-paused'
    WHEN q.kind='Invitation' AND q.connection='Unknown' THEN 'connection-unknown'
    WHEN q.kind='Invitation' AND q.connection='Pending' THEN 'already-pending'
    WHEN q.kind='Invitation' AND q.connection<>'NotConnected' THEN 'already-connected'
    WHEN q.kind='Message' AND q.connection<>'Connected' THEN 'awaiting-acceptance'
    WHEN q.due_at>now() THEN 'not-due'
    WHEN q.kind='Invitation' AND inv_today>=acc.invitation_cap THEN 'daily-cap'
    WHEN q.kind='Message' AND msg_today>=acc.message_cap THEN 'daily-cap'
    WHEN next_allowed>now() THEN 'spacing' END) ORDER BY q.due_at,q.id),'[]'::jsonb) INTO items
  FROM (SELECT la.id,la.enrollment_id,en.prospect_id,p.display_name,p.profile_path,ca.name AS campaign_name,ca.status AS campaign_status,la.step,la.kind,la.due_at,
    CASE la.step WHEN 0 THEN coalesce(ar.rendered_content->>'note','') WHEN 1 THEN ar.rendered_content->>'firstMessage' ELSE ar.rendered_content->'followups'->(la.step-2)->>'text' END AS text,
    sequence_private.queue_connection(en) AS connection
   FROM sequence_private.logical_actions la JOIN sequence_private.enrollments en ON en.id=la.enrollment_id
   JOIN public.seq_prospects p ON p.id=en.prospect_id JOIN public.seq_campaigns ca ON ca.id=en.campaign_id
   JOIN sequence_private.approval_recipients ar ON ar.approval_id=en.approval_id AND ar.prospect_id=en.prospect_id
   WHERE la.account_id=a AND la.state IN ('Planned','Due','NotSent')
    AND (en.status='Active' OR (en.status='Held' AND en.stop_reason IN ('execution-disabled','needs-verification')))) q;
 SELECT coalesce(jsonb_agg(jsonb_build_object('enrollmentId',en.id,'prospectId',en.prospect_id,'displayName',p.display_name,'profilePath',p.profile_path,'campaignName',ca.name,
   'status',en.status,'stopReason',en.stop_reason,'connection',sequence_private.queue_connection(en),
   'lastReport',(SELECT jsonb_build_object('connection',o.connection,'messageDirection',o.message_direction,'at',o.observed_at) FROM sequence_private.observations o
     WHERE o.account_id=a AND o.prospect_id=en.prospect_id AND o.observer_version='user-report-v1' AND o.observed_at>=en.created_at ORDER BY o.observed_at DESC,o.created_at DESC LIMIT 1),
   'lastObserved',(SELECT jsonb_build_object('connection',o.connection,'at',o.observed_at) FROM sequence_private.observations o
     WHERE o.account_id=a AND o.prospect_id=en.prospect_id AND o.observer_version='adapter-v1' AND o.message_direction IS NULL ORDER BY o.observed_at DESC,o.created_at DESC LIMIT 1))
   ORDER BY en.created_at,en.id),'[]'::jsonb) INTO people
  FROM sequence_private.enrollments en JOIN public.seq_prospects p ON p.id=en.prospect_id JOIN public.seq_campaigns ca ON ca.id=en.campaign_id
  WHERE en.account_id=a AND en.status IN ('Active','Waiting','Paused','Held');
 RETURN jsonb_build_object('executionMode',acc.execution_mode,'timezone',acc.timezone,'invitationsToday',inv_today,'invitationCap',acc.invitation_cap,
  'messagesToday',msg_today,'messageCap',acc.message_cap,'spacingMinutes',acc.spacing_minutes,'nextAllowedAt',next_allowed,'current',current,'items',items,'people',people);
END $$;
REVOKE ALL ON FUNCTION sequence_private.queue_view(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_backup,sequence_auth_runtime;

-- Owner operations on the queue. Start takes the account's lease with the account itself as the manual executor and records the
-- possible send before the user acts; only the user's answer resolves it. Reports are the user's own facts, labelled as such.
CREATE FUNCTION public.seq_queue(operation text, args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid; a uuid; acc public.seq_accounts%ROWTYPE; e sequence_private.enrollments%ROWTYPE; act sequence_private.logical_actions%ROWTYPE;
 att sequence_private.attempts%ROWTYPE; res sequence_private.send_reservations%ROWTYPE; lease uuid; item jsonb; blocked text; ev text; conn text; content jsonb; delay integer;
BEGIN
 IF jsonb_typeof(args) IS DISTINCT FROM 'object' OR octet_length(args::text)>4096 THEN RAISE EXCEPTION 'Invalid arguments' USING ERRCODE='22023'; END IF;
 SELECT id INTO w FROM public.seq_workspaces WHERE owner_id=auth.uid();
 IF w IS NULL OR NOT sequence_private.owns_workspace(w) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.seq_workspaces WHERE id=w FOR UPDATE;
 IF NOT sequence_private.owns_workspace(w) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO acc FROM public.seq_accounts WHERE workspace_id=w;
 a := acc.id;
 IF a IS NULL THEN RAISE EXCEPTION 'No account yet' USING ERRCODE='22023'; END IF;
 IF operation='list' THEN
  IF args <> '{}' THEN RAISE EXCEPTION 'Invalid list request' USING ERRCODE='22023'; END IF;
 ELSIF operation='start' THEN
  IF args-ARRAY['actionId'] <> '{}' OR coalesce(args->>'actionId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid start' USING ERRCODE='22023'; END IF;
  IF acc.execution_mode<>'manual' THEN RAISE EXCEPTION 'Manual sending is off' USING ERRCODE='22023'; END IF;
  SELECT value INTO item FROM jsonb_array_elements(sequence_private.queue_view(w,a)->'items') WHERE value->>'actionId'=args->>'actionId';
  IF item IS NULL THEN RAISE EXCEPTION 'Not in the queue' USING ERRCODE='22023'; END IF;
  blocked := item->>'blocked';
  IF blocked IS NOT NULL THEN RAISE EXCEPTION 'Blocked: %',blocked USING ERRCODE='55000'; END IF;
  SELECT * INTO act FROM sequence_private.logical_actions WHERE id=(args->>'actionId')::uuid AND account_id=a FOR UPDATE;
  lease := sequence_private.acquire_storage_lease(w,a,a);
  INSERT INTO sequence_private.attempts(workspace_id,account_id,action_id,lease_id,fence,attempt_number)
   SELECT w,a,act.id,l.id,l.fence,(SELECT coalesce(max(attempt_number),0)+1 FROM sequence_private.attempts WHERE action_id=act.id) FROM sequence_private.execution_leases l WHERE l.id=lease RETURNING * INTO att;
  PERFORM sequence_private.record_possible_send(w,a,att.id);
  UPDATE sequence_private.logical_actions SET state='MayHaveSent',revision=revision+1 WHERE id=act.id;
  UPDATE sequence_private.enrollments SET status='Active',stop_reason='manual-send',revision=revision+1 WHERE id=act.enrollment_id;
 ELSIF operation IN ('sent','not-sent') THEN
  IF args-ARRAY['attemptId'] <> '{}' OR coalesce(args->>'attemptId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid answer' USING ERRCODE='22023'; END IF;
  SELECT * INTO att FROM sequence_private.attempts WHERE id=(args->>'attemptId')::uuid AND account_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown attempt' USING ERRCODE='22023'; END IF;
  SELECT * INTO res FROM sequence_private.send_reservations WHERE attempt_id=att.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Nothing to answer' USING ERRCODE='22023'; END IF;
  IF res.resolved_at IS NULL THEN
   INSERT INTO sequence_private.attempt_results(workspace_id,account_id,action_id,attempt_id,outcome,observed_at,evidence_reference)
    VALUES(w,a,att.action_id,att.id,CASE operation WHEN 'sent' THEN 'ConfirmedSent' ELSE 'NotSent' END,now(),'user-report:'||att.id);
   PERFORM sequence_private.resolve_reservation(w,a,att.id);
   UPDATE sequence_private.account_execution_state SET lease_executor=NULL,lease_expires_at=NULL WHERE account_id=a AND lease_executor=a;
   SELECT * INTO e FROM sequence_private.enrollments en WHERE en.id=(SELECT enrollment_id FROM sequence_private.logical_actions WHERE id=att.action_id) FOR UPDATE;
   IF operation='not-sent' THEN
    UPDATE sequence_private.logical_actions SET state='NotSent',due_at=now()+make_interval(mins=>acc.spacing_minutes),revision=revision+1 WHERE id=att.action_id RETURNING * INTO act;
    IF e.status='Active' THEN UPDATE sequence_private.enrollments SET stop_reason='not-sent',revision=revision+1 WHERE id=e.id; END IF;
   ELSE
    UPDATE sequence_private.logical_actions SET state='ConfirmedSent',revision=revision+1 WHERE id=att.action_id RETURNING * INTO act;
    IF e.status NOT IN ('Stopped','Completed','Paused') THEN
     IF act.kind='Invitation' THEN
      INSERT INTO sequence_private.observations(workspace_id,account_id,prospect_id,observed_at,observer_version,connection,complete) VALUES(w,a,e.prospect_id,clock_timestamp(),'user-report-v1','Pending',true);
      UPDATE sequence_private.enrollments SET status='Waiting',stop_reason='awaiting-acceptance',revision=revision+1 WHERE id=e.id;
     ELSE
      SELECT rendered_content INTO content FROM sequence_private.approval_recipients WHERE approval_id=e.approval_id AND prospect_id=e.prospect_id;
      IF act.step-1 < jsonb_array_length(coalesce(content->'followups','[]'::jsonb)) THEN
       delay := (content->'followups'->(act.step-1)->>'delayDays')::integer;
       INSERT INTO sequence_private.logical_actions(workspace_id,account_id,enrollment_id,content_revision_id,step,kind,due_at,state)
        VALUES(w,a,e.id,e.content_revision_id,act.step+1,'Message',now()+make_interval(days=>delay),'Planned')
       ON CONFLICT(enrollment_id,step) DO UPDATE SET state='Planned',due_at=EXCLUDED.due_at,content_revision_id=EXCLUDED.content_revision_id,revision=sequence_private.logical_actions.revision+1
        WHERE sequence_private.logical_actions.state IN ('Cancelled','NotSent','Due','Planned');
       UPDATE sequence_private.enrollments SET status='Active',stop_reason='next-step',revision=revision+1 WHERE id=e.id;
      ELSE
       UPDATE sequence_private.enrollments SET status='Completed',stop_reason='final-step',revision=revision+1 WHERE id=e.id;
      END IF;
     END IF;
    END IF;
   END IF;
  END IF;
 ELSIF operation='report' THEN
  ev := args->>'event';
  IF args-ARRAY['enrollmentId','event'] <> '{}' OR coalesce(args->>'enrollmentId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR coalesce(ev,'') NOT IN ('accepted','replied','messaged','withdrawn','declined','already-connected','not-connected') THEN RAISE EXCEPTION 'Invalid report' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM sequence_private.send_reservations WHERE account_id=a AND resolved_at IS NULL) THEN RAISE EXCEPTION 'Answer the current step first' USING ERRCODE='55000'; END IF;
  SELECT * INTO e FROM sequence_private.enrollments WHERE id=(args->>'enrollmentId')::uuid AND account_id=a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown enrollment' USING ERRCODE='22023'; END IF;
  IF e.status IN ('Stopped','Completed') THEN RAISE EXCEPTION 'Sequence already ended' USING ERRCODE='40001'; END IF;
  conn := CASE ev WHEN 'accepted' THEN 'Connected' WHEN 'already-connected' THEN 'Connected' WHEN 'withdrawn' THEN 'WithdrawnConfirmed' WHEN 'declined' THEN 'RejectedConfirmed'
   WHEN 'not-connected' THEN 'NotConnected' ELSE sequence_private.queue_connection(e) END;
  INSERT INTO sequence_private.observations(workspace_id,account_id,prospect_id,observed_at,observer_version,connection,complete,message_direction,message_at)
   VALUES(w,a,e.prospect_id,clock_timestamp(),'user-report-v1',conn,true,CASE ev WHEN 'replied' THEN 'incoming' WHEN 'messaged' THEN 'outgoing' END,CASE WHEN ev IN ('replied','messaged') THEN clock_timestamp() END);
  IF ev IN ('accepted','already-connected') THEN
   UPDATE sequence_private.logical_actions SET state='Skipped',revision=revision+1 WHERE enrollment_id=e.id AND step=0 AND state IN ('Planned','Due','NotSent','Cancelled');
   INSERT INTO sequence_private.logical_actions(workspace_id,account_id,enrollment_id,content_revision_id,step,kind,due_at,state) VALUES(w,a,e.id,e.content_revision_id,1,'Message',now(),'Due')
   ON CONFLICT(enrollment_id,step) DO UPDATE SET state='Due',due_at=EXCLUDED.due_at,content_revision_id=EXCLUDED.content_revision_id,revision=sequence_private.logical_actions.revision+1
    WHERE sequence_private.logical_actions.state='Cancelled';
   IF e.status IN ('Waiting','Held','Active') THEN UPDATE sequence_private.enrollments SET status='Active',stop_reason=ev,revision=revision+1 WHERE id=e.id; END IF;
  ELSIF ev='not-connected' THEN
   IF e.status='Held' AND e.stop_reason='needs-verification' THEN UPDATE sequence_private.enrollments SET stop_reason='execution-disabled',revision=revision+1 WHERE id=e.id; END IF;
  ELSE
   UPDATE sequence_private.enrollments SET status='Stopped',stop_reason=CASE ev WHEN 'messaged' THEN 'manual-takeover' ELSE ev END,revision=revision+1 WHERE id=e.id;
   UPDATE sequence_private.logical_actions SET state='Cancelled',revision=revision+1 WHERE enrollment_id=e.id AND state NOT IN ('ConfirmedSent','MayHaveSent','OutcomeUnknown','Skipped','Cancelled');
  END IF;
 ELSE
  RAISE EXCEPTION 'Invalid operation' USING ERRCODE='22023';
 END IF;
 RETURN sequence_private.queue_view(w,a);
END $$;
REVOKE ALL ON FUNCTION public.seq_queue(text,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.seq_queue(text,jsonb) TO authenticated;

-- Execution settings accept the manual mode and the workload controls; the extension's watchlist covers the manual mode.
CREATE OR REPLACE FUNCTION public.seq_executors(operation text, args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
   'bound',coalesce(acc.external_identity,'') LIKE 'linkedin:%','invitationCap',acc.invitation_cap,'messageCap',acc.message_cap,'spacingMinutes',acc.spacing_minutes,
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
  IF args-ARRAY['timezone','executionMode','acknowledged','invitationCap','messageCap','spacingMinutes'] <> '{}' OR jsonb_typeof(args->'acknowledged') IS DISTINCT FROM 'boolean'
   OR coalesce(args->>'invitationCap','1') !~ '^[0-9]{1,2}$' OR coalesce(args->>'messageCap','1') !~ '^[0-9]{1,2}$' OR coalesce(args->>'spacingMinutes','1') !~ '^[0-9]{1,2}$'
   OR coalesce((args->>'invitationCap')::integer,1) NOT BETWEEN 1 AND 20 OR coalesce((args->>'messageCap')::integer,1) NOT BETWEEN 1 AND 40 OR coalesce((args->>'spacingMinutes')::integer,1) NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'Invalid settings' USING ERRCODE='22023'; END IF;
  IF a IS NULL THEN RAISE EXCEPTION 'No account yet' USING ERRCODE='22023'; END IF;
  tz := args->>'timezone'; mode := args->>'executionMode';
  IF tz IS NOT NULL AND (length(tz)>64 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names n WHERE n.name=tz)) THEN RAISE EXCEPTION 'Unknown timezone' USING ERRCODE='22023'; END IF;
  IF mode IS NULL OR mode NOT IN ('disabled','observe','manual') THEN RAISE EXCEPTION 'Invalid execution mode' USING ERRCODE='22023'; END IF;
  IF mode IN ('observe','manual') AND (coalesce(acc.external_identity,'') NOT LIKE 'linkedin:%' OR coalesce(tz,acc.timezone) IS NULL OR NOT (args->'acknowledged')::boolean) THEN
   RAISE EXCEPTION 'Observation needs a bound account, a timezone and the acknowledgement' USING ERRCODE='22023'; END IF;
  UPDATE public.seq_accounts SET timezone=coalesce(tz,timezone),execution_mode=mode,invitation_cap=coalesce((args->>'invitationCap')::integer,invitation_cap),
   message_cap=coalesce((args->>'messageCap')::integer,message_cap),spacing_minutes=coalesce((args->>'spacingMinutes')::integer,spacing_minutes),
   execution_acknowledged_at=CASE WHEN (args->'acknowledged')::boolean THEN coalesce(execution_acknowledged_at,now()) ELSE execution_acknowledged_at END,revision=revision+1 WHERE id=a;
  RETURN public.seq_executors('list','{}'::jsonb);
 END IF;
 RAISE EXCEPTION 'Invalid operation' USING ERRCODE='22023';
END $$;

CREATE OR REPLACE FUNCTION sequence_private.executor_operation(operation text, args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
  IF acc.execution_mode NOT IN ('observe','manual') OR identity<>'match' THEN RETURN jsonb_build_object('executionMode',acc.execution_mode,'identity',identity,'people','[]'::jsonb); END IF;
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
NOTIFY pgrst, 'reload schema';
