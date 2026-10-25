"""Integration checks use the fixed synthetic test project, never development."""
import argparse
import sys
if __name__ == "__main__":
    sys.modules["test_database"] = sys.modules[__name__]
import base64
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import secrets
import urllib.request
import urllib.error
from database import ROOT, TARGETS, execute, guard_test, migrate, rebuild_test

FIXTURE = (ROOT / 'supabase/tests/fixtures.sql').read_text()

def uid(k, n=1): return f'{k:08d}-0000-0000-0000-{n:012d}'
U,W,A,P,L,C,R,AP,O,E,ACT = [uid(i) for i in range(1,12)]

def role(name='authenticated', user=U):
    claims=json.dumps({'sub':user or None,'session_id':uid(50,2 if user==uid(1,2) else 1)})
    return f"SET LOCAL ROLE {name}; SELECT set_config('request.jwt.claim.sub','{user}',true); SELECT set_config('request.jwt.claims','{claims}',true);"

def assert_sql(expression):
    return f"DO $$ BEGIN IF NOT ({expression}) THEN RAISE EXCEPTION 'Assertion failed'; END IF; END $$;"

def deny(sql, state):
    return f"""DO $$ BEGIN
 BEGIN {sql}; EXCEPTION WHEN SQLSTATE '{state}' THEN RETURN; END;
 RAISE EXCEPTION 'Expected SQLSTATE {state}'; END $$;"""

count=0

def check(name, sql, setup=''):
    global count
    execute('test', 'BEGIN;'+FIXTURE+setup+sql+'ROLLBACK;')
    count+=1;print('PASS',name,flush=True)


def enrollment(newid):
    return f"INSERT INTO sequence_private.enrollments(id,workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id,baseline_observation_id,status) VALUES('{newid}','{W}','{A}','{C}','{R}','{AP}','{P}','{O}','Held')"


def lease_attempt():
    return role('sequence_worker')+f"""
SELECT sequence_private.acquire_storage_lease('{W}','{A}','{uid(20)}');
INSERT INTO sequence_private.attempts(id,workspace_id,account_id,action_id,lease_id,fence,attempt_number)
 SELECT '{uid(21)}','{W}','{A}','{ACT}',id,fence,1 FROM sequence_private.execution_leases WHERE account_id='{A}';
"""


