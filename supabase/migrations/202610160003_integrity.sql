-- Forward refinement after self-review; applied migrations stay immutable.
CREATE FUNCTION sequence_private.guard_approver() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.seq_workspaces WHERE id=NEW.workspace_id AND owner_id=NEW.approver_id) THEN
  RAISE EXCEPTION 'Approver must own workspace' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sequence_private.guard_approver() FROM PUBLIC;
CREATE TRIGGER guard_approver BEFORE INSERT ON sequence_private.approvals FOR EACH ROW EXECUTE FUNCTION sequence_private.guard_approver();
CREATE INDEX queue_due ON sequence_private.logical_actions(workspace_id,account_id,due_at,id) WHERE state IN ('Planned','Due');
CREATE INDEX observations_by_recipient_time ON sequence_private.observations(workspace_id,account_id,prospect_id,observed_at DESC);
CREATE INDEX enrollment_campaign ON sequence_private.enrollments(workspace_id,account_id,campaign_id);
CREATE INDEX action_enrollment ON sequence_private.logical_actions(workspace_id,account_id,enrollment_id);
CREATE INDEX attempts_action ON sequence_private.attempts(workspace_id,account_id,action_id);
CREATE INDEX results_attempt ON sequence_private.attempt_results(workspace_id,account_id,attempt_id);
CREATE INDEX membership_prospect ON public.seq_list_memberships(workspace_id,account_id,prospect_id);
NOTIFY pgrst, 'reload schema';
