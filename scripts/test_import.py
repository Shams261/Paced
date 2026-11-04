"""S1-002 integration cases: external (extension) import, account binding, mapping and approvals; guarded hosted suite."""
import json
from test_database import check, role, assert_sql, deny, uid, W, A, P, C
from test_management import rpc

KEY = 'urn:li:fsd_profile:ACoAAtest00%s'


def selection(rows, self_key=KEY % 'self', captured='now()'):
    return {'contract': 'paced-selection-1', 'extensionVersion': '0.1.0', 'capturedAt': '__CAPTURED__', 'pageType': 'people-search',
            'self': {'profileKey': self_key, 'profilePath': '/in/self/'}, 'rows': rows}


def row(n, **over):
    base = {'profileKey': KEY % n, 'profilePath': f'/in/person-{n}/', 'displayName': f'Person {n}', 'headline': f'Engineer {n} at Example Co',
            'location': 'Toronto, Canada', 'current': None, 'relationship': '2nd', 'action': 'Connect', 'missing': []}
    base.update(over)
    return base


def call(operation, args):
    # capturedAt must be a real timestamp; substitute at SQL level so the clock is the database's.
    payload = json.dumps(args).replace("'", "''").replace('"__CAPTURED__"', '"CAPTURED"')
    return f"public.seq_manage('{operation}',replace('{payload}','CAPTURED',to_char(now() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'))::jsonb)"