def integration():
    for table in ['workspaces','accounts','prospects','lists','campaigns']:
        check('tenant SELECT '+table,role()+assert_sql(f'(SELECT count(*) FROM public.seq_{table})=1'))
    check('own prospect edit and revision',role()+f"UPDATE public.seq_prospects SET display_name='Edited' WHERE id='{P}';"+assert_sql(f"(SELECT revision=2 AND display_name='Edited' FROM public.seq_prospects WHERE id='{P}')"))
    check('foreign update/delete affect zero',role()+f"UPDATE public.seq_prospects SET display_name='Forged' WHERE id='{uid(4,2)}'; DELETE FROM public.seq_lists WHERE id='{uid(5,2)}'; RESET ROLE;"+assert_sql(f"(SELECT display_name='Example Person' FROM public.seq_prospects WHERE id='{uid(4,2)}')")+assert_sql(f"EXISTS(SELECT 1 FROM public.seq_lists WHERE id='{uid(5,2)}')"))
    check('foreign insert denied',role()+deny(f"INSERT INTO public.seq_lists(workspace_id,account_id,name) VALUES('{uid(2,2)}','{uid(3,2)}','Forged')",'42501'))
    check('forged cross-account FK denied',role()+deny(f"INSERT INTO public.seq_lists(workspace_id,account_id,name) VALUES('{W}','{uid(3,2)}','Forged')",'23503'))
    check('forged membership FK denied',role()+deny(f"INSERT INTO public.seq_list_memberships(workspace_id,account_id,list_id,prospect_id) VALUES('{W}','{A}','{L}','{uid(4,2)}')",'23503'))
    check('owner mutation denied',role()+deny(f"UPDATE public.seq_workspaces SET owner_id='{uid(1,2)}' WHERE id='{W}'",'42501'))
    check('identity mutation denied',role()+deny(f"UPDATE public.seq_prospects SET recipient_key='other' WHERE id='{P}'",'42501'))
    check('account sending disabled',deny(f"UPDATE public.seq_accounts SET sending_enabled=true WHERE id='{A}'",'23514'))
    check('anon denied',role('anon','')+deny('SELECT * FROM public.seq_prospects','42501'))
    check('null user sees nothing',role(user='')+assert_sql('(SELECT count(*) FROM public.seq_prospects)=0'))
    check('revoked user sees nothing',role()+assert_sql('(SELECT count(*) FROM public.seq_prospects)=0'),f"UPDATE sequence_private.access_allowlist SET active=false WHERE user_id='{U}';")
    check('client and authenticator have no worker membership',assert_sql("NOT pg_has_role('authenticated','sequence_worker','MEMBER') AND NOT pg_has_role('anon','sequence_worker','MEMBER') AND NOT pg_has_role('authenticator','sequence_worker','MEMBER')"))
    check('client cannot approve',role()+deny(f"UPDATE sequence_private.approvals SET settings_revision=9 WHERE id='{AP}'",'42501'))
    check('client cannot lease',role()+deny(f"SELECT sequence_private.acquire_storage_lease('{W}','{A}','{uid(20)}')",'42501'))
    check('worker cannot forge tenant',role('sequence_worker')+deny(f"SELECT sequence_private.acquire_storage_lease('{uid(2,2)}','{uid(3,2)}','{uid(20)}')",'42501'))
    for state in ['Active','Waiting','Paused','Held']:
        check('reservation includes '+state,role('sequence_worker')+deny(enrollment(uid(30)),'23505'),f"UPDATE sequence_private.enrollments SET status='{state}' WHERE id='{E}';")
    check('terminal releases enrollment slot',role('sequence_worker')+enrollment(uid(30))+';',f"UPDATE sequence_private.enrollments SET status='Stopped' WHERE id='{E}';")
    check('logical step unique',role('sequence_worker')+deny(f"INSERT INTO sequence_private.logical_actions(workspace_id,account_id,enrollment_id,content_revision_id,step,kind,due_at) VALUES('{W}','{A}','{E}','{R}',0,'Invitation',now())",'23505'))
    check('cross-campaign revision rejected',role('sequence_worker')+deny(f"INSERT INTO sequence_private.approvals(workspace_id,account_id,campaign_id,content_revision_id,approver_id,settings_revision) VALUES('{W}','{A}','{C}','{uid(7,2)}','{U}',1)",'23503'))
    check('cross-recipient baseline rejected',role('sequence_worker')+deny(f"UPDATE sequence_private.enrollments SET status='Stopped' WHERE id='{E}'; INSERT INTO sequence_private.enrollments(workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id,baseline_observation_id) VALUES('{W}','{A}','{C}','{R}','{AP}','{P}','{uid(9,2)}')",'23503'))
    check('attempt and possible-send idempotency',lease_attempt()+f"SELECT sequence_private.record_possible_send('{W}','{A}','{uid(21)}'); SELECT sequence_private.record_possible_send('{W}','{A}','{uid(21)}');"+assert_sql('(SELECT count(*) FROM sequence_private.send_reservations)=1'))
    check('immutable result denies update/delete',lease_attempt()+deny('UPDATE sequence_private.attempt_results SET evidence_reference=\'changed\'','42501')+deny('DELETE FROM sequence_private.attempt_results','42501'))
    check('client own list CRUD',role()+f"INSERT INTO public.seq_lists(id,workspace_id,account_id,name) VALUES('{uid(40)}','{W}','{A}','New'); UPDATE public.seq_lists SET name='Renamed' WHERE id='{uid(40)}'; DELETE FROM public.seq_lists WHERE id='{uid(40)}';"+assert_sql(f"NOT EXISTS(SELECT 1 FROM public.seq_lists WHERE id='{uid(40)}')"))
    check('forged approver rejected',role('sequence_worker')+deny(f"INSERT INTO sequence_private.approvals(workspace_id,account_id,campaign_id,content_revision_id,approver_id,settings_revision) VALUES('{W}','{A}','{C}','{R}','{uid(1,2)}',1)",'23514'))
    check('worker cannot bypass reservation function',role('sequence_worker')+deny('INSERT INTO sequence_private.send_reservations DEFAULT VALUES','42501'))
    check('all application tables RLS enabled',assert_sql("NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND (n.nspname='sequence_private' OR (n.nspname='public' AND c.relname LIKE 'seq_%')) AND NOT c.relrowsecurity)"))
    check('duplicate attempt number rejected',lease_attempt()+deny(f"INSERT INTO sequence_private.attempts(workspace_id,account_id,action_id,lease_id,fence,attempt_number) SELECT '{W}','{A}','{ACT}',id,fence,1 FROM sequence_private.execution_leases WHERE account_id='{A}'",'23505'))
    expired=f"RESET ROLE; UPDATE sequence_private.account_execution_state SET lease_expires_at=now()-interval '1 second' WHERE account_id='{A}';"+role('sequence_worker')
    check('expired lease cannot mark possible-send',lease_attempt()+expired+deny(f"SELECT sequence_private.record_possible_send('{W}','{A}','{uid(21)}')",'55000'))
    check('old fence rejected after lease replacement',lease_attempt()+expired+f"SELECT sequence_private.acquire_storage_lease('{W}','{A}','{uid(22)}');"+deny(f"SELECT sequence_private.record_possible_send('{W}','{A}','{uid(21)}')",'55000'))
    check('unknown survives stop/lease expiry',lease_attempt()+f"SELECT sequence_private.record_possible_send('{W}','{A}','{uid(21)}'); UPDATE sequence_private.enrollments SET status='Stopped' WHERE id='{E}';"+expired+deny(f"SELECT sequence_private.acquire_storage_lease('{W}','{A}','{uid(22)}')",'55000')+assert_sql('(SELECT count(*) FROM sequence_private.send_reservations WHERE resolved_at IS NULL)=1'))
    check('cannot resolve without final evidence',lease_attempt()+f"SELECT sequence_private.record_possible_send('{W}','{A}','{uid(21)}');"+deny(f"SELECT sequence_private.resolve_reservation('{W}','{A}','{uid(21)}')",'P0002'))
    check('positive resolution releases reservation',lease_attempt()+f"""
SELECT sequence_private.record_possible_send('{W}','{A}','{uid(21)}');
INSERT INTO sequence_private.attempt_results(workspace_id,account_id,action_id,attempt_id,outcome,observed_at,evidence_reference)
 VALUES('{W}','{A}','{ACT}','{uid(21)}','NotSent',now(),'synthetic-positive-non-send');
SELECT sequence_private.resolve_reservation('{W}','{A}','{uid(21)}');
"""+expired+f"SELECT sequence_private.acquire_storage_lease('{W}','{A}','{uid(22)}');"+assert_sql('(SELECT count(*) FROM sequence_private.send_reservations WHERE resolved_at IS NULL)=0'))


