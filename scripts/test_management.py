"""S3-005 integration cases; executed by the guarded hosted database suite."""
import json
from test_database import check, role, assert_sql, deny, uid, W, A, P, C, E, ACT

def rpc(operation, args):
    payload=json.dumps(args).replace("'", "''")
    return f"public.seq_manage('{operation}','{payload}'::jsonb)"

def integration():
    imp={'requestId':uid(90), 'keys':['sample-ada','sample-ben','sample-cara','sample-dev','sample-emi','sample-finn'], 'listName':'Test samples'}
    import_sql=f"SELECT {rpc('import',imp)};"
    check('management snapshot tenant and no send authority',role()+assert_sql(f"({rpc('snapshot',{'page':0})}->>'totalProspects')::int=1 AND ({rpc('snapshot',{'page':0})}->>'sendingEnabled')::boolean=false"))
    check('management anonymous denied',role('anon','')+deny(f"SELECT {rpc('snapshot',{'page':0})}",'42501'))
    check('management forged workspace rejected',role()+deny(f"SELECT {rpc('import-preview',{'keys':['sample-ada'],'workspaceId':uid(2,2)})}",'22023'))
    check('management preview does not write',role()+f"SELECT {rpc('import-preview',{'keys':['sample-ada']})};"+assert_sql(f"(SELECT count(*) FROM public.seq_prospects WHERE workspace_id='{W}')=1"))
    for keys in [[],['bad'],['sample-ada','sample-ada']]:
        check('management invalid selection '+str(keys),role()+deny(f"SELECT {rpc('import-preview',{'keys':keys})}",'22023'))
    check('management import retry and different-payload conflict',role()+import_sql+import_sql+assert_sql(f"(SELECT count(*) FROM public.seq_prospects WHERE workspace_id='{W}')=7")+deny(f"SELECT {rpc('import',{**imp,'listName':'changed'})}",'40001'))
    check('management import deduplicates across lists',role()+import_sql+f"SELECT {rpc('import',{**imp,'requestId':uid(91)})};"+assert_sql(f"(SELECT count(*) FROM public.seq_prospects WHERE workspace_id='{W}')=7"))
    capacity=f"INSERT INTO public.seq_prospects(workspace_id,account_id,recipient_key,display_name,source,observed_at) SELECT '{W}','{A}','limit-'||n,'Capacity sample','synthetic',now() FROM generate_series(1,999) n;"
    check('management capacity enforced on direct writes and RPC',role()+deny(f"SELECT {rpc('import',imp)}",'22023')+deny(f"INSERT INTO public.seq_prospects(workspace_id,account_id,recipient_key,display_name,source,observed_at) VALUES('{W}','{A}','excess','Overflow','synthetic',now())",'22023'),capacity)
    content={'note':'Hi {{name}}','firstMessage':'Thanks {{name}}','followups':[{'text':'Checking in {{name}}','delayDays':3}]}
    draft={'requestId':uid(92),'campaignId':None,'revision':None,'name':'Durable draft','recipients':[P],'content':content}
    check('management foreign recipients denied',role()+deny(f"SELECT {rpc('save-draft',{**draft,'recipients':[uid(4,2)]})}",'42501'))
    check('management unknown placeholders rejected',role()+deny(f"SELECT {rpc('save-draft',{**draft,'content':{**content,'note':'Hi {{secret}}'}})}",'22023'))
    # One transaction exercises persisted preview, approvals, edits and controls.
    check('management approval lifecycle, pending/rejection/absence and stop fence',role()+import_sql+"""
DO $$ DECLARE d jsonb; b jsonb; pre jsonb; snap jsonb; BEGIN
 SELECT jsonb_build_object('requestId','00000092-0000-0000-0000-000000000001','campaignId',null,'revision',null,'name','Campaign','recipients',jsonb_agg(id::text),'content','{"note":"Hi {{name}}","firstMessage":"Thanks {{name}}","followups":[]}'::jsonb)
 INTO b FROM public.seq_prospects WHERE recipient_key LIKE 'sample-%';
 d=public.seq_manage('save-draft',b);
 pre=public.seq_manage('approval-preview',d);
 PERFORM public.seq_manage('approve',d||jsonb_build_object('requestId',gen_random_uuid(),'preview',pre->>'fingerprint'));
 snap=public.seq_manage('snapshot','{"page":0}');
 IF (SELECT count(*) FROM jsonb_array_elements(snap->'enrollments') e WHERE e->>'status'='Waiting')<>1 OR
    (SELECT count(*) FROM jsonb_array_elements(snap->'enrollments') e WHERE e->>'status'='Stopped')<>2 OR
    (SELECT count(*) FROM jsonb_array_elements(snap->'enrollments') e WHERE e->>'stop_reason'='needs-verification')<>1 THEN RAISE EXCEPTION 'State mapping failed'; END IF;
 d=public.seq_manage('control',d||jsonb_build_object('requestId',gen_random_uuid(),'action','pause'));
 IF EXISTS(SELECT 1 FROM sequence_private.enrollments WHERE campaign_id=(d->>'campaignId')::uuid AND status NOT IN ('Paused','Stopped')) THEN RAISE EXCEPTION 'Pause failed'; END IF;
 d=public.seq_manage('control',d||jsonb_build_object('requestId',gen_random_uuid(),'action','resume'));
 d=public.seq_manage('save-draft',b||d||jsonb_build_object('requestId',gen_random_uuid(),'name','Edited'));
 pre=public.seq_manage('approval-preview',d);
 PERFORM public.seq_manage('approve',d||jsonb_build_object('requestId',gen_random_uuid(),'preview',pre->>'fingerprint'));
 d=public.seq_manage('control',d||jsonb_build_object('requestId',gen_random_uuid(),'action','stop'));
 IF EXISTS(SELECT 1 FROM sequence_private.enrollments WHERE campaign_id=(d->>'campaignId')::uuid AND status<>'Stopped') THEN RAISE EXCEPTION 'Stop failed'; END IF;
END $$;
""")
    check('management stale revision and forged campaign rejected',role()+deny(f"SELECT {rpc('control',{'requestId':uid(93),'campaignId':C,'revision':55,'action':'stop'})}",'40001')+deny(f"SELECT {rpc('control',{'requestId':uid(93),'campaignId':uid(6,2),'revision':1,'action':'stop'})}",'42501'))
    check('management stop cancels intent and invalidates approval',role()+f"SELECT {rpc('control',{'requestId':uid(93),'campaignId':C,'revision':1,'action':'stop'})};"+assert_sql(f"(SELECT status='Stopped' FROM sequence_private.enrollments WHERE id='{E}')")+'RESET ROLE;'+assert_sql(f"(SELECT state='Cancelled' FROM sequence_private.logical_actions WHERE id='{ACT}')"))
    check('management missing field prevents approval',role()+import_sql+"""
DO $$ DECLARE d jsonb; BEGIN
 SELECT public.seq_manage('save-draft',jsonb_build_object('requestId',gen_random_uuid(),'campaignId',null,'revision',null,'name','Missing','recipients',jsonb_build_array(id::text),'content','{"note":"","firstMessage":"Hi {{company}}","followups":[]}'::jsonb)) INTO d FROM public.seq_prospects WHERE recipient_key='sample-dev';
 BEGIN PERFORM public.seq_manage('approval-preview',d); EXCEPTION WHEN SQLSTATE '22023' THEN RETURN; END;
 RAISE EXCEPTION 'Missing field accepted'; END $$;
""")
    check('management duplicate enrollment rolls back approval',role()+f"""
DO $$ DECLARE d jsonb; pre jsonb; BEGIN
 d={rpc('save-draft',draft)}; pre=public.seq_manage('approval-preview',d);
 BEGIN PERFORM public.seq_manage('approve',d||jsonb_build_object('requestId',gen_random_uuid(),'preview',pre->>'fingerprint')); EXCEPTION WHEN SQLSTATE '23505' THEN RETURN; END;
 RAISE EXCEPTION 'Duplicate enrollment accepted'; END $$;
""")
    check('management changed profile invalidates approval and preview',role()+"""
DO $$ DECLARE d jsonb; pre jsonb; p uuid; BEGIN
 SELECT id INTO p FROM public.seq_prospects LIMIT 1;
 d=public.seq_manage('save-draft',jsonb_build_object('requestId',gen_random_uuid(),'campaignId',null,'revision',null,'name','Profile change','recipients',jsonb_build_array(p::text),'content','{"note":"","firstMessage":"Hi {{name}}","followups":[]}'::jsonb));
 pre=public.seq_manage('approval-preview',d);
 UPDATE public.seq_prospects SET display_name='Updated example' WHERE id=p;
 BEGIN PERFORM public.seq_manage('approve',d||jsonb_build_object('requestId',gen_random_uuid(),'preview',pre->>'fingerprint')); EXCEPTION WHEN SQLSTATE '40001' THEN RETURN; END;
 RAISE EXCEPTION 'Stale profile approval accepted'; END $$;
""")
    check('management direct campaign edit fences existing intent',role()+f"UPDATE public.seq_campaigns SET name='Edited directly' WHERE id='{C}';"+assert_sql(f"(SELECT status='Held' AND stop_reason='approval-required' FROM sequence_private.enrollments WHERE id='{E}')")+'RESET ROLE;'+assert_sql(f"(SELECT state='Cancelled' FROM sequence_private.logical_actions WHERE id='{ACT}')"))
    check('management reapproval preserves old action content',role()+f"""
DO $$ DECLARE d jsonb; pre jsonb; BEGIN
 d=public.seq_manage('save-draft',jsonb_build_object('requestId',gen_random_uuid(),'campaignId','{C}','revision',1,'name','Edited','recipients',jsonb_build_array('{P}'),'content','{{"note":"","firstMessage":"Changed text","followups":[]}}'::jsonb));
 pre=public.seq_manage('approval-preview',d);
 PERFORM public.seq_manage('approve',d||jsonb_build_object('requestId',gen_random_uuid(),'preview',pre->>'fingerprint'));
 END $$; RESET ROLE;
"""+assert_sql(f"(SELECT content_revision_id='{uid(7)}' AND state='Cancelled' FROM sequence_private.logical_actions WHERE id='{ACT}')"))

