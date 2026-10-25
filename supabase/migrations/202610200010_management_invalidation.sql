-- Keep immutable action content history when the current enrollment is reapproved.
DO $$ DECLARE constraint_name text; BEGIN
 SELECT conname INTO constraint_name FROM pg_constraint WHERE conrelid='sequence_private.logical_actions'::regclass AND confrelid='sequence_private.enrollments'::regclass AND contype='f';
 EXECUTE format('ALTER TABLE sequence_private.logical_actions DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE sequence_private.logical_actions ADD CONSTRAINT action_enrollment_identity
 FOREIGN KEY(workspace_id,account_id,enrollment_id) REFERENCES sequence_private.enrollments(workspace_id,account_id,id);
ALTER TABLE sequence_private.logical_actions ADD CONSTRAINT action_content_history
 FOREIGN KEY(workspace_id,account_id,content_revision_id) REFERENCES sequence_private.content_revisions(workspace_id,account_id,id);
CREATE FUNCTION sequence_private.guard_action_campaign() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sequence_private.enrollments e JOIN sequence_private.content_revisions r ON r.campaign_id=e.campaign_id AND r.workspace_id=e.workspace_id AND r.account_id=e.account_id WHERE e.id=NEW.enrollment_id AND r.id=NEW.content_revision_id) THEN
  RAISE EXCEPTION 'Action content campaign mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sequence_private.guard_action_campaign() FROM PUBLIC;
CREATE TRIGGER guard_action_campaign BEFORE INSERT OR UPDATE OF content_revision_id,enrollment_id ON sequence_private.logical_actions FOR EACH ROW EXECUTE FUNCTION sequence_private.guard_action_campaign();

CREATE FUNCTION sequence_private.invalidate_campaign_intent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE sequence_private.enrollments SET
  status=CASE NEW.status WHEN 'Stopped' THEN 'Stopped' WHEN 'Paused' THEN 'Paused' ELSE 'Held' END,
  stop_reason=CASE NEW.status WHEN 'Stopped' THEN 'user-stop' WHEN 'Paused' THEN 'campaign-paused' ELSE 'approval-required' END,
  revision=revision+1 WHERE campaign_id=NEW.id AND status NOT IN ('Stopped','Completed');
 UPDATE sequence_private.logical_actions SET state='Cancelled',revision=revision+1 WHERE enrollment_id IN (SELECT id FROM sequence_private.enrollments WHERE campaign_id=NEW.id) AND state NOT IN ('ConfirmedSent','MayHaveSent','OutcomeUnknown','Skipped','Cancelled');
 UPDATE sequence_private.account_execution_state SET fence=fence+1,lease_executor=NULL,lease_expires_at=NULL WHERE account_id=NEW.account_id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sequence_private.invalidate_campaign_intent() FROM PUBLIC;
CREATE TRIGGER invalidate_campaign_intent AFTER UPDATE ON public.seq_campaigns FOR EACH ROW EXECUTE FUNCTION sequence_private.invalidate_campaign_intent();
CREATE FUNCTION sequence_private.invalidate_profile_approval() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF ROW(NEW.display_name,NEW.role_title,NEW.company,NEW.connection) IS DISTINCT FROM ROW(OLD.display_name,OLD.role_title,OLD.company,OLD.connection) THEN
  UPDATE public.seq_campaigns ca SET name=ca.name WHERE ca.workspace_id=NEW.workspace_id AND ca.status<>'Stopped' AND EXISTS(
   SELECT 1 FROM sequence_private.content_revisions r WHERE r.campaign_id=ca.id AND r.settings->'recipients' ? NEW.id::text
   AND r.revision=(SELECT max(latest.revision) FROM sequence_private.content_revisions latest WHERE latest.campaign_id=ca.id));
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sequence_private.invalidate_profile_approval() FROM PUBLIC;
CREATE TRIGGER invalidate_profile_approval AFTER UPDATE ON public.seq_prospects FOR EACH ROW EXECUTE FUNCTION sequence_private.invalidate_profile_approval();