def auth_sessions():
    h="repeat('A',43)"
    def op(name, extra=""):
        return f"sequence_private.auth_session_operation('{name}',jsonb_build_object('hash',{h}{extra}))"
    runtime=role('sequence_auth_runtime')
    check('runtime cannot read tables',runtime+deny('SELECT * FROM sequence_private.auth_sessions','42501')+deny('SELECT * FROM auth.users','42501')+deny('SELECT * FROM public.seq_prospects','42501'))
    check('runtime cannot administer admission',runtime+deny('UPDATE sequence_private.access_allowlist SET active=true','42501'))
    check('client cannot invoke session operations',role()+deny('SELECT '+op('read'),'42501'))
    check('runtime reads valid session',runtime+assert_sql(f"{op('read')}->>'userId'='{U}'"))
    for name,setup in [
        ('idle',"UPDATE sequence_private.auth_sessions SET last_seen_at=now()-interval '31 minutes';"),
        ('absolute',"UPDATE sequence_private.auth_sessions SET expires_at=now()-interval '1 second';"),
        ('provider removed',f"DELETE FROM auth.sessions WHERE id='{uid(50)}';"),
        ('refresh uncertain',f"UPDATE sequence_private.auth_sessions SET refresh_owner='{uid(60)}',refresh_until=now()-interval '1 second';"),
    ]:
        check(name+' session denies RLS and runtime',role()+assert_sql('(SELECT count(*) FROM public.seq_prospects)=0')+'RESET ROLE;'+runtime+assert_sql(op('read')+' IS NULL'),setup)
    check('missing session claim denies RLS',role()+"SELECT set_config('request.jwt.claims','{}',true);"+assert_sql('(SELECT count(*) FROM public.seq_prospects)=0'))
    check('wrong session claim denies RLS',role()+f"SELECT set_config('request.jwt.claims',jsonb_build_object('session_id','{uid(50,2)}')::text,true);"+assert_sql('(SELECT count(*) FROM public.seq_prospects)=0'))
    check('logout permanently denies RLS',runtime+'SELECT '+op('revoke')+';RESET ROLE;'+role()+assert_sql('(SELECT count(*) FROM public.seq_prospects)=0'))
    check('readmission never revives sessions',role()+assert_sql('(SELECT count(*) FROM public.seq_prospects)=0'),f"UPDATE sequence_private.access_allowlist SET active=false WHERE user_id='{U}'; UPDATE sequence_private.access_allowlist SET active=true WHERE user_id='{U}';")
    claim=op('refresh_claim',f",'revision',1,'owner','{uid(60)}'")
    check('refresh claim single owner',runtime+assert_sql(claim+' IS NOT NULL')+assert_sql(claim+' IS NULL'))
    check('refresh missing revision rejected',runtime+deny('SELECT '+op('refresh_claim',f",'owner','{uid(60)}'"),'22023'))
    complete=op('refresh_complete',f",'revision',1,'owner','{uid(60)}','userId','{U}','providerSessionId','{uid(50)}','tokenExpiresAt',extract(epoch FROM now()+interval '1 hour'),'sealed','{{}}'::jsonb")
    check('refresh completion advances version once',runtime+assert_sql(claim+' IS NOT NULL')+assert_sql(complete+' IS NOT NULL')+assert_sql(complete+' IS NULL')+assert_sql(op('read')+"->>'revision'='2'"))
    check('refresh cannot change identity',runtime+assert_sql(claim+' IS NOT NULL')+deny('SELECT '+complete.replace(U,uid(1,2)),'28000'))
    check('expired login consumed without returning verifier',runtime+assert_sql("sequence_private.auth_session_operation('login_consume',jsonb_build_object('hash',repeat('C',43))) IS NULL"),"INSERT INTO sequence_private.login_transactions VALUES(repeat('C',43),'{}',now()-interval '1 second');")
    check('refresh stale revision rejected',runtime+assert_sql(op('refresh_claim',f",'revision',2,'owner','{uid(60)}'")+' IS NULL'))
    check('login transaction consumed once',runtime+"SELECT sequence_private.auth_session_operation('login_create',jsonb_build_object('hash',repeat('C',43),'sealed','{}'::jsonb));"+assert_sql("sequence_private.auth_session_operation('login_consume',jsonb_build_object('hash',repeat('C',43))) IS NOT NULL")+assert_sql("sequence_private.auth_session_operation('login_consume',jsonb_build_object('hash',repeat('C',43))) IS NULL"))


