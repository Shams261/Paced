-- Synthetic-only test fixtures; never apply to development.

INSERT INTO auth.users(id,aud,role,email,email_confirmed_at) VALUES('00000001-0000-0000-0000-000000000001','authenticated','authenticated','s3-fixture-1@example.invalid',now());
INSERT INTO sequence_private.access_allowlist VALUES('00000001-0000-0000-0000-000000000001',true);
INSERT INTO public.seq_workspaces(id,owner_id,synthetic) VALUES('00000002-0000-0000-0000-000000000001','00000001-0000-0000-0000-000000000001',true);
INSERT INTO public.seq_accounts(id,workspace_id,external_identity) VALUES('00000003-0000-0000-0000-000000000001','00000002-0000-0000-0000-000000000001','synthetic-account-1');
INSERT INTO public.seq_prospects(id,workspace_id,account_id,recipient_key,display_name,source,observed_at)
 VALUES('00000004-0000-0000-0000-000000000001','00000002-0000-0000-0000-000000000001','00000003-0000-0000-0000-000000000001','synthetic-recipient','Example Person','synthetic',now());
INSERT INTO public.seq_lists(id,workspace_id,account_id,name) VALUES('00000005-0000-0000-0000-000000000001','00000002-0000-0000-0000-000000000001','00000003-0000-0000-0000-000000000001','Example List');
INSERT INTO public.seq_campaigns(id,workspace_id,account_id,name) VALUES('00000006-0000-0000-0000-000000000001','00000002-0000-0000-0000-000000000001','00000003-0000-0000-0000-000000000001','Example Campaign');
INSERT INTO sequence_private.content_revisions(id,workspace_id,account_id,campaign_id,revision,first_message)
 VALUES('00000007-0000-0000-0000-000000000001','00000002-0000-0000-0000-000000000001','00000003-0000-0000-0000-000000000001','00000006-0000-0000-0000-000000000001',1,'Synthetic approved content');
INSERT INTO sequence_private.approvals(id,workspace_id,account_id,campaign_id,content_revision_id,approver_id,settings_revision)
 VALUES('00000008-0000-0000-0000-000000000001','00000002-0000-0000-0000-000000000001','00000003-0000-0000-0000-000000000001','00000006-0000-0000-0000-000000000001','00000007-0000-0000-0000-000000000001','00000001-0000-0000-0000-000000000001',1);
INSERT INTO sequence_private.approval_recipients(workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id,rendered_content)
 VALUES('00000002-0000-0000-0000-000000000001','00000003-0000-0000-0000-000000000001','00000006-0000-0000-0000-000000000001','00000007-0000-0000-0000-000000000001','00000008-0000-0000-0000-000000000001','00000004-0000-0000-0000-000000000001','{"firstMessage":"Synthetic approved content"}');
INSERT INTO sequence_private.observations(id,workspace_id,account_id,prospect_id,observed_at,observer_version,connection,complete)
 VALUES('00000009-0000-0000-0000-000000000001','00000002-0000-0000-0000-000000000001','00000003-0000-0000-0000-000000000001','00000004-0000-0000-0000-000000000001',now(),'synthetic-v1','NotConnected',true);
INSERT INTO sequence_private.enrollments(id,workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id,baseline_observation_id,status)
 VALUES('00000010-0000-0000-0000-000000000001','00000002-0000-0000-0000-000000000001','00000003-0000-0000-0000-000000000001','00000006-0000-0000-0000-000000000001','00000007-0000-0000-0000-000000000001','00000008-0000-0000-0000-000000000001','00000004-0000-0000-0000-000000000001','00000009-0000-0000-0000-000000000001','Held');
INSERT INTO sequence_private.logical_actions(id,workspace_id,account_id,enrollment_id,content_revision_id,step,kind,due_at)
 VALUES('00000011-0000-0000-0000-000000000001','00000002-0000-0000-0000-000000000001','00000003-0000-0000-0000-000000000001','00000010-0000-0000-0000-000000000001','00000007-0000-0000-0000-000000000001',0,'Invitation',now());