def integration():
    rows = [row(1), row(2, relationship='1st', action='Message'), row(3, action='Pending'), row(4, profileKey=None, missing=['profileKey']), row(5, action='Follow', headline='Freelance engineer'),
            row(6, profileKey='urn:li:member:123456789', headline='Builder | Ex-Big Co', current='Current: Software Engineer 2 at Member Co')]
    preview = call('import-preview-external', {'selection': selection(rows)})
    imp = call('import-external', {'requestId': uid(80), 'selection': selection(rows), 'listName': 'Real people'})
    check('external preview maps visible evidence and marks rows without a key', role() + assert_sql(f"({preview}->>'binding')='will-bind' AND jsonb_array_length({preview}->'rows')=6 AND ({preview}->'rows'->5->>'role')='Software Engineer 2' AND ({preview}->'rows'->5->>'company')='Member Co' AND ({preview}->'rows'->5->>'importable')::boolean") +
          assert_sql(f"({preview}->'rows'->0->>'connection')='NotConnected' AND ({preview}->'rows'->0->>'role')='Engineer 1' AND ({preview}->'rows'->0->>'company')='Example Co'") +
          assert_sql(f"({preview}->'rows'->1->>'connection')='Connected' AND ({preview}->'rows'->2->>'connection')='Pending' AND ({preview}->'rows'->4->>'connection')='Unknown' AND ({preview}->'rows'->4->>'company') IS NULL") +
          assert_sql(f"NOT ({preview}->'rows'->3->>'importable')::boolean AND ({preview}->'rows'->3->>'reason')='no-stable-key'") +
          'RESET ROLE;' + assert_sql(f"(SELECT count(*) FROM public.seq_prospects WHERE workspace_id='{W}')=1"))
    check('external import binds the account, saves people with evidence and skips keyless rows', role() + f'SELECT {imp};' + 'RESET ROLE;' +
          assert_sql(f"(SELECT external_identity FROM public.seq_accounts WHERE id='{A}')='linkedin:{KEY % 'self'}' AND (SELECT identity_verified_at IS NULL FROM public.seq_accounts WHERE id='{A}')") +
          assert_sql(f"(SELECT count(*) FROM public.seq_prospects WHERE workspace_id='{W}' AND source='extension-v1')=5 AND (SELECT count(*) FROM public.seq_lists WHERE workspace_id='{W}' AND name='Real people')=1") +
          assert_sql(f"(SELECT count(*) FROM sequence_private.observations WHERE workspace_id='{W}' AND observer_version='extension-v1' AND complete=false)=5") +
          assert_sql(f"(SELECT connection FROM public.seq_prospects WHERE recipient_key='{KEY % 2}')='Connected' AND (SELECT company FROM public.seq_prospects WHERE recipient_key='{KEY % 5}') IS NULL"))
    check('external import retry is idempotent and a second account identity is rejected', role() + f'SELECT {imp}; SELECT {imp};' + 'RESET ROLE;' +
          assert_sql(f"(SELECT count(*) FROM public.seq_lists WHERE workspace_id='{W}' AND name='Real people')=1") + role() +
          deny(f"SELECT {call('import-external', {'requestId': uid(81), 'selection': selection([row(9)], self_key=KEY % 'other'), 'listName': 'Other account'})}", '42501') +
          deny(f"SELECT {call('import-external', {'requestId': uid(82), 'selection': {**selection([row(9)], self_key=None), 'self': {'profileKey': None, 'profilePath': None}}, 'listName': 'No self'})}", '42501'))
    check('self identity by profile path binds when no key is exposed', role() + f"SELECT {call('import-external', {'requestId': uid(87), 'selection': {**selection([row(1)]), 'self': {'profileKey': None, 'profilePath': '/in/self-vanity/'}}, 'listName': 'Path bound'})};" + 'RESET ROLE;' +
          assert_sql(f"(SELECT external_identity FROM public.seq_accounts WHERE id='{A}')='linkedin:path:/in/self-vanity/'"))
    check('external import rejects stale, malformed and oversized selections', role() +
          deny(f"SELECT {call('import-preview-external', {'selection': {**selection([row(1)]), 'capturedAt': '2026-01-01T00:00:00Z'}})}".replace("replace('", "('").replace("','CAPTURED',to_char(now() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'))", "')"), '22023') +
          deny(f"SELECT {call('import-preview-external', {'selection': {**selection([row(1)]), 'contract': 'other'}})}", '22023') +
          assert_sql(f"NOT ({call('import-preview-external', {'selection': selection([row(1, profileKey='urn:li:company:1')])})}->'rows'->0->>'importable')::boolean") +
          deny(f"SELECT {call('import-preview-external', {'selection': selection([row(1), row(1)])})}", '22023') +
          deny(f"SELECT {call('import-preview-external', {'selection': selection([row(1, cookie='x')])})}", '22023') +
          deny(f"SELECT {call('import-external', {'requestId': uid(83), 'selection': selection([row(4, profileKey=None)]), 'listName': 'Nothing'})}", '22023'))
    check('changed visible fields update the person and invalidate approval; extension people can be approved', role() + f'SELECT {imp};' + f"""
DO $$ DECLARE d jsonb; pre jsonb; snap jsonb; BEGIN
 SELECT jsonb_build_object('requestId','00000084-0000-0000-0000-000000000001','campaignId',null,'revision',null,'name','Real campaign','recipients',jsonb_agg(id::text),'content','{{"note":"Hi {{{{name}}}}","firstMessage":"Hello {{{{name}}}} at {{{{company}}}}","followups":[]}}'::jsonb)
 INTO d FROM public.seq_prospects WHERE source='extension-v1' AND recipient_key IN ('{KEY % 1}','{KEY % 2}','{KEY % 3}');
 d=public.seq_manage('save-draft',d); pre=public.seq_manage('approval-preview',d);
 PERFORM public.seq_manage('approve',d||jsonb_build_object('requestId',gen_random_uuid(),'preview',pre->>'fingerprint'));
 snap=public.seq_manage('snapshot','{{"page":0}}');
 IF (SELECT count(*) FROM jsonb_array_elements(snap->'enrollments') e WHERE e->>'status'='Waiting')<>1 OR
    (SELECT count(*) FROM jsonb_array_elements(snap->'enrollments') e WHERE e->>'status'='Held' AND e->>'stop_reason'='execution-disabled')<>1 OR
    (SELECT count(*) FROM jsonb_array_elements(snap->'prospects') p WHERE p->>'source'='extension-v1')<>5 THEN RAISE EXCEPTION 'Mapping failed'; END IF;
END $$;""" + f"SELECT {call('import-external', {'requestId': uid(85), 'selection': selection([row(1, headline='Staff Engineer at New Co')]), 'listName': 'Again'})};" + 'RESET ROLE;' +
          assert_sql(f"(SELECT company='New Co' AND role_title='Staff Engineer' AND revision=2 FROM public.seq_prospects WHERE recipient_key='{KEY % 1}')") +
          assert_sql(f"(SELECT count(*) FROM public.seq_prospects WHERE workspace_id='{W}' AND source='extension-v1')=5") +
          assert_sql("(SELECT count(*) FROM sequence_private.enrollments WHERE status='Held' AND stop_reason='approval-required')>=1"))
    check('catalog import still works beside real people and the synthetic account label is replaced only by a real identity', role() + f'SELECT {imp};' + f"SELECT {rpc('import',{'requestId':uid(86),'keys':['sample-ada'],'listName':'Samples'})};" + 'RESET ROLE;' +
          assert_sql(f"(SELECT count(*) FROM public.seq_prospects WHERE workspace_id='{W}')=7 AND (SELECT external_identity LIKE 'linkedin:%' FROM public.seq_accounts WHERE id='{A}')"))