def auth_controls():
    runtime=role('sequence_auth_runtime')
    for scope,limit in [('login',10),('callback',20),('session',120)]:
        check(scope+' atomic rate bound',runtime+f"DO $$ BEGIN FOR i IN 1..{limit} LOOP IF sequence_private.auth_rate_limit('{scope}',repeat('A',43))<>0 THEN RAISE EXCEPTION 'Early limit'; END IF; END LOOP; IF sequence_private.auth_rate_limit('{scope}',repeat('A',43))<=0 THEN RAISE EXCEPTION 'Missing limit'; END IF; END $$;")
    check('runtime cannot approve',runtime+deny(f"SELECT sequence_private.operator_admission('{U}',true,'{uid(60)}')",'42501'))
    check('operator rejects non-Google identity',deny(f"SELECT sequence_private.operator_admission('{U}',true,'{uid(60)}')",'28000'))
    google=f"INSERT INTO auth.identities(provider_id,user_id,provider,identity_data) VALUES('{U}','{U}','google','{{}}');"
    check('operator repeated approval is idempotent',f"SELECT sequence_private.operator_admission('{U}',true,'{uid(60)}'); SELECT sequence_private.operator_admission('{U}',true,'{uid(60)}');"+assert_sql(f"(SELECT count(*) FROM public.seq_workspaces WHERE owner_id='{U}')=1")+assert_sql(f"(SELECT count(*) FROM sequence_private.auth_audit WHERE user_id='{U}')=2"),google)
    check('operator audit records authenticated database principal',f"SELECT sequence_private.operator_admission('{U}',true,'{uid(60)}');"+assert_sql(f"(SELECT database_principal=session_user FROM sequence_private.auth_audit WHERE user_id='{U}' LIMIT 1)"),google)
    check('runtime event cannot forge operator action',runtime+deny(f"SELECT sequence_private.auth_record_event('approved','{uid(60)}')",'22023'))
    check('runtime denial records correlation and database principal',runtime+f"SELECT sequence_private.auth_record_event('session_denied','{uid(60)}'); RESET ROLE;"+assert_sql(f"EXISTS(SELECT 1 FROM sequence_private.auth_audit WHERE request_id='{uid(60)}' AND reason='session_denied' AND user_id IS NULL AND database_principal=session_user)"))
    check('maintenance deletes expired technical records only',runtime+"SELECT sequence_private.auth_maintenance(); RESET ROLE;"+assert_sql('(SELECT count(*) FROM sequence_private.auth_rate_limits)=0')+assert_sql('(SELECT count(*) FROM sequence_private.auth_audit WHERE user_id IS NULL)=0')+assert_sql('(SELECT count(*) FROM sequence_private.auth_audit WHERE user_id IS NOT NULL)=1'),f"INSERT INTO sequence_private.auth_rate_limits VALUES('login',repeat('C',43),now()-interval '11 minutes',1); INSERT INTO sequence_private.auth_audit(user_id,reason,request_id,created_at) VALUES(NULL,'login_denied','{uid(60)}',now()-interval '31 days'),('{U}','approved','{uid(60)}',now()-interval '31 days');")


