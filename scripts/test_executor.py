"""S4-001 phase X0 integration cases: executor pairing, device tokens, identity checks and observation-only tasks; guarded hosted suite."""
import json
from test_database import check, role, assert_sql, deny, uid, W, A, P, E

SELF = "'linkedin:path:/in/self-vanity/'"
SELF_JSON = {'profileKey': None, 'profilePath': '/in/self-vanity/'}
OTHER_JSON = {'profileKey': None, 'profilePath': '/in/someone-else/'}
TOKEN_HASH = 'a' * 43
TOKEN_HASH_2 = 'b' * 43


def bound(timezone=None):
    tz = f"'{timezone}'" if timezone else 'NULL'
    return f"UPDATE public.seq_accounts SET external_identity={SELF},timezone={tz} WHERE id='{A}'; UPDATE public.seq_prospects SET profile_path='/in/person-1/' WHERE id='{P}';"


def j(value):
    return json.dumps(value).replace("'", "''")


def owner(operation, args):
    return f"public.seq_executors('{operation}','{j(args)}'::jsonb)"


def runtime(operation, args):
    return f"sequence_private.executor_operation('{operation}','{j(args)}'::jsonb)"


def paired(token_hash=TOKEN_HASH, label=''):
    # Pair as the owner would through the dashboard and the Worker: a code is created, then consumed by its hash.
    return (role() + f"SELECT {owner('pair-code', {'label': label})};" + 'RESET ROLE;' +
            f"DO $$ DECLARE c text; BEGIN SELECT code_hash INTO c FROM sequence_private.pairing_codes WHERE account_id='{A}'; "
            f"PERFORM set_config('paced.codehash',c,true); END $$;" + role('sequence_auth_runtime') +
            f"SELECT sequence_private.executor_operation('pair',jsonb_build_object('codeHash',current_setting('paced.codehash'),'tokenHash','{token_hash}','adapterVersion','0.2.0'));" + 'RESET ROLE;')


