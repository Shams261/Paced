-- S3-005: owner-scoped synthetic management. No dispatch authority.
CREATE TABLE sequence_private.management_requests (
 workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id), request_id uuid NOT NULL,
 request jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,request_id));
ALTER TABLE sequence_private.management_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.management_requests FROM PUBLIC, anon, authenticated, service_role, sequence_worker;

CREATE FUNCTION sequence_private.management_catalog() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT '[{"key":"sample-ada","name":"Ada Example","company":"Example Systems","role":"Software Engineer","connection":"NotConnected"},{"key":"sample-ben","name":"Ben Example","company":"Example Systems","role":"Engineer","connection":"Pending"},{"key":"sample-cara","name":"Cara Example","company":"Example Labs","role":"Engineer","connection":"Connected"},{"key":"sample-dev","name":"Dev Example","company":"","role":"Engineer","connection":"Unknown"},{"key":"sample-emi","name":"Emi Example","company":"Example Labs","role":"Engineer","connection":"RejectedConfirmed"},{"key":"sample-finn","name":"Finn Example","company":"Example Labs","role":"Engineer","connection":"WithdrawnConfirmed"}]'::jsonb;
$$;
REVOKE ALL ON FUNCTION sequence_private.management_catalog() FROM PUBLIC;

CREATE FUNCTION sequence_private.render_management(content jsonb, person jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE result jsonb='{}'; item record; rendered text; steps jsonb='[]'; part jsonb;
BEGIN
 IF jsonb_typeof(content) IS DISTINCT FROM 'object' OR
    (content - ARRAY['note','firstMessage','followups']) <> '{}' OR
    jsonb_typeof(content->'note') IS DISTINCT FROM 'string' OR
    jsonb_typeof(content->'firstMessage') IS DISTINCT FROM 'string' OR
    length(btrim(content->>'firstMessage')) NOT BETWEEN 1 AND 2000 OR
    length(content->>'note')>2000 OR
    jsonb_typeof(content->'followups') IS DISTINCT FROM 'array' OR jsonb_array_length(content->'followups')>3
 THEN RAISE EXCEPTION 'Invalid content' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT * FROM jsonb_each_text(jsonb_build_object('note',content->>'note','firstMessage',content->>'firstMessage')) LOOP
  rendered=item.value;
  IF (rendered LIKE '%{{name}}%' AND coalesce(person->>'name','')='') OR
     (rendered LIKE '%{{company}}%' AND coalesce(person->>'company','')='') OR
     (rendered LIKE '%{{role}}%' AND coalesce(person->>'role','')='')
  THEN RAISE EXCEPTION 'Missing substitution field' USING ERRCODE='22023'; END IF;
  rendered=replace(replace(replace(rendered,'{{name}}',coalesce(person->>'name','')),'{{company}}',coalesce(person->>'company','')),'{{role}}',coalesce(person->>'role',''));
  IF rendered LIKE '%{{%' OR rendered LIKE '%}}%' THEN RAISE EXCEPTION 'Unknown substitution' USING ERRCODE='22023'; END IF;
  result=result || jsonb_build_object(item.key,rendered);
 END LOOP;
 FOR part IN SELECT value FROM jsonb_array_elements(content->'followups') LOOP
  IF jsonb_typeof(part) IS DISTINCT FROM 'object' OR (part - ARRAY['text','delayDays']) <> '{}' OR
     jsonb_typeof(part->'text') IS DISTINCT FROM 'string' OR length(btrim(part->>'text')) NOT BETWEEN 1 AND 2000 OR
     jsonb_typeof(part->'delayDays') IS DISTINCT FROM 'number' OR (part->>'delayDays') !~ '^[0-9]+$' OR (part->>'delayDays')::numeric NOT BETWEEN 1 AND 365
  THEN RAISE EXCEPTION 'Invalid follow-up' USING ERRCODE='22023'; END IF;
  rendered=sequence_private.render_management(jsonb_build_object('note','','firstMessage',part->>'text','followups','[]'::jsonb),person)->>'firstMessage';
  steps=steps || jsonb_build_array(jsonb_build_object('text',rendered,'delayDays',(part->>'delayDays')::integer));
 END LOOP;
 RETURN result || jsonb_build_object('followups',steps);
END $$;
REVOKE ALL ON FUNCTION sequence_private.render_management(jsonb,jsonb) FROM PUBLIC;

-- Preserve direct editable profile/list interfaces while enforcing the same account limit.
CREATE FUNCTION sequence_private.guard_prospect_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM 1 FROM public.seq_workspaces WHERE id=NEW.workspace_id FOR UPDATE;
 IF (SELECT count(*) FROM public.seq_prospects WHERE account_id=NEW.account_id)>=1000 THEN
  RAISE EXCEPTION 'Prospect limit reached' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sequence_private.guard_prospect_capacity() FROM PUBLIC;
CREATE TRIGGER guard_prospect_capacity BEFORE INSERT ON public.seq_prospects FOR EACH ROW EXECUTE FUNCTION sequence_private.guard_prospect_capacity();

CREATE FUNCTION public.seq_manage(operation text, args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
   'enrollments',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT e.id,e.campaign_id,e.prospect_id,p.display_name,e.status,e.stop_reason FROM sequence_private.enrollments e JOIN public.seq_prospects p ON p.id=e.prospect_id WHERE e.workspace_id=w ORDER BY e.created_at,e.id LIMIT 50 OFFSET pg*50) x),'[]'));
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
 IF operation IN ('import-preview','import') THEN
  IF args-ARRAY['operation','requestId','keys','listName'] <> '{}' OR jsonb_typeof(args->'keys') IS DISTINCT FROM 'array' OR jsonb_array_length(args->'keys') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid import' USING ERRCODE='22023'; END IF;
  IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(args->'keys')) <> jsonb_array_length(args->'keys') THEN RAISE EXCEPTION 'Duplicate keys' USING ERRCODE='22023'; END IF;
  SELECT jsonb_agg(value ORDER BY value->>'key') INTO selected FROM jsonb_array_elements(sequence_private.management_catalog()) WHERE (args->'keys') ? (value->>'key');
  IF selected IS NULL OR jsonb_array_length(selected) <> jsonb_array_length(args->'keys') THEN RAISE EXCEPTION 'Unknown synthetic keys' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM public.seq_prospects WHERE workspace_id=w)+(SELECT count(*) FROM jsonb_array_elements(selected) x WHERE NOT EXISTS(SELECT 1 FROM public.seq_prospects p WHERE p.account_id=a AND p.recipient_key=x.value->>'key'))>1000 THEN RAISE EXCEPTION 'Prospect limit' USING ERRCODE='22023'; END IF;
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
   FOR p IN SELECT * FROM public.seq_prospects WHERE workspace_id=w AND (cr.settings->'recipients') ? id::text ORDER BY id LOOP
    IF p.source <> 'synthetic' THEN RAISE EXCEPTION 'Unsupported source' USING ERRCODE='22023'; END IF;
    rendered=sequence_private.render_management(content,jsonb_build_object('name',p.display_name,'company',p.company,'role',p.role_title));
    stat=CASE p.connection WHEN 'Connected' THEN 'Excluded' WHEN 'Pending' THEN 'Waiting' WHEN 'RejectedConfirmed' THEN 'Stopped' WHEN 'WithdrawnConfirmed' THEN 'Stopped' ELSE 'Held' END;
    IF EXISTS(SELECT 1 FROM sequence_private.enrollments WHERE campaign_id=cid AND prospect_id=p.id AND status IN ('Stopped','Completed')) THEN stat='Terminal'; END IF;
    preview=preview || jsonb_build_array(jsonb_build_object('id',p.id,'name',p.display_name,'disposition',stat,'content',rendered,'profileRevision',p.revision));
   END LOOP;
   IF jsonb_array_length(preview)<>jsonb_array_length(cr.settings->'recipients') THEN RAISE EXCEPTION 'Recipients changed' USING ERRCODE='40001'; END IF;
   fingerprint=md5(jsonb_build_object('campaign',cid,'revision',c.revision,'rows',preview)::text);
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
REVOKE ALL ON FUNCTION public.seq_manage(text,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.seq_manage(text,jsonb) TO authenticated;
NOTIFY pgrst, 'reload schema';