INSERT INTO auth.users(id,aud,role,email,email_confirmed_at) VALUES('00000001-0000-0000-0000-000000000002','authenticated','authenticated','s3-fixture-2@example.invalid',now());
INSERT INTO sequence_private.access_allowlist VALUES('00000001-0000-0000-0000-000000000002',true);
INSERT INTO public.seq_workspaces(id,owner_id,synthetic) VALUES('00000002-0000-0000-0000-000000000002','00000001-0000-0000-0000-000000000002',true);
INSERT INTO public.seq_accounts(id,workspace_id,external_identity) VALUES('00000003-0000-0000-0000-000000000002','00000002-0000-0000-0000-000000000002','synthetic-account-2');
INSERT INTO public.seq_prospects(id,workspace_id,account_id,recipient_key,display_name,source,observed_at)
 VALUES('00000004-0000-0000-0000-000000000002','00000002-0000-0000-0000-000000000002','00000003-0000-0000-0000-000000000002','synthetic-recipient','Example Person','synthetic',now());
INSERT INTO public.seq_lists(id,workspace_id,account_id,name) VALUES('00000005-0000-0000-0000-000000000002','00000002-0000-0000-0000-000000000002','00000003-0000-0000-0000-000000000002','Example List');
INSERT INTO public.seq_campaigns(id,workspace_id,account_id,name) VALUES('00000006-0000-0000-0000-000000000002','00000002-0000-0000-0000-000000000002','00000003-0000-0000-0000-000000000002','Example Campaign');
INSERT INTO sequence_private.content_revisions(id,workspace_id,account_id,campaign_id,revision,first_message)
 VALUES('00000007-0000-0000-0000-000000000002','00000002-0000-0000-0000-000000000002','00000003-0000-0000-0000-000000000002','00000006-0000-0000-0000-000000000002',1,'Synthetic approved content');
INSERT INTO sequence_private.approvals(id,workspace_id,account_id,campaign_id,content_revision_id,approver_id,settings_revision)
 VALUES('00000008-0000-0000-0000-000000000002','00000002-0000-0000-0000-000000000002','00000003-0000-0000-0000-000000000002','00000006-0000-0000-0000-000000000002','00000007-0000-0000-0000-000000000002','00000001-0000-0000-0000-000000000002',1);
INSERT INTO sequence_private.approval_recipients(workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id,rendered_content)
 VALUES('00000002-0000-0000-0000-000000000002','00000003-0000-0000-0000-000000000002','00000006-0000-0000-0000-000000000002','00000007-0000-0000-0000-000000000002','00000008-0000-0000-0000-000000000002','00000004-0000-0000-0000-000000000002','{"firstMessage":"Synthetic approved content"}');
INSERT INTO sequence_private.observations(id,workspace_id,account_id,prospect_id,observed_at,observer_version,connection,complete)
 VALUES('00000009-0000-0000-0000-000000000002','00000002-0000-0000-0000-000000000002','00000003-0000-0000-0000-000000000002','00000004-0000-0000-0000-000000000002',now(),'synthetic-v1','NotConnected',true);
INSERT INTO sequence_private.enrollments(id,workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id,baseline_observation_id,status)
 VALUES('00000010-0000-0000-0000-000000000002','00000002-0000-0000-0000-000000000002','00000003-0000-0000-0000-000000000002','00000006-0000-0000-0000-000000000002','00000007-0000-0000-0000-000000000002','00000008-0000-0000-0000-000000000002','00000004-0000-0000-0000-000000000002','00000009-0000-0000-0000-000000000002','Held');
INSERT INTO sequence_private.logical_actions(id,workspace_id,account_id,enrollment_id,content_revision_id,step,kind,due_at)
 VALUES('00000011-0000-0000-0000-000000000002','00000002-0000-0000-0000-000000000002','00000003-0000-0000-0000-000000000002','00000010-0000-0000-0000-000000000002','00000007-0000-0000-0000-000000000002',0,'Invitation',now());

-- Provider and app sessions are synthetic; no real tokens are stored.
INSERT INTO auth.sessions(id,user_id,created_at,updated_at)
 SELECT ('00000050-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
 ('00000001-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,now(),now()
 FROM generate_series(1,2) n;
INSERT INTO sequence_private.auth_sessions(session_hash,user_id,provider_session_id,sealed_tokens,token_expires_at)
 SELECT repeat(CASE n WHEN 1 THEN 'A' ELSE 'B' END,43),
 ('00000001-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
 ('00000050-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
 '{"version":"fixture","iv":"fixture","ciphertext":"fixture"}'::jsonb,now()+interval '1 hour'
 FROM generate_series(1,2) n;

-- Operator reading fixture; without it egress is unverified and growth is blocked by design.
INSERT INTO sequence_private.provider_readings(meter,value,read_at,note) VALUES('egress_month_bytes',0,now(),'fixture');