def refresh_race():
    global count
    marker()
    execute('test','BEGIN;'+FIXTURE+'COMMIT;')
    try:
        def run(n):
            return execute('test',f"BEGIN; SET LOCAL ROLE sequence_auth_runtime; SELECT (sequence_private.auth_session_operation('refresh_claim',jsonb_build_object('hash',repeat('A',43),'revision',1,'owner','{uid(n)}')) IS NOT NULL)::text; COMMIT;")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(run,[61,62]))
        assert sorted(results)==['false','true'], results
        count+=1;print('PASS concurrent refresh has one owner',flush=True)
    finally:cleanup_fixture()


def marker():
    actual=execute('test','SELECT project_ref FROM sequence_meta.environment WHERE purpose=\'test\';')
    if actual!=TARGETS['test']:raise ValueError('Test marker mismatch')


def cleanup_fixture():
    # Only the deterministic fixture workspace IDs; fail rather than deleting unknown users.
    marker()
    tables=['management_requests','send_reservations','attempt_results','attempts','execution_leases','account_execution_state','logical_actions','enrollments','observations','approval_recipients','approvals','content_revisions']
    ids=f"'{W}','{uid(2,2)}'"
    sql='BEGIN;'
    for t in tables:sql+=f'DELETE FROM sequence_private.{t} WHERE workspace_id IN ({ids});'
    for t in ['list_memberships','campaigns','lists','prospects','accounts']:
        sql+=f'DELETE FROM public.seq_{t} WHERE workspace_id IN ({ids});'
    sql+=f"DELETE FROM public.seq_workspaces WHERE id IN ({ids}) AND synthetic; DELETE FROM sequence_private.deletion_tombstones WHERE user_id IN ('{U}','{uid(1,2)}'); DELETE FROM sequence_private.provider_readings WHERE note='fixture'; DELETE FROM sequence_private.access_allowlist WHERE user_id IN ('{U}','{uid(1,2)}'); DELETE FROM auth.users WHERE id IN ('{U}','{uid(1,2)}') AND email IN ('s3-fixture-1@example.invalid','s3-fixture-2@example.invalid'); COMMIT;"
    execute('test',sql)


