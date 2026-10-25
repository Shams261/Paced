-- S3-003: relational foundation. No executor API or live send authority.
CREATE SCHEMA sequence_private;
REVOKE ALL ON SCHEMA sequence_private FROM PUBLIC, anon, authenticated, service_role;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sequence_worker') THEN
  CREATE ROLE sequence_worker NOLOGIN NOINHERIT NOBYPASSRLS;
 END IF;
END $$;
GRANT sequence_worker TO postgres;
GRANT USAGE ON SCHEMA sequence_private TO authenticated, sequence_worker;
GRANT USAGE ON SCHEMA public TO sequence_worker;
CREATE TABLE sequence_private.access_allowlist (
 user_id uuid PRIMARY KEY REFERENCES auth.users(id), active boolean NOT NULL DEFAULT false);
CREATE TABLE public.seq_workspaces (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL UNIQUE REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(), synthetic boolean NOT NULL DEFAULT true);
CREATE FUNCTION sequence_private.owns_workspace(w uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.seq_workspaces s JOIN sequence_private.access_allowlist a
 ON a.user_id=s.owner_id WHERE s.id=w AND s.owner_id=(SELECT auth.uid()) AND a.active);
$$;
REVOKE ALL ON FUNCTION sequence_private.owns_workspace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sequence_private.owns_workspace(uuid) TO authenticated, sequence_worker;
CREATE TABLE public.seq_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL UNIQUE REFERENCES public.seq_workspaces(id),
 external_identity text NOT NULL, identity_verified_at timestamptz, timezone text,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), sending_enabled boolean NOT NULL DEFAULT false CHECK(NOT sending_enabled),
 UNIQUE(workspace_id,id));
