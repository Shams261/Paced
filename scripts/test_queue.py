"""S4-001 slice 2 integration cases: the manual send queue (start, answers, user reports, caps, pause, tenant and role boundaries); guarded hosted suite."""
import json
from test_database import check, role, assert_sql, deny, uid, W, A, P, C, E, ACT, AP, R
from test_management import rpc

SELF = "'linkedin:path:/in/self-vanity/'"
P2, O2, E2 = uid(60), uid(61), uid(62)


def j(value):
    return json.dumps(value).replace("'", "''")


def q(operation, args):
    return f"public.seq_queue('{operation}','{j(args)}'::jsonb)"


def settings(mode, **caps):
    return f"public.seq_executors('settings','{j({'timezone': 'Asia/Kolkata', 'executionMode': mode, 'acknowledged': True, **caps})}'::jsonb)"


def manual(reason='execution-disabled', **caps):
    # The owner binds the account, turns manual sending on and the fixture enrollment waits for execution as approval leaves it.
    return (f"UPDATE public.seq_accounts SET external_identity={SELF} WHERE id='{A}'; UPDATE sequence_private.enrollments SET stop_reason='{reason}' WHERE id='{E}';"
            + role() + f"SELECT {settings('manual', **caps)};" + 'RESET ROLE;')


def second_person():
    return (f"INSERT INTO public.seq_prospects(id,workspace_id,account_id,recipient_key,display_name,source,observed_at) VALUES('{P2}','{W}','{A}','synthetic-recipient-2','Second Person','synthetic',now());"
            f"INSERT INTO sequence_private.approval_recipients(workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id,rendered_content) VALUES('{W}','{A}','{C}','{R}','{AP}','{P2}','{{\"note\":\"Hello Second\",\"firstMessage\":\"Hi Second\",\"followups\":[]}}');"
            f"INSERT INTO sequence_private.observations(id,workspace_id,account_id,prospect_id,observed_at,observer_version,connection,complete) VALUES('{O2}','{W}','{A}','{P2}',now(),'synthetic-v1','NotConnected',true);"
            f"INSERT INTO sequence_private.enrollments(id,workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id,baseline_observation_id,status,stop_reason) VALUES('{E2}','{W}','{A}','{C}','{R}','{AP}','{P2}','{O2}','Held','execution-disabled');")


def started():
    return role() + f"SELECT {q('start', {'actionId': ACT})};" + 'RESET ROLE;'


def attempt_id():
    return f"(SELECT id FROM sequence_private.attempts WHERE action_id='{ACT}' ORDER BY attempt_number DESC LIMIT 1)"


def answer(operation):
    # The attempt id is read as the migration owner and handed to the owner's call through a transaction-local setting.
    return ('RESET ROLE;' + f"DO $$ DECLARE t uuid; BEGIN SELECT attempt_id INTO t FROM sequence_private.send_reservations WHERE account_id='{A}' AND resolved_at IS NULL; PERFORM set_config('paced.attempt',t::text,true); END $$;"
            + role() + f"SELECT public.seq_queue('{operation}',jsonb_build_object('attemptId',current_setting('paced.attempt')::uuid));")


def backdate_spacing():
    return f"UPDATE sequence_private.send_reservations SET possible_send_at=possible_send_at-interval '10 minutes' WHERE account_id='{A}'; UPDATE sequence_private.account_execution_state SET lease_expires_at=NULL,lease_executor=NULL WHERE account_id='{A}';"


