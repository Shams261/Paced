-- S3-004: durable server-only sessions. No runtime password is embedded here.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sequence_auth_runtime') THEN
  CREATE ROLE sequence_auth_runtime NOLOGIN NOINHERIT NOBYPASSRLS;
 END IF;
END $$;
GRANT sequence_auth_runtime TO postgres;
GRANT USAGE ON SCHEMA sequence_private TO sequence_auth_runtime;
CREATE TABLE sequence_private.auth_sessions (
 session_hash text PRIMARY KEY CHECK(session_hash ~ '^[A-Za-z0-9_-]{43}$'),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 provider_session_id uuid NOT NULL UNIQUE,
 sealed_tokens jsonb NOT NULL CHECK(jsonb_typeof(sealed_tokens)='object'),
 token_expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 revoked_at timestamptz,
 revision bigint NOT NULL DEFAULT 1,
 refresh_owner uuid,
 refresh_until timestamptz,
 CHECK(expires_at <= created_at + interval '24 hours'),
 CHECK((refresh_owner IS NULL) = (refresh_until IS NULL))
);
CREATE INDEX auth_sessions_user ON sequence_private.auth_sessions(user_id);
CREATE TABLE sequence_private.login_transactions (
 transaction_hash text PRIMARY KEY CHECK(transaction_hash ~ '^[A-Za-z0-9_-]{43}$'),
 sealed_verifier jsonb NOT NULL CHECK(jsonb_typeof(sealed_verifier)='object'),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
ALTER TABLE sequence_private.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_private.login_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sequence_private.auth_sessions, sequence_private.login_transactions FROM PUBLIC, anon, authenticated, service_role, sequence_worker, sequence_auth_runtime;

CREATE FUNCTION sequence_private.live_product_session(subject uuid, sid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS (
 SELECT 1 FROM sequence_private.auth_sessions s JOIN auth.sessions p
 ON p.id=s.provider_session_id AND p.user_id=s.user_id
 WHERE s.user_id=subject AND p.id::text=sid AND s.revoked_at IS NULL
 AND s.expires_at > now() AND s.last_seen_at > now()-interval '30 minutes'
 AND (p.not_after IS NULL OR p.not_after>now())
 AND (s.refresh_owner IS NULL OR s.refresh_until>now()));
$$;
REVOKE ALL ON FUNCTION sequence_private.live_product_session(uuid,text) FROM PUBLIC,anon,authenticated,service_role,sequence_worker;
CREATE OR REPLACE FUNCTION sequence_private.owns_workspace(w uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.seq_workspaces s JOIN sequence_private.access_allowlist a
 ON a.user_id=s.owner_id WHERE s.id=w AND s.owner_id=(SELECT auth.uid()) AND a.active)
 AND sequence_private.live_product_session((SELECT auth.uid()),(SELECT auth.jwt()->>'session_id'));
$$;

-- Narrow runtime API: no arbitrary SQL, workspace selection, operator admission or table grants.
CREATE FUNCTION sequence_private.auth_session_operation(operation text, args jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s sequence_private.auth_sessions%ROWTYPE; t sequence_private.login_transactions%ROWTYPE;
 h text := args->>'hash'; sid uuid; u uuid; admitted boolean; workspace uuid;
BEGIN
 IF h IS NULL OR h !~ '^[A-Za-z0-9_-]{43}$' THEN RAISE EXCEPTION 'Invalid session identifier' USING ERRCODE='22023'; END IF;
 IF operation='login_create' THEN
  INSERT INTO sequence_private.login_transactions(transaction_hash,sealed_verifier) VALUES(h,args->'sealed');
  RETURN jsonb_build_object('ok',true);
 ELSIF operation='login_consume' THEN
  DELETE FROM sequence_private.login_transactions WHERE transaction_hash=h RETURNING * INTO t;
  IF NOT FOUND OR t.expires_at<=now() THEN RETURN NULL; END IF;
  RETURN t.sealed_verifier;
 ELSIF operation='create' THEN
  u:=(args->>'userId')::uuid; sid:=(args->>'providerSessionId')::uuid;
  -- Serialize against allowlist revocation for this user; admission itself stays separate.
  PERFORM pg_advisory_xact_lock(hashtextextended(u::text,734004));
  IF NOT EXISTS(SELECT 1 FROM auth.sessions p WHERE p.id=sid AND p.user_id=u
    AND (p.not_after IS NULL OR p.not_after>now())) THEN
   RAISE EXCEPTION 'Invalid provider session' USING ERRCODE='28000';
  END IF;
  INSERT INTO sequence_private.auth_sessions(session_hash,user_id,provider_session_id,sealed_tokens,token_expires_at)
  VALUES(h,u,sid,args->'sealed',to_timestamp((args->>'tokenExpiresAt')::double precision));
  RETURN jsonb_build_object('ok',true);
 END IF;
 SELECT * INTO s FROM sequence_private.auth_sessions WHERE session_hash=h FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF operation='revoke' THEN
  UPDATE sequence_private.auth_sessions SET revoked_at=coalesce(revoked_at,now()),
    sealed_tokens='{}',refresh_owner=NULL,refresh_until=NULL WHERE session_hash=h;
  RETURN jsonb_build_object('ok',true);
 END IF;
 IF s.revoked_at IS NOT NULL OR s.expires_at<=now() OR s.last_seen_at<=now()-interval '30 minutes'
  OR NOT EXISTS(SELECT 1 FROM auth.sessions p WHERE p.id=s.provider_session_id AND p.user_id=s.user_id
    AND (p.not_after IS NULL OR p.not_after>now()))
  OR (s.refresh_until IS NOT NULL AND s.refresh_until<=now()) THEN
  UPDATE sequence_private.auth_sessions SET revoked_at=coalesce(revoked_at,now()),sealed_tokens='{}',
   refresh_owner=NULL,refresh_until=NULL WHERE session_hash=h;
  RETURN NULL;
 END IF;
 IF operation IN ('refresh_claim','refresh_complete') AND
 ((args->>'revision') IS NULL OR (args->>'revision')::bigint<1 OR (args->>'owner') IS NULL) THEN
 RAISE EXCEPTION 'Missing refresh ownership' USING ERRCODE='22023'; END IF;
 IF operation='refresh_claim' THEN
  IF s.refresh_owner IS NOT NULL OR s.revision<>(args->>'revision')::bigint THEN RETURN NULL; END IF;
  UPDATE sequence_private.auth_sessions SET refresh_owner=(args->>'owner')::uuid,
   refresh_until=now()+interval '30 seconds' WHERE session_hash=h;
  RETURN jsonb_build_object('ok',true);
 ELSIF operation='refresh_complete' THEN
  IF s.refresh_owner IS DISTINCT FROM (args->>'owner')::uuid OR s.refresh_owner IS NULL
    OR s.revision<>(args->>'revision')::bigint THEN RETURN NULL; END IF;
  IF s.user_id IS DISTINCT FROM (args->>'userId')::uuid OR
     s.provider_session_id IS DISTINCT FROM (args->>'providerSessionId')::uuid THEN
   RAISE EXCEPTION 'Refresh identity mismatch' USING ERRCODE='28000';
  END IF;
  UPDATE sequence_private.auth_sessions SET sealed_tokens=args->'sealed',
   token_expires_at=to_timestamp((args->>'tokenExpiresAt')::double precision),revision=revision+1,
   refresh_owner=NULL,refresh_until=NULL WHERE session_hash=h;
  RETURN jsonb_build_object('ok',true);
 ELSIF operation<>'read' THEN RAISE EXCEPTION 'Invalid operation' USING ERRCODE='22023';
 END IF;
 SELECT a.active INTO admitted FROM sequence_private.access_allowlist a WHERE a.user_id=s.user_id;
 IF coalesce(admitted,false) THEN
  SELECT w.id INTO workspace FROM public.seq_workspaces w WHERE w.owner_id=s.user_id;
 END IF;
 UPDATE sequence_private.auth_sessions SET last_seen_at=now() WHERE session_hash=h;
 RETURN jsonb_build_object('hash',h,'userId',s.user_id,'providerSessionId',s.provider_session_id,
 'sealed',s.sealed_tokens,'tokenExpiresAt',extract(epoch FROM s.token_expires_at),
 'revision',s.revision,'refreshing',s.refresh_owner IS NOT NULL,'workspaceId',workspace,
 'absoluteExpiresAt',extract(epoch FROM s.expires_at));
END;
$$;
REVOKE ALL ON FUNCTION sequence_private.auth_session_operation(text,jsonb) FROM PUBLIC,anon,authenticated,service_role,sequence_worker;
GRANT EXECUTE ON FUNCTION sequence_private.auth_session_operation(text,jsonb) TO sequence_auth_runtime;

-- Any operator path which disables admission must invalidate sessions permanently.
CREATE FUNCTION sequence_private.revoke_admission_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id::text,734004));
 IF TG_OP='DELETE' OR NOT NEW.active THEN
  UPDATE sequence_private.auth_sessions SET revoked_at=coalesce(revoked_at,now()),sealed_tokens='{}',
    refresh_owner=NULL,refresh_until=NULL WHERE user_id=OLD.user_id;
 END IF;
 RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION sequence_private.revoke_admission_sessions() FROM PUBLIC,anon,authenticated,service_role,sequence_worker,sequence_auth_runtime;
CREATE TRIGGER revoke_product_sessions AFTER UPDATE OF active OR DELETE ON sequence_private.access_allowlist
FOR EACH ROW EXECUTE FUNCTION sequence_private.revoke_admission_sessions();
