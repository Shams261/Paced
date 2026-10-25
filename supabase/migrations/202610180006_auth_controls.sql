-- S3-004: bounded authentication abuse controls and operator admission audit.
CREATE TABLE sequence_private.auth_rate_limits (
 scope text NOT NULL CHECK(scope IN ('login','callback','session')),
 bucket_hash text NOT NULL CHECK(bucket_hash ~ '^[A-Za-z0-9_-]{43}$'),
 window_start timestamptz NOT NULL,
 hits integer NOT NULL CHECK(hits>0),
 PRIMARY KEY(scope,bucket_hash)
);
CREATE TABLE sequence_private.auth_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
 reason text NOT NULL CHECK(reason IN ('approved','revoked','login_denied','session_denied','provider_unavailable')),
 request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sequence_private.auth_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_private.auth_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.auth_rate_limits,sequence_private.auth_audit FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_auth_runtime;
CREATE FUNCTION sequence_private.auth_rate_limit(scope_name text, identity_hash text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE duration interval; maximum integer; r sequence_private.auth_rate_limits%ROWTYPE;
BEGIN
 IF identity_hash IS NULL OR identity_hash !~ '^[A-Za-z0-9_-]{43}$' THEN RAISE EXCEPTION 'Invalid bucket' USING ERRCODE='22023'; END IF;
 CASE scope_name WHEN 'login' THEN duration:=interval '10 minutes';maximum:=10;
 WHEN 'callback' THEN duration:=interval '10 minutes';maximum:=20;
 WHEN 'session' THEN duration:=interval '1 minute';maximum:=120;
 ELSE RAISE EXCEPTION 'Invalid scope' USING ERRCODE='22023'; END CASE;
 INSERT INTO sequence_private.auth_rate_limits VALUES(scope_name,identity_hash,clock_timestamp(),1)
 ON CONFLICT(scope,bucket_hash) DO UPDATE SET
 hits=CASE WHEN auth_rate_limits.window_start+duration<=clock_timestamp() THEN 1 ELSE least(auth_rate_limits.hits+1,maximum+1) END,
 window_start=CASE WHEN auth_rate_limits.window_start+duration<=clock_timestamp() THEN clock_timestamp() ELSE auth_rate_limits.window_start END
 RETURNING * INTO r;
 IF r.hits<=maximum THEN RETURN 0; END IF;
 RETURN greatest(1,ceil(extract(epoch FROM r.window_start+duration-clock_timestamp()))::integer);
END;
$$;
REVOKE ALL ON FUNCTION sequence_private.auth_rate_limit(text,text) FROM PUBLIC,anon,authenticated,service_role,sequence_worker;
GRANT EXECUTE ON FUNCTION sequence_private.auth_rate_limit(text,text) TO sequence_auth_runtime;
CREATE FUNCTION sequence_private.auth_record_event(reason_code text, correlation_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF reason_code NOT IN ('login_denied','session_denied','provider_unavailable') THEN
 RAISE EXCEPTION 'Invalid reason' USING ERRCODE='22023'; END IF;
 INSERT INTO sequence_private.auth_audit(reason,request_id) VALUES(reason_code,correlation_id);
END;
$$;
REVOKE ALL ON FUNCTION sequence_private.auth_record_event(text,uuid) FROM PUBLIC,anon,authenticated,service_role,sequence_worker;
GRANT EXECUTE ON FUNCTION sequence_private.auth_record_event(text,uuid) TO sequence_auth_runtime;
CREATE FUNCTION sequence_private.auth_maintenance() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 DELETE FROM sequence_private.auth_rate_limits WHERE window_start<now()-interval '10 minutes';
 DELETE FROM sequence_private.login_transactions WHERE expires_at<=now();
 DELETE FROM sequence_private.auth_sessions WHERE expires_at<=now();
 DELETE FROM sequence_private.auth_audit WHERE user_id IS NULL AND created_at<now()-interval '30 days';
END;
$$;
REVOKE ALL ON FUNCTION sequence_private.auth_maintenance() FROM PUBLIC,anon,authenticated,service_role,sequence_worker;
GRANT EXECUTE ON FUNCTION sequence_private.auth_maintenance() TO sequence_auth_runtime;
-- Only the trusted database operator can execute this. Runtime and client roles cannot grant access.
CREATE FUNCTION sequence_private.operator_admission(target uuid, approved boolean, correlation_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE workspace uuid;
BEGIN
 IF target IS NULL OR approved IS NULL OR correlation_id IS NULL THEN
 RAISE EXCEPTION 'Missing operator input' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(target::text,734004));
 IF NOT EXISTS(SELECT 1 FROM auth.users u JOIN auth.identities i ON i.user_id=u.id
 WHERE u.id=target AND i.provider='google' AND u.email_confirmed_at IS NOT NULL) THEN
 RAISE EXCEPTION 'Verified Google identity required' USING ERRCODE='28000'; END IF;
 INSERT INTO sequence_private.access_allowlist(user_id,active) VALUES(target,approved)
 ON CONFLICT(user_id) DO UPDATE SET active=excluded.active;
 IF approved THEN
  INSERT INTO public.seq_workspaces(owner_id,synthetic) VALUES(target,false)
  ON CONFLICT(owner_id) DO NOTHING;
 END IF;
 SELECT id INTO workspace FROM public.seq_workspaces WHERE owner_id=target;
 INSERT INTO sequence_private.auth_audit(user_id,reason,request_id)
 VALUES(target,CASE WHEN approved THEN 'approved' ELSE 'revoked' END,correlation_id);
 RETURN workspace;
END;
$$;
REVOKE ALL ON FUNCTION sequence_private.operator_admission(uuid,boolean,uuid) FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_auth_runtime;