def integration():
    view = q('list', {})
    item = f"({view}->'items'->0)"
    check('queue lists the due invitation with its text and blocks start outside manual mode',
          f"UPDATE public.seq_accounts SET external_identity={SELF} WHERE id='{A}'; UPDATE sequence_private.enrollments SET stop_reason='execution-disabled' WHERE id='{E}';" + role() +
          f"SELECT {settings('observe')};" +
          assert_sql(f"jsonb_array_length({view}->'items')=1 AND {item}->>'actionId'='{ACT}' AND {item}->>'kind'='Invitation' AND ({item}->>'step')::int=0 AND {item}->>'text'='' AND {item}->'blocked' = 'null'::jsonb AND {item}->>'displayName'='Example Person'") +
          assert_sql(f"({view}->>'executionMode')='observe' AND ({view}->>'invitationCap')::int=18 AND ({view}->>'messageCap')::int=20 AND ({view}->>'spacingMinutes')::int=5 AND {view}->'current' = 'null'::jsonb AND jsonb_array_length({view}->'people')=1") +
          deny(f"SELECT {q('start', {'actionId': ACT})}", '22023') +
          deny(f"SELECT {settings('manual', invitationCap=0)}", '22023') + deny(f"SELECT {settings('manual', messageCap=41)}", '22023') +
          assert_sql(f"({settings('manual', invitationCap=2, messageCap=1, spacingMinutes=1)}->>'invitationCap')::int=2") +
          assert_sql(f"({view}->>'executionMode')='manual' AND ({view}->>'messageCap')::int=1 AND ({view}->>'spacingMinutes')::int=1"))
    check('queue materialises the first step for held enrollments and lifts a verification hold on a user report',
          f"DELETE FROM sequence_private.logical_actions WHERE id='{ACT}'; UPDATE sequence_private.observations SET connection='Unknown' WHERE id='{uid(9)}';" + manual('needs-verification') + role() +
          assert_sql(f"jsonb_array_length({view}->'items')=1 AND {item}->>'blocked'='connection-unknown' AND ({view}->'people'->0->>'connection')='Unknown'") +
          deny(f"SELECT {q('start', {'actionId': '00000000-0000-0000-0000-000000000000'})}", '22023') +
          f"SELECT {q('report', {'enrollmentId': E, 'event': 'not-connected'})};" +
          assert_sql(f"{item}->'blocked' = 'null'::jsonb AND ({view}->'people'->0->>'connection')='NotConnected' AND ({view}->'people'->0->'lastReport'->>'connection')='NotConnected'") +
          'RESET ROLE;' + assert_sql(f"(SELECT stop_reason='execution-disabled' AND status='Held' FROM sequence_private.enrollments WHERE id='{E}')") +
          assert_sql(f"(SELECT count(*) FROM sequence_private.logical_actions WHERE enrollment_id='{E}' AND step=0 AND state='Due')=1") +
          assert_sql(f"(SELECT connection='Unknown' FROM public.seq_prospects WHERE id='{P}')"))
    check('start takes the lease as the manual executor, records the possible send and blocks everything else until answered',
          manual() + started() + role() +
          assert_sql(f"({view}->'current'->>'actionId')='{ACT}' AND ({view}->'current'->>'kind')='Invitation' AND jsonb_array_length({view}->'items')=0") +
          deny(f"SELECT {q('start', {'actionId': ACT})}", '22023') +
          deny(f"SELECT {q('report', {'enrollmentId': E, 'event': 'accepted'})}", '55000') +
          'RESET ROLE;' +
          assert_sql(f"(SELECT count(*) FROM sequence_private.send_reservations WHERE account_id='{A}' AND resolved_at IS NULL)=1") +
          assert_sql(f"(SELECT lease_executor='{A}' AND fence=1 FROM sequence_private.account_execution_state WHERE account_id='{A}')") +
          assert_sql(f"(SELECT state='MayHaveSent' FROM sequence_private.logical_actions WHERE id='{ACT}') AND (SELECT status='Active' AND stop_reason='manual-send' FROM sequence_private.enrollments WHERE id='{E}')") +
          second_person() + role() + assert_sql(f"jsonb_array_length({view}->'items')=1 AND {item}->>'blocked'='busy'") +
          'RESET ROLE;' + role('sequence_worker') + deny(f"SELECT sequence_private.acquire_storage_lease('{W}','{A}','{uid(20)}')", '55000'))
    check('sent confirms the invitation with user-report evidence, consumes the cap, moves to waiting and never touches the prospect',
          manual(invitationCap=1) + started() + role() + answer('sent') +
          assert_sql(f"{view}->'current' = 'null'::jsonb AND ({view}->>'invitationsToday')::int=1 AND ({view}->'people'->0->>'status')='Waiting' AND ({view}->'people'->0->>'connection')='Pending'") +
          deny(f"SELECT {q('sent', {'attemptId': uid(21)})}", '22023') + 'RESET ROLE;' +
          assert_sql(f"(SELECT outcome='ConfirmedSent' AND evidence_reference LIKE 'user-report:%' FROM sequence_private.attempt_results WHERE action_id='{ACT}')") +
          assert_sql(f"(SELECT resolution='ConfirmedSent' FROM sequence_private.send_reservations WHERE action_id='{ACT}')") +
          assert_sql(f"(SELECT status='Waiting' AND stop_reason='awaiting-acceptance' FROM sequence_private.enrollments WHERE id='{E}')") +
          assert_sql(f"(SELECT count(*) FROM sequence_private.observations WHERE prospect_id='{P}' AND observer_version='user-report-v1' AND connection='Pending')=1") +
          assert_sql(f"(SELECT connection='Unknown' AND revision=1 FROM public.seq_prospects WHERE id='{P}')") +
          assert_sql(f"(SELECT lease_executor IS NULL FROM sequence_private.account_execution_state WHERE account_id='{A}')") +
          second_person() + role() + assert_sql(f"jsonb_array_length({view}->'items')=1 AND {item}->>'blocked'='daily-cap'"))
    check('not sent returns the step to the queue after the spacing interval and keeps the attempt history',
          manual(spacingMinutes=1) + started() + role() + answer('not-sent') +
          assert_sql(f"{view}->'current' = 'null'::jsonb AND ({view}->>'invitationsToday')::int=0 AND {item}->>'blocked'='not-due'") + 'RESET ROLE;' +
          assert_sql(f"(SELECT state='NotSent' AND due_at>now() FROM sequence_private.logical_actions WHERE id='{ACT}')") +
          assert_sql(f"(SELECT outcome='NotSent' FROM sequence_private.attempt_results WHERE action_id='{ACT}')") +
          f"UPDATE sequence_private.logical_actions SET due_at=now() WHERE id='{ACT}';" + role() + assert_sql(f"{item}->>'blocked'='spacing'") + 'RESET ROLE;' + backdate_spacing() +
          role() + assert_sql(f"{item}->'blocked' = 'null'::jsonb") + f"SELECT {q('start', {'actionId': ACT})};" + 'RESET ROLE;' +
          assert_sql(f"(SELECT count(*) FROM sequence_private.attempts WHERE action_id='{ACT}')=2"))
    check('acceptance creates the first message; sending it completes a sequence without follow-ups',
          manual(spacingMinutes=1) + started() + role() + answer('sent') + f"SELECT {q('report', {'enrollmentId': E, 'event': 'accepted'})};" +
          assert_sql(f"jsonb_array_length({view}->'items')=1 AND ({item}->>'step')::int=1 AND {item}->>'kind'='Message' AND {item}->>'text'='Synthetic approved content' AND {item}->>'blocked'='spacing'") +
          'RESET ROLE;' + backdate_spacing() + role() +
          f"DO $$ DECLARE act uuid; BEGIN SELECT (value->>'actionId')::uuid INTO act FROM jsonb_array_elements({view}->'items'); PERFORM public.seq_queue('start',jsonb_build_object('actionId',act)); END $$;" +
          answer('sent') +
          assert_sql(f"({view}->>'messagesToday')::int=1 AND jsonb_array_length({view}->'items')=0 AND jsonb_array_length({view}->'people')=0") + 'RESET ROLE;' +
          assert_sql(f"(SELECT status='Completed' AND stop_reason='final-step' FROM sequence_private.enrollments WHERE id='{E}')") +
          assert_sql(f"(SELECT count(*) FROM sequence_private.logical_actions WHERE enrollment_id='{E}' AND state='ConfirmedSent')=2"))
    check('an existing connection skips the invitation and follow-ups are scheduled from their delay',
          f"UPDATE sequence_private.approval_recipients SET rendered_content='{{\"note\":\"\",\"firstMessage\":\"Hi Example\",\"followups\":[{{\"text\":\"Still there?\",\"delayDays\":2}}]}}' WHERE approval_id='{AP}';" +
          manual(spacingMinutes=1) + role() + f"SELECT {q('report', {'enrollmentId': E, 'event': 'already-connected'})};" +
          assert_sql(f"({item}->>'step')::int=1 AND {item}->>'text'='Hi Example' AND {item}->'blocked' = 'null'::jsonb") +
          f"DO $$ DECLARE act uuid; BEGIN SELECT (value->>'actionId')::uuid INTO act FROM jsonb_array_elements({view}->'items'); PERFORM public.seq_queue('start',jsonb_build_object('actionId',act)); END $$;" +
          answer('sent') +
          assert_sql(f"({item}->>'step')::int=2 AND {item}->>'text'='Still there?' AND {item}->>'blocked'='not-due' AND ({view}->'people'->0->>'stopReason')='next-step'") + 'RESET ROLE;' +
          assert_sql(f"(SELECT state='Skipped' FROM sequence_private.logical_actions WHERE id='{ACT}')") +
          assert_sql(f"(SELECT due_at BETWEEN now()+interval '47 hours' AND now()+interval '49 hours' AND state='Planned' FROM sequence_private.logical_actions WHERE enrollment_id='{E}' AND step=2)"))
    check('replied, messaged, withdrawn and declined stop the sequence, cancel open steps and refuse later reports',
          manual() + role() + f"SELECT {q('report', {'enrollmentId': E, 'event': 'replied'})};" +
          assert_sql(f"jsonb_array_length({view}->'items')=0 AND jsonb_array_length({view}->'people')=0") +
          deny(f"SELECT {q('report', {'enrollmentId': E, 'event': 'accepted'})}", '40001') + 'RESET ROLE;' +
          assert_sql(f"(SELECT status='Stopped' AND stop_reason='replied' FROM sequence_private.enrollments WHERE id='{E}')") +
          assert_sql(f"(SELECT state='Cancelled' FROM sequence_private.logical_actions WHERE id='{ACT}')") +
          assert_sql(f"(SELECT message_direction='incoming' AND message_at IS NOT NULL FROM sequence_private.observations WHERE prospect_id='{P}' AND observer_version='user-report-v1')") +
          second_person() + role() + f"SELECT {q('report', {'enrollmentId': E2, 'event': 'messaged'})};" + 'RESET ROLE;' +
          assert_sql(f"(SELECT status='Stopped' AND stop_reason='manual-takeover' FROM sequence_private.enrollments WHERE id='{E2}')") +
          f"UPDATE sequence_private.enrollments SET status='Held',stop_reason='execution-disabled' WHERE id='{E2}';" + role() + f"SELECT {q('report', {'enrollmentId': E2, 'event': 'declined'})};" + 'RESET ROLE;' +
          assert_sql(f"(SELECT status='Stopped' AND stop_reason='declined' FROM sequence_private.enrollments WHERE id='{E2}')") +
          assert_sql(f"EXISTS(SELECT 1 FROM sequence_private.observations WHERE prospect_id='{P2}' AND observer_version='user-report-v1' AND connection='RejectedConfirmed')"))
    check('campaign pause blocks new starts and keeps an unanswered start until the user answers',
          manual() + started() + role() + f"SELECT {rpc('control', {'requestId': uid(93), 'campaignId': C, 'revision': 1, 'action': 'pause'})};" +
          assert_sql(f"({view}->'current'->>'actionId')='{ACT}'") + answer('sent') +
          assert_sql(f"{view}->'current' = 'null'::jsonb AND ({view}->>'invitationsToday')::int=1") + 'RESET ROLE;' +
          assert_sql(f"(SELECT status='Paused' FROM sequence_private.enrollments WHERE id='{E}')") +
          assert_sql(f"(SELECT state='ConfirmedSent' FROM sequence_private.logical_actions WHERE id='{ACT}')") +
          second_person() + role() + assert_sql(f"{item}->>'blocked'='campaign-paused'"))
    check('queue is tenant-scoped and denied to anonymous, worker, backup and runtime roles',
          manual() + role('authenticated', uid(1, 2)) + assert_sql(f"jsonb_array_length({view}->'items')=0 AND jsonb_array_length({view}->'people')=1 AND ({view}->'people'->0->>'enrollmentId')='{uid(10, 2)}' AND ({view}->>'executionMode')='disabled'") +
          deny(f"SELECT {q('start', {'actionId': ACT})}", '22023') + deny(f"SELECT {q('report', {'enrollmentId': E, 'event': 'accepted'})}", '22023') + 'RESET ROLE;' +
          role('anon', '') + deny(f"SELECT {view}", '42501') + 'RESET ROLE;' +
          role('sequence_worker') + deny(f"SELECT {view}", '42501') + 'RESET ROLE;' +
          role('sequence_backup') + deny(f"SELECT {view}", '42501') + 'RESET ROLE;' +
          role('sequence_auth_runtime') + deny(f"SELECT {view}", '42501') + deny("SELECT sequence_private.queue_view('" + W + "','" + A + "')", '42501') + 'RESET ROLE;')
