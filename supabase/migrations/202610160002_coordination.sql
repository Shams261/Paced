-- Storage coordination only. No endpoint or permission to execute LinkedIn sends.
CREATE UNIQUE INDEX one_final_attempt_result ON sequence_private.attempt_results(attempt_id)
 WHERE outcome IN ('ConfirmedSent','NotSent');
REVOKE INSERT, UPDATE ON sequence_private.account_execution_state FROM sequence_worker;
REVOKE UPDATE(fence,lease_executor,lease_expires_at) ON sequence_private.account_execution_state FROM sequence_worker;
REVOKE INSERT ON sequence_private.execution_leases FROM sequence_worker;
REVOKE INSERT, UPDATE ON sequence_private.send_reservations FROM sequence_worker;
REVOKE UPDATE(resolved_at,resolution) ON sequence_private.send_reservations FROM sequence_worker;

CREATE FUNCTION sequence_private.acquire_storage_lease(w uuid,a uuid,executor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE row_state sequence_private.account_execution_state; lease uuid; now_time timestamptz;
BEGIN
 IF NOT sequence_private.owns_workspace(w) OR executor IS NULL THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 INSERT INTO sequence_private.account_execution_state(workspace_id,account_id) VALUES(w,a) ON CONFLICT(account_id) DO NOTHING;
 SELECT * INTO STRICT row_state FROM sequence_private.account_execution_state WHERE workspace_id=w AND account_id=a FOR UPDATE;
 now_time=clock_timestamp();
 IF row_state.lease_expires_at>now_time OR EXISTS(SELECT 1 FROM sequence_private.send_reservations WHERE account_id=a AND resolved_at IS NULL)
 THEN RAISE EXCEPTION 'Account busy or outcome unresolved' USING ERRCODE='55000'; END IF;
 UPDATE sequence_private.account_execution_state SET fence=fence+1,lease_executor=executor,lease_expires_at=now_time+interval '60 seconds' WHERE account_id=a;
 INSERT INTO sequence_private.execution_leases(workspace_id,account_id,executor_id,fence,issued_at,expires_at)
 VALUES(w,a,executor,row_state.fence+1,now_time,now_time+interval '60 seconds') RETURNING id INTO lease;
 RETURN lease;
END $$;
REVOKE ALL ON FUNCTION sequence_private.acquire_storage_lease(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sequence_private.acquire_storage_lease(uuid,uuid,uuid) TO sequence_worker;

CREATE FUNCTION sequence_private.guard_attempt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE coord sequence_private.account_execution_state; lease sequence_private.execution_leases;
BEGIN
 SELECT * INTO STRICT coord FROM sequence_private.account_execution_state WHERE workspace_id=NEW.workspace_id AND account_id=NEW.account_id FOR UPDATE;
 SELECT * INTO STRICT lease FROM sequence_private.execution_leases WHERE id=NEW.lease_id AND account_id=NEW.account_id AND workspace_id=NEW.workspace_id;
 IF coord.fence<>NEW.fence OR lease.fence<>NEW.fence OR coord.lease_executor<>lease.executor_id OR coord.lease_expires_at<=clock_timestamp()
 OR EXISTS(SELECT 1 FROM sequence_private.send_reservations WHERE account_id=NEW.account_id AND resolved_at IS NULL)
 THEN RAISE EXCEPTION 'Stale lease or unresolved outcome' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sequence_private.guard_attempt() FROM PUBLIC;
CREATE TRIGGER guard_attempt BEFORE INSERT ON sequence_private.attempts FOR EACH ROW EXECUTE FUNCTION sequence_private.guard_attempt();

CREATE FUNCTION sequence_private.record_possible_send(w uuid,a uuid,attempt uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE coord sequence_private.account_execution_state; att sequence_private.attempts; reservation uuid;
BEGIN
 IF NOT sequence_private.owns_workspace(w) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT coord FROM sequence_private.account_execution_state WHERE workspace_id=w AND account_id=a FOR UPDATE;
 SELECT * INTO STRICT att FROM sequence_private.attempts WHERE id=attempt AND workspace_id=w AND account_id=a;
 SELECT id INTO reservation FROM sequence_private.send_reservations WHERE attempt_id=attempt;
 IF reservation IS NOT NULL THEN RETURN reservation; END IF;
 IF coord.fence<>att.fence OR coord.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Stale lease' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM sequence_private.attempt_results WHERE attempt_id=attempt AND outcome IN ('NotSent','ConfirmedSent')) THEN
 RAISE EXCEPTION 'Attempt already resolved' USING ERRCODE='55000'; END IF;
 INSERT INTO sequence_private.send_reservations(workspace_id,account_id,action_id,attempt_id)
 VALUES(w,a,att.action_id,attempt) RETURNING id INTO reservation;
 RETURN reservation;
END $$;
REVOKE ALL ON FUNCTION sequence_private.record_possible_send(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sequence_private.record_possible_send(uuid,uuid,uuid) TO sequence_worker;

CREATE FUNCTION sequence_private.resolve_reservation(w uuid,a uuid,attempt uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE final_outcome text;
BEGIN
 IF NOT sequence_private.owns_workspace(w) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM sequence_private.account_execution_state WHERE workspace_id=w AND account_id=a FOR UPDATE;
 SELECT outcome INTO STRICT final_outcome FROM sequence_private.attempt_results
 WHERE workspace_id=w AND account_id=a AND attempt_id=attempt AND outcome IN ('ConfirmedSent','NotSent');
 UPDATE sequence_private.send_reservations SET resolved_at=clock_timestamp(),resolution=final_outcome
 WHERE workspace_id=w AND account_id=a AND attempt_id=attempt AND resolved_at IS NULL;
END $$;
REVOKE ALL ON FUNCTION sequence_private.resolve_reservation(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sequence_private.resolve_reservation(uuid,uuid,uuid) TO sequence_worker;
-- Newly imported data cannot assert verified external state through ordinary client writes.
DROP POLICY tenant_insert ON public.seq_prospects;
CREATE POLICY tenant_insert ON public.seq_prospects FOR INSERT TO authenticated
 WITH CHECK(sequence_private.owns_workspace(workspace_id) AND source='synthetic' AND connection='Unknown');