def race(name, operation):
    global count
    marker()
    execute('test','BEGIN;'+FIXTURE+f"UPDATE sequence_private.enrollments SET status='Stopped' WHERE id='{E}';COMMIT;")
    try:
        # Hold the winning transaction open so another live connection contends on its lock.
        def run(n):
            try:
                execute('test','BEGIN;'+role('sequence_worker')+operation(n)+';SELECT pg_sleep(1);COMMIT;')
                return 'ok'
            except RuntimeError as error:
                if any(s in str(error) for s in ['duplicate key','Account busy']):return 'conflict'
                raise
        with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(run,[31,32]))
        if sorted(results)!=['conflict','ok']:raise AssertionError((name,results))
        count+=1;print('PASS',name,flush=True)
    finally:cleanup_fixture()


def recovery():
    global count
    before=execute('test','SELECT count(*) FROM sequence_meta.migrations;')
    migrate('test')
    assert execute('test','SELECT count(*) FROM sequence_meta.migrations;')==before
    count+=1;print('PASS migration replay no duplicate effects',flush=True)
    try:
        execute('test',"BEGIN; CREATE TABLE sequence_private.rollback_probe(id int); SELECT 1/0; COMMIT;")
        raise AssertionError('Failure injection did not fail')
    except RuntimeError as e:
        if 'division by zero' not in str(e):raise
    assert execute('test',"SELECT to_regclass('sequence_private.rollback_probe') IS NULL;")=='t'
    count+=1;print('PASS failed migration rolls back',flush=True)
    rebuild_test('test',TARGETS['test'])
    count+=1;print('PASS empty isolated application rebuild and fresh migrations',flush=True)