def races():
    from concurrent.futures import ThreadPoolExecutor
    import test_database as db
    from database import execute
    db.marker()
    execute('test','BEGIN;'+db.FIXTURE+'COMMIT;')
    try:
        def run(_):
            return execute('test','BEGIN;'+role()+f"SELECT {rpc('import',{'requestId':uid(94),'keys':['sample-ada'],'listName':'Concurrent sample'})}; SELECT pg_sleep(1); COMMIT;")
        with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(run,[1,2]))
        if results[0]!=results[1]: raise AssertionError('Retries returned different results')
        if execute('test',f"SELECT count(*) FROM public.seq_lists WHERE workspace_id='{W}' AND name='Concurrent sample';")!='1': raise AssertionError('Duplicate mutation')
        db.count+=1;print('PASS management two simultaneous identical requests commit once',flush=True)
        def conflict(n):
            try:
                execute('test','BEGIN;'+role()+f"SELECT {rpc('control',{'requestId':uid(n),'campaignId':C,'revision':1,'action':'pause'})}; SELECT pg_sleep(1);COMMIT;")
                return 'ok'
            except RuntimeError as error:
                if 'Stale revision' in str(error):return 'conflict'
                raise
        with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(conflict,[95,96]))
        if sorted(results)!=['conflict','ok']:raise AssertionError('Concurrent revisions accepted')
        db.count+=1;print('PASS management two simultaneous controls reject stale revision',flush=True)
    finally:db.cleanup_fixture()