def integration():
    check('execution settings need a bound account, a timezone and the acknowledgement before observation', role() +
          deny(f"SELECT {owner('settings', {'timezone': 'Asia/Kolkata', 'executionMode': 'observe', 'acknowledged': True})}", '22023') +
          'RESET ROLE;' + bound() + role() +
          deny(f"SELECT {owner('settings', {'timezone': None, 'executionMode': 'observe', 'acknowledged': True})}", '22023') +
          deny(f"SELECT {owner('settings', {'timezone': 'Asia/Kolkata', 'executionMode': 'observe', 'acknowledged': False})}", '22023') +
          deny(f"SELECT {owner('settings', {'timezone': 'Mars/Olympus', 'executionMode': 'observe', 'acknowledged': True})}", '22023') +
          assert_sql(f"({owner('settings', {'timezone': 'Asia/Kolkata', 'executionMode': 'observe', 'acknowledged': True})}->>'executionMode')='observe'") +
          assert_sql(f"({owner('list', {})}->>'bound')::boolean AND ({owner('list', {})}->>'timezone')='Asia/Kolkata' AND ({owner('list', {})}->>'acknowledgedAt') IS NOT NULL") +
          assert_sql(f"({owner('settings', {'timezone': None, 'executionMode': 'disabled', 'acknowledged': True})}->>'executionMode')='disabled'") +
          'RESET ROLE;' + assert_sql(f"(SELECT timezone='Asia/Kolkata' AND execution_mode='disabled' FROM public.seq_accounts WHERE id='{A}')"))
    check('pairing codes need a bound account, hash at rest, expire and are single use', role() +
          deny(f"SELECT {owner('pair-code', {})}", '22023') + 'RESET ROLE;' + bound() + role() +
          assert_sql(f"({owner('pair-code', {'label': 'Laptop'})}->>'code') ~ '^[A-Z2-9]{{8}}$'") + 'RESET ROLE;' +
          assert_sql(f"(SELECT count(*) FROM sequence_private.pairing_codes WHERE account_id='{A}' AND consumed_at IS NULL AND code_hash ~ '^[A-Za-z0-9_-]{{43}}$' AND label='Laptop')=1") +
          f"DO $$ DECLARE c text; BEGIN SELECT code_hash INTO c FROM sequence_private.pairing_codes WHERE account_id='{A}'; PERFORM set_config('paced.codehash',c,true); END $$;" +
          role('sequence_auth_runtime') +
          assert_sql(f"(sequence_private.executor_operation('pair',jsonb_build_object('codeHash',current_setting('paced.codehash'),'tokenHash','{TOKEN_HASH}','adapterVersion','0.2.0'))->>'executorId') IS NOT NULL") +
          assert_sql(f"sequence_private.executor_operation('pair',jsonb_build_object('codeHash',current_setting('paced.codehash'),'tokenHash','{TOKEN_HASH_2}','adapterVersion','0.2.0')) IS NULL") +
          assert_sql(f"sequence_private.executor_operation('pair',jsonb_build_object('codeHash',repeat('z',43),'tokenHash','{TOKEN_HASH_2}','adapterVersion','0.2.0')) IS NULL") +
          deny(f"SELECT sequence_private.executor_operation('pair',jsonb_build_object('codeHash','short','tokenHash','{TOKEN_HASH_2}','adapterVersion','0.2.0'))", '22023') +
          'RESET ROLE;' + assert_sql(f"(SELECT count(*) FROM sequence_private.executors WHERE account_id='{A}' AND label='Laptop' AND token_hash='{TOKEN_HASH}')=1") +
          f"UPDATE sequence_private.pairing_codes SET consumed_at=NULL,expires_at=now()-interval '1 second' WHERE account_id='{A}';" + role('sequence_auth_runtime') +
          assert_sql(f"sequence_private.executor_operation('pair',jsonb_build_object('codeHash',current_setting('paced.codehash'),'tokenHash','{TOKEN_HASH_2}','adapterVersion','0.2.0')) IS NULL"))
    check('heartbeat reports mode and identity match, a revoked browser is refused and loses its lease', bound() + paired() + role('sequence_auth_runtime') +
          assert_sql(f"({runtime('heartbeat', {'tokenHash': TOKEN_HASH, 'adapterVersion': '0.2.1', 'self': SELF_JSON})}->>'identity')='match'") +
          assert_sql(f"({runtime('heartbeat', {'tokenHash': TOKEN_HASH, 'adapterVersion': '0.2.1', 'self': OTHER_JSON})}->>'identity')='mismatch'") +
          assert_sql(f"({runtime('heartbeat', {'tokenHash': TOKEN_HASH, 'adapterVersion': '0.2.1', 'self': {'profileKey': None, 'profilePath': None}})}->>'identity')='unknown'") +
          assert_sql(f"({runtime('heartbeat', {'tokenHash': TOKEN_HASH, 'adapterVersion': '0.2.1', 'self': SELF_JSON})}->>'executionMode')='disabled'") +
          'RESET ROLE;' + assert_sql(f"(SELECT adapter_version='0.2.1' AND last_seen_at>now()-interval '1 minute' FROM sequence_private.executors WHERE token_hash='{TOKEN_HASH}')") +
          assert_sql(f"(sequence_private.workspace_health('{W}')->>'executors')='1 connected'") +
          f"DO $$ DECLARE x uuid; BEGIN SELECT id INTO x FROM sequence_private.executors WHERE token_hash='{TOKEN_HASH}'; PERFORM set_config('paced.xid',x::text,true); PERFORM sequence_private.acquire_storage_lease('{W}','{A}',x); END $$;" +
          assert_sql(f"(SELECT lease_executor IS NOT NULL FROM sequence_private.account_execution_state WHERE account_id='{A}')") + role() +
          assert_sql(f"(public.seq_executors('revoke',jsonb_build_object('executorId',current_setting('paced.xid')))->>'revoked')::boolean") + 'RESET ROLE;' +
          assert_sql(f"(SELECT lease_executor IS NULL FROM sequence_private.account_execution_state WHERE account_id='{A}')") +
          assert_sql(f"(sequence_private.workspace_health('{W}')->>'executors')='none-registered'") + role('sequence_auth_runtime') +
          assert_sql(f"{runtime('heartbeat', {'tokenHash': TOKEN_HASH, 'adapterVersion': '0.2.1', 'self': SELF_JSON})} IS NULL") +
          assert_sql(f"{runtime('watchlist', {'tokenHash': TOKEN_HASH, 'self': SELF_JSON})} IS NULL"))
    observe = {'tokenHash': TOKEN_HASH, 'self': SELF_JSON, 'observations': [{'prospectId': P, 'observedAt': '__NOW__', 'connection': 'Pending', 'complete': True,
                'messages': [{'direction': 'incoming', 'at': '2026-11-01T10:00:00Z', 'fingerprint': 'f' * 20}, {'direction': 'outgoing', 'at': '2026-11-02T10:00:00Z', 'fingerprint': 'g' * 20}]}]}
    def now_call(operation, args):
        return runtime(operation, args).replace('"__NOW__"', '"NOW"').replace("'::jsonb", "'::jsonb").replace(f"'{j(args)}'::jsonb", f"replace('{j(args)}','NOW',to_char(now() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'))::jsonb")
    check('the watchlist lists enrolled people only in observe mode with a matching identity', bound('Asia/Kolkata') + paired() + role('sequence_auth_runtime') +
          assert_sql(f"jsonb_array_length({runtime('watchlist', {'tokenHash': TOKEN_HASH, 'self': SELF_JSON})}->'people')=0") + 'RESET ROLE;' + role() +
          f"SELECT {owner('settings', {'timezone': None, 'executionMode': 'observe', 'acknowledged': True})};" + 'RESET ROLE;' + role('sequence_auth_runtime') +
          assert_sql(f"jsonb_array_length({runtime('watchlist', {'tokenHash': TOKEN_HASH, 'self': OTHER_JSON})}->'people')=0 AND ({runtime('watchlist', {'tokenHash': TOKEN_HASH, 'self': OTHER_JSON})}->>'identity')='mismatch'") +
          assert_sql(f"({runtime('watchlist', {'tokenHash': TOKEN_HASH, 'self': SELF_JSON})}->'people'->0->>'prospectId')='{P}' AND ({runtime('watchlist', {'tokenHash': TOKEN_HASH, 'self': SELF_JSON})}->'people'->0->>'profilePath')='/in/person-1/' AND ({runtime('watchlist', {'tokenHash': TOKEN_HASH, 'self': SELF_JSON})}->'people'->0->>'recipientKey') IS NOT NULL") +
          'RESET ROLE;' + f"UPDATE sequence_private.enrollments SET status='Stopped' WHERE id='{E}';" + role('sequence_auth_runtime') +
          assert_sql(f"jsonb_array_length({runtime('watchlist', {'tokenHash': TOKEN_HASH, 'self': SELF_JSON})}->'people')=0"))
    check('observations are stored as adapter evidence with message fingerprints and never change the person or sequence', bound('Asia/Kolkata') + paired() + role() +
          f"SELECT {owner('settings', {'timezone': None, 'executionMode': 'observe', 'acknowledged': True})};" + 'RESET ROLE;' + role('sequence_auth_runtime') +
          assert_sql(f"({now_call('observe', observe)}->>'stored')='3'") +
          assert_sql(f"({now_call('observe', observe)}->>'duplicates')='2' AND ({now_call('observe', observe)}->>'stored')='1'") +
          deny(f"SELECT {now_call('observe', {**observe, 'self': OTHER_JSON})}", '42501') +
          deny(f"SELECT {runtime('observe', {**observe, 'observations': [{**observe['observations'][0], 'observedAt': '2026-01-01T00:00:00Z'}]})}", '22023') +
          deny(f"SELECT {now_call('observe', {**observe, 'observations': [{**observe['observations'][0], 'connection': 'RejectedConfirmed'}]})}", '22023') +
          deny(f"SELECT {now_call('observe', {**observe, 'observations': [{**observe['observations'][0], 'extra': 1}]})}", '22023') +
          assert_sql(f"({now_call('observe', {**observe, 'observations': [{**observe['observations'][0], 'prospectId': uid(4, 2), 'messages': []}]})}->>'rejected')='1'") +
          'RESET ROLE;' +
          assert_sql(f"(SELECT count(*) FROM sequence_private.observations WHERE prospect_id='{P}' AND observer_version='adapter-v1' AND fingerprint IS NOT NULL)=2") +
          assert_sql(f"(SELECT count(*) FROM sequence_private.observations WHERE prospect_id='{P}' AND observer_version='adapter-v1' AND fingerprint IS NULL AND complete AND connection='Pending')=3") +
          assert_sql(f"(SELECT connection='Unknown' FROM public.seq_prospects WHERE id='{P}') AND (SELECT status FROM sequence_private.enrollments WHERE id='{E}')=(SELECT status FROM sequence_private.enrollments WHERE id='{E}')") +
          assert_sql(f"(SELECT count(*) FROM sequence_private.logical_actions WHERE workspace_id='{W}' AND state NOT IN ('Planned','Due'))=0"))
    check('executors are tenant-private, invisible to the backup role and removed with the workspace', bound() + paired() +
          f"DO $$ DECLARE x uuid; BEGIN SELECT id INTO x FROM sequence_private.executors WHERE token_hash='{TOKEN_HASH}'; PERFORM set_config('paced.xid',x::text,true); END $$;" +
          role('authenticated', uid(1, 2)) + assert_sql(f"jsonb_array_length({owner('list', {})}->'executors')=0") +
          assert_sql("NOT (public.seq_executors('revoke',jsonb_build_object('executorId',current_setting('paced.xid')))->>'revoked')::boolean") + 'RESET ROLE;' +
          assert_sql(f"(SELECT revoked_at IS NULL FROM sequence_private.executors WHERE token_hash='{TOKEN_HASH}')") +
          role('sequence_backup') + deny('SELECT count(*) FROM sequence_private.executors', '42501') + deny('SELECT count(*) FROM sequence_private.pairing_codes', '42501') + 'RESET ROLE;' +
          role('sequence_worker') + deny(f"SELECT {runtime('heartbeat', {'tokenHash': TOKEN_HASH, 'adapterVersion': '0.2.0', 'self': SELF_JSON})}", '42501') + 'RESET ROLE;' +
          assert_sql("pg_get_functiondef('public.seq_delete_workspace(jsonb)'::regprocedure) LIKE '%DELETE FROM sequence_private.executors WHERE workspace_id=w;%'") +
          assert_sql("pg_get_functiondef('public.seq_delete_workspace(jsonb)'::regprocedure) LIKE '%DELETE FROM sequence_private.pairing_codes WHERE workspace_id=w;%'"))
    check('external import keeps the public profile path for later observation', role() +
          f"""SELECT public.seq_manage('import-external',replace('{{"requestId":"{uid(90)}","listName":"Paths","selection":{{"contract":"paced-selection-1","extensionVersion":"0.1.0","capturedAt":"NOW","pageType":"people-search","self":{{"profileKey":null,"profilePath":"/in/self-vanity/"}},"rows":[{{"profileKey":"urn:li:member:555","profilePath":"/in/member-555/","displayName":"Member Five","headline":"Engineer at Co","location":null,"current":null,"relationship":"2nd","action":"Connect","missing":[]}}]}}}}','NOW',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))::jsonb);""" +
          'RESET ROLE;' + assert_sql("(SELECT profile_path='/in/member-555/' FROM public.seq_prospects WHERE recipient_key='urn:li:member:555')"))