def rest_checks():
    global count
    # Public publishable key observed in this test project's connection panel; not a secret.
    public_key='sb_publishable_bIUNafp-2YwPUNANqvKCzA_FCI2tsb4'
    base='https://'+TARGETS['test']+'.supabase.co'
    password=secrets.token_hex(24)
    execute('test','BEGIN;'+FIXTURE+f"""
UPDATE auth.users SET instance_id='00000000-0000-0000-0000-000000000000',
 encrypted_password=extensions.crypt('{password}',extensions.gen_salt('bf')),
 created_at=now(), updated_at=now(), is_super_admin=false, confirmation_token='', recovery_token='', email_change_token_new='', email_change='',
 email_change_token_current='', reauthentication_token='',
 raw_app_meta_data='{{"provider":"email","providers":["email"]}}', raw_user_meta_data='{{}}'
 WHERE id IN ('{U}','{uid(1,2)}');
INSERT INTO auth.identities(provider_id,user_id,provider,identity_data,created_at,updated_at)
 SELECT id::text,id,'email',jsonb_build_object('sub',id::text,'email',email,'email_verified',true),now(),now()
 FROM auth.users WHERE id IN ('{U}','{uid(1,2)}'); COMMIT;
""")
    def request(path,token=None,body=None):
        headers={'apikey':public_key,'Content-Type':'application/json'}
        if token:headers['Authorization']='Bearer '+token
        req=urllib.request.Request(base+path, data=json.dumps(body).encode() if body is not None else None,headers=headers)
        try:
            with urllib.request.urlopen(req,timeout=15) as response:
                return response.status,json.loads(response.read())
        except urllib.error.HTTPError as error:
            # Do not print access tokens, passwords, or response bodies on error.
            data=json.loads(error.read())
            if path.startswith('/auth/'):
                print('Auth fixture diagnostic:',data.get('code'),data.get('msg'),flush=True)
            return error.code,None
    try:
        tokens=[]
        for n in [1,2]:
            status,data=request('/auth/v1/token?grant_type=password',body={'email':f's3-fixture-{n}@example.invalid','password':password})
            if status!=200:raise AssertionError(f'Synthetic Auth sign-in failed: HTTP {status}')
            tokens.append(data['access_token'])
            # Decode only this synthetic provider response to bind its fixture session.
            # Production verification uses signed JOSE claims, never this helper.
            claims=json.loads(base64.urlsafe_b64decode(data['access_token'].split('.')[1]+'==='))
            sid=str(uuid.UUID(claims['session_id']))
            execute('test',f"UPDATE sequence_private.auth_sessions SET provider_session_id='{sid}' WHERE user_id='{uid(1,n)}';")
        for n,token in enumerate(tokens,1):
            status,data=request('/rest/v1/seq_prospects?select=id,workspace_id',token)
            assert status==200 and len(data)==1 and data[0]['workspace_id']==uid(2,n)
        status,data=request('/rest/v1/seq_prospects?select=id&workspace_id=eq.'+uid(2,2),tokens[0]);assert status==200 and data==[]
        status,_=request('/rest/v1/seq_prospects?select=id');assert status in [401,403]
        status,_=request('/rest/v1/seq_prospects?select=id','invalid-token');assert status==401
        status,data=request('/rest/v1/rpc/seq_manage',tokens[0],{'operation':'snapshot','args':{'page':0}})
        assert status==200 and data['totalProspects']==1 and data['sendingEnabled'] is False
        status,_=request('/rest/v1/rpc/seq_manage',tokens[0],{'operation':'control','args':{'requestId':str(uuid.uuid4()),'campaignId':uid(6,2),'revision':1,'action':'stop'}})
        assert status==403
        execute('test',f"UPDATE sequence_private.access_allowlist SET active=false WHERE user_id='{U}';")
        status,data=request('/rest/v1/seq_prospects?select=id',tokens[0]);assert status==200 and data==[]
        execute('test',f"UPDATE sequence_private.access_allowlist SET active=true WHERE user_id='{U}';")
        status,data=request('/rest/v1/seq_prospects?select=id',tokens[0]);assert status==200 and data==[]
        execute('test',"SELECT sequence_private.auth_session_operation('revoke',jsonb_build_object('hash',repeat('B',43)));")
        status,data=request('/rest/v1/seq_prospects?select=id',tokens[1]);assert status==200 and data==[]
        count+=1;print('PASS hosted Auth/REST two-user, anonymous, forged token and revocation isolation',flush=True)
    finally:
        cleanup_fixture()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--confirm-test-project',required=True);args=parser.parse_args()
    guard_test('test',args.confirm_test_project);marker()
    recovery()
    integration()
    from test_management import integration as management_checks
    management_checks()
    from test_management import races as management_races
    management_races()
    from test_lifecycle import integration as lifecycle_checks
    lifecycle_checks()
    auth_sessions()
    auth_controls()
    refresh_race()
    race('two simultaneous enrollments',lambda n:enrollment(uid(n)))
    race('two simultaneous executors',lambda n:f"SELECT sequence_private.acquire_storage_lease('{W}','{A}','{uid(n)}')")
    rest_checks()
    print(f'{count} database scenarios passed')

if __name__=='__main__':main()