CREATE TABLE public.seq_prospects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 recipient_key text NOT NULL CHECK(length(recipient_key)>0), display_name text NOT NULL,
 role_title text, company text, source text NOT NULL CHECK(source IN ('synthetic','verified-adapter')),
 observed_at timestamptz NOT NULL, connection text NOT NULL DEFAULT 'Unknown' CHECK(connection IN
 ('Unknown','NotConnected','Pending','Connected','WithdrawnConfirmed','RejectedConfirmed')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), UNIQUE(account_id,recipient_key),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE public.seq_lists (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name)>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE public.seq_list_memberships (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 list_id uuid NOT NULL, prospect_id uuid NOT NULL, UNIQUE(list_id,prospect_id),
 FOREIGN KEY(workspace_id,account_id,list_id) REFERENCES public.seq_lists(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id,prospect_id) REFERENCES public.seq_prospects(workspace_id,account_id,id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE public.seq_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name)>0), status text NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Paused','Stopped')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE sequence_private.content_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 campaign_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 invitation_note text, first_message text NOT NULL CHECK(length(first_message)>0),
 followups jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(followups)='array' AND jsonb_array_length(followups)<=3),
 settings jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(settings)='object'),
 UNIQUE(campaign_id,revision), UNIQUE(workspace_id,account_id,campaign_id,id),
 FOREIGN KEY(workspace_id,account_id,campaign_id) REFERENCES public.seq_campaigns(workspace_id,account_id,id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE sequence_private.approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 campaign_id uuid NOT NULL, content_revision_id uuid NOT NULL, approver_id uuid NOT NULL REFERENCES auth.users(id),
 approved_at timestamptz NOT NULL DEFAULT now(), settings_revision bigint NOT NULL CHECK(settings_revision>0),
 UNIQUE(workspace_id,account_id,campaign_id,content_revision_id,id),
 FOREIGN KEY(workspace_id,account_id,campaign_id,content_revision_id)
 REFERENCES sequence_private.content_revisions(workspace_id,account_id,campaign_id,id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE sequence_private.approval_recipients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 campaign_id uuid NOT NULL, content_revision_id uuid NOT NULL, approval_id uuid NOT NULL, prospect_id uuid NOT NULL,
 rendered_content jsonb NOT NULL CHECK(jsonb_typeof(rendered_content)='object'), UNIQUE(approval_id,prospect_id),
 UNIQUE(workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id),
 FOREIGN KEY(workspace_id,account_id,campaign_id,content_revision_id,approval_id)
 REFERENCES sequence_private.approvals(workspace_id,account_id,campaign_id,content_revision_id,id),
 FOREIGN KEY(workspace_id,account_id,prospect_id) REFERENCES public.seq_prospects(workspace_id,account_id,id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE sequence_private.observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 prospect_id uuid NOT NULL, observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 observer_version text NOT NULL, connection text NOT NULL CHECK(connection IN
 ('Unknown','NotConnected','Pending','Connected','WithdrawnConfirmed','RejectedConfirmed')),
 complete boolean NOT NULL DEFAULT false, message_direction text CHECK(message_direction IN ('incoming','outgoing')),
 message_at timestamptz, fingerprint text, UNIQUE(workspace_id,account_id,prospect_id,id),
 FOREIGN KEY(workspace_id,account_id,prospect_id) REFERENCES public.seq_prospects(workspace_id,account_id,id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE sequence_private.enrollments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 campaign_id uuid NOT NULL, content_revision_id uuid NOT NULL, approval_id uuid NOT NULL, prospect_id uuid NOT NULL,
 baseline_observation_id uuid NOT NULL, status text NOT NULL DEFAULT 'Held' CHECK(status IN ('Active','Waiting','Paused','Held','Stopped','Completed')),
 stop_reason text, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 UNIQUE(workspace_id,account_id,content_revision_id,id),
 FOREIGN KEY(workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id)
 REFERENCES sequence_private.approval_recipients(workspace_id,account_id,campaign_id,content_revision_id,approval_id,prospect_id),
 FOREIGN KEY(workspace_id,account_id,prospect_id,baseline_observation_id)
 REFERENCES sequence_private.observations(workspace_id,account_id,prospect_id,id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE UNIQUE INDEX one_active_recipient ON sequence_private.enrollments(account_id,prospect_id) WHERE status IN ('Active','Waiting','Paused','Held');
CREATE TABLE sequence_private.logical_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 enrollment_id uuid NOT NULL, content_revision_id uuid NOT NULL, step integer NOT NULL CHECK(step BETWEEN 0 AND 4),
 kind text NOT NULL CHECK(kind IN ('Invitation','Message')), CHECK((step=0 AND kind='Invitation') OR (step>0 AND kind='Message')),
 due_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'Planned' CHECK(state IN
 ('Planned','Due','Claimed','Authorized','MayHaveSent','ConfirmedSent','NotSent','OutcomeUnknown','Cancelled','Skipped')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), UNIQUE(enrollment_id,step),
 FOREIGN KEY(workspace_id,account_id,content_revision_id,enrollment_id)
 REFERENCES sequence_private.enrollments(workspace_id,account_id,content_revision_id,id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE sequence_private.account_execution_state (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0), lease_executor uuid, lease_expires_at timestamptz,
 UNIQUE(account_id), CHECK((lease_executor IS NULL)=(lease_expires_at IS NULL)),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE sequence_private.execution_leases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 executor_id uuid NOT NULL, fence bigint NOT NULL CHECK(fence>0), issued_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, CHECK(expires_at>issued_at), UNIQUE(account_id,fence),
 UNIQUE(workspace_id,account_id,id,fence),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE sequence_private.attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 action_id uuid NOT NULL, lease_id uuid NOT NULL, fence bigint NOT NULL, attempt_number integer NOT NULL CHECK(attempt_number>0),
 UNIQUE(action_id,attempt_number), UNIQUE(workspace_id,account_id,action_id,id),
 FOREIGN KEY(workspace_id,account_id,action_id) REFERENCES sequence_private.logical_actions(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id,lease_id,fence) REFERENCES sequence_private.execution_leases(workspace_id,account_id,id,fence),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE sequence_private.attempt_results (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 action_id uuid NOT NULL, attempt_id uuid NOT NULL, outcome text NOT NULL CHECK(outcome IN ('ConfirmedSent','NotSent','OutcomeUnknown')),
 observed_at timestamptz NOT NULL, evidence_reference text NOT NULL, UNIQUE(attempt_id,outcome),
 FOREIGN KEY(workspace_id,account_id,action_id,attempt_id) REFERENCES sequence_private.attempts(workspace_id,account_id,action_id,id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE TABLE sequence_private.send_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.seq_workspaces(id),
 account_id uuid NOT NULL,
 action_id uuid NOT NULL, attempt_id uuid NOT NULL UNIQUE, possible_send_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz, resolution text CHECK(resolution IN ('ConfirmedSent','NotSent')),
 CHECK((resolved_at IS NULL)=(resolution IS NULL)),
 FOREIGN KEY(workspace_id,account_id,action_id,attempt_id) REFERENCES sequence_private.attempts(workspace_id,account_id,action_id,id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES public.seq_accounts(workspace_id,id)
);
CREATE UNIQUE INDEX one_unresolved_sender ON sequence_private.send_reservations(account_id) WHERE resolved_at IS NULL;
ALTER TABLE public.seq_workspaces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seq_workspaces FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON public.seq_workspaces TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON public.seq_workspaces FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(id));
ALTER TABLE public.seq_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seq_accounts FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON public.seq_accounts TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON public.seq_accounts FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON public.seq_accounts(workspace_id);
ALTER TABLE public.seq_prospects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seq_prospects FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON public.seq_prospects TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON public.seq_prospects FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON public.seq_prospects(workspace_id);
GRANT INSERT, DELETE ON public.seq_prospects TO authenticated;
CREATE POLICY tenant_insert ON public.seq_prospects FOR INSERT TO authenticated WITH CHECK(sequence_private.owns_workspace(workspace_id));
CREATE POLICY tenant_update ON public.seq_prospects FOR UPDATE TO authenticated USING(sequence_private.owns_workspace(workspace_id)) WITH CHECK(sequence_private.owns_workspace(workspace_id));
CREATE POLICY tenant_delete ON public.seq_prospects FOR DELETE TO authenticated USING(sequence_private.owns_workspace(workspace_id));
GRANT UPDATE(display_name,role_title,company) ON public.seq_prospects TO authenticated;
ALTER TABLE public.seq_lists ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seq_lists FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON public.seq_lists TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON public.seq_lists FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON public.seq_lists(workspace_id);
GRANT INSERT, DELETE ON public.seq_lists TO authenticated;
CREATE POLICY tenant_insert ON public.seq_lists FOR INSERT TO authenticated WITH CHECK(sequence_private.owns_workspace(workspace_id));
CREATE POLICY tenant_update ON public.seq_lists FOR UPDATE TO authenticated USING(sequence_private.owns_workspace(workspace_id)) WITH CHECK(sequence_private.owns_workspace(workspace_id));
CREATE POLICY tenant_delete ON public.seq_lists FOR DELETE TO authenticated USING(sequence_private.owns_workspace(workspace_id));
GRANT UPDATE(name) ON public.seq_lists TO authenticated;
ALTER TABLE public.seq_list_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seq_list_memberships FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON public.seq_list_memberships TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON public.seq_list_memberships FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON public.seq_list_memberships(workspace_id);
GRANT INSERT, DELETE ON public.seq_list_memberships TO authenticated;
CREATE POLICY tenant_insert ON public.seq_list_memberships FOR INSERT TO authenticated WITH CHECK(sequence_private.owns_workspace(workspace_id));
CREATE POLICY tenant_update ON public.seq_list_memberships FOR UPDATE TO authenticated USING(sequence_private.owns_workspace(workspace_id)) WITH CHECK(sequence_private.owns_workspace(workspace_id));
CREATE POLICY tenant_delete ON public.seq_list_memberships FOR DELETE TO authenticated USING(sequence_private.owns_workspace(workspace_id));
ALTER TABLE public.seq_campaigns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seq_campaigns FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON public.seq_campaigns TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON public.seq_campaigns FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON public.seq_campaigns(workspace_id);
GRANT INSERT, DELETE ON public.seq_campaigns TO authenticated;
CREATE POLICY tenant_insert ON public.seq_campaigns FOR INSERT TO authenticated WITH CHECK(sequence_private.owns_workspace(workspace_id));
CREATE POLICY tenant_update ON public.seq_campaigns FOR UPDATE TO authenticated USING(sequence_private.owns_workspace(workspace_id)) WITH CHECK(sequence_private.owns_workspace(workspace_id));
CREATE POLICY tenant_delete ON public.seq_campaigns FOR DELETE TO authenticated USING(sequence_private.owns_workspace(workspace_id));
GRANT UPDATE(name) ON public.seq_campaigns TO authenticated;
ALTER TABLE sequence_private.content_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.content_revisions FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON sequence_private.content_revisions TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON sequence_private.content_revisions FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON sequence_private.content_revisions(workspace_id);
ALTER TABLE sequence_private.approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.approvals FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON sequence_private.approvals TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON sequence_private.approvals FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON sequence_private.approvals(workspace_id);
ALTER TABLE sequence_private.approval_recipients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.approval_recipients FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON sequence_private.approval_recipients TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON sequence_private.approval_recipients FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON sequence_private.approval_recipients(workspace_id);
ALTER TABLE sequence_private.observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.observations FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON sequence_private.observations TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON sequence_private.observations FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON sequence_private.observations(workspace_id);
ALTER TABLE sequence_private.enrollments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.enrollments FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON sequence_private.enrollments TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON sequence_private.enrollments FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON sequence_private.enrollments(workspace_id);
ALTER TABLE sequence_private.logical_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.logical_actions FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON sequence_private.logical_actions TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON sequence_private.logical_actions FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON sequence_private.logical_actions(workspace_id);
ALTER TABLE sequence_private.account_execution_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.account_execution_state FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON sequence_private.account_execution_state TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON sequence_private.account_execution_state FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON sequence_private.account_execution_state(workspace_id);
ALTER TABLE sequence_private.execution_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.execution_leases FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON sequence_private.execution_leases TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON sequence_private.execution_leases FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON sequence_private.execution_leases(workspace_id);
ALTER TABLE sequence_private.attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.attempts FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON sequence_private.attempts TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON sequence_private.attempts FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON sequence_private.attempts(workspace_id);
ALTER TABLE sequence_private.attempt_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.attempt_results FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON sequence_private.attempt_results TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON sequence_private.attempt_results FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON sequence_private.attempt_results(workspace_id);
ALTER TABLE sequence_private.send_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.send_reservations FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
GRANT SELECT ON sequence_private.send_reservations TO authenticated, sequence_worker;
CREATE POLICY tenant_read ON sequence_private.send_reservations FOR SELECT TO authenticated, sequence_worker USING(sequence_private.owns_workspace(workspace_id));
CREATE INDEX ON sequence_private.send_reservations(workspace_id);
REVOKE SELECT ON sequence_private.account_execution_state FROM authenticated;
REVOKE SELECT ON sequence_private.execution_leases FROM authenticated;
REVOKE SELECT ON sequence_private.attempts FROM authenticated;
REVOKE SELECT ON sequence_private.attempt_results FROM authenticated;
REVOKE SELECT ON sequence_private.send_reservations FROM authenticated;
CREATE FUNCTION sequence_private.bump_revision() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN NEW.revision=OLD.revision+1; RETURN NEW; END $$;
REVOKE ALL ON FUNCTION sequence_private.bump_revision() FROM PUBLIC;
CREATE TRIGGER bump_revision BEFORE UPDATE ON public.seq_prospects FOR EACH ROW EXECUTE FUNCTION sequence_private.bump_revision();
CREATE TRIGGER bump_revision BEFORE UPDATE ON public.seq_campaigns FOR EACH ROW EXECUTE FUNCTION sequence_private.bump_revision();
GRANT INSERT ON sequence_private.content_revisions TO sequence_worker;
CREATE POLICY worker_insert ON sequence_private.content_revisions FOR INSERT TO sequence_worker WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT INSERT ON sequence_private.approvals TO sequence_worker;
CREATE POLICY worker_insert ON sequence_private.approvals FOR INSERT TO sequence_worker WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT INSERT ON sequence_private.approval_recipients TO sequence_worker;
CREATE POLICY worker_insert ON sequence_private.approval_recipients FOR INSERT TO sequence_worker WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT INSERT ON sequence_private.observations TO sequence_worker;
CREATE POLICY worker_insert ON sequence_private.observations FOR INSERT TO sequence_worker WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT INSERT ON sequence_private.enrollments TO sequence_worker;
CREATE POLICY worker_insert ON sequence_private.enrollments FOR INSERT TO sequence_worker WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT INSERT ON sequence_private.logical_actions TO sequence_worker;
CREATE POLICY worker_insert ON sequence_private.logical_actions FOR INSERT TO sequence_worker WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT INSERT ON sequence_private.account_execution_state TO sequence_worker;
CREATE POLICY worker_insert ON sequence_private.account_execution_state FOR INSERT TO sequence_worker WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT INSERT ON sequence_private.execution_leases TO sequence_worker;
CREATE POLICY worker_insert ON sequence_private.execution_leases FOR INSERT TO sequence_worker WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT INSERT ON sequence_private.attempts TO sequence_worker;
CREATE POLICY worker_insert ON sequence_private.attempts FOR INSERT TO sequence_worker WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT INSERT ON sequence_private.attempt_results TO sequence_worker;
CREATE POLICY worker_insert ON sequence_private.attempt_results FOR INSERT TO sequence_worker WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT INSERT ON sequence_private.send_reservations TO sequence_worker;
CREATE POLICY worker_insert ON sequence_private.send_reservations FOR INSERT TO sequence_worker WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT UPDATE(status,stop_reason,revision) ON sequence_private.enrollments TO sequence_worker;
CREATE POLICY worker_update ON sequence_private.enrollments FOR UPDATE TO sequence_worker USING(sequence_private.owns_workspace(workspace_id)) WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT UPDATE(state,due_at,revision) ON sequence_private.logical_actions TO sequence_worker;
CREATE POLICY worker_update ON sequence_private.logical_actions FOR UPDATE TO sequence_worker USING(sequence_private.owns_workspace(workspace_id)) WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT UPDATE(fence,lease_executor,lease_expires_at) ON sequence_private.account_execution_state TO sequence_worker;
CREATE POLICY worker_update ON sequence_private.account_execution_state FOR UPDATE TO sequence_worker USING(sequence_private.owns_workspace(workspace_id)) WITH CHECK(sequence_private.owns_workspace(workspace_id));
GRANT UPDATE(resolved_at,resolution) ON sequence_private.send_reservations TO sequence_worker;
CREATE POLICY worker_update ON sequence_private.send_reservations FOR UPDATE TO sequence_worker USING(sequence_private.owns_workspace(workspace_id)) WITH CHECK(sequence_private.owns_workspace(workspace_id));
REVOKE ALL ON sequence_private.access_allowlist FROM PUBLIC, anon, authenticated, service_role, sequence_worker;
