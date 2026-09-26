-- RC-WP3 (spec rev 2 + amendment rev 2.1): SharedNet room binding and automated in-room enrollment.
--
-- Chorus rooms are BINDINGS to existing SharedNet rooms; Chorus never creates a SharedNet room. Agents
-- prove control of their own SharedNet seat by posting a challenge in that room; the watcher observes
-- the server-assigned sender and the enrollment completes. No invites, no operator doorman.
--
-- Interim role model (partial hold, room seq 51): every verified member gets exactly `executor`.
-- room_policies / principal lists are NOT built yet; the enroll definer functions therefore accept only
-- p_roles = {executor}. That single restriction is what the role-model revision will replace.

-- ---------------------------------------------------------------------------------------------------
-- 1. Invites are gone (amendment G3).
-- ---------------------------------------------------------------------------------------------------
DROP FUNCTION chorus_redeem_invite(text, text, text);
DROP TABLE invites;

-- ---------------------------------------------------------------------------------------------------
-- 2. Room binding.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE rooms
  ADD COLUMN provider text NOT NULL DEFAULT 'internal' CHECK (provider IN ('internal', 'sharednet')),
  ADD COLUMN external_room_id text
    CHECK (external_room_id IS NULL OR external_room_id ~ '^rom_[A-Za-z0-9]{6,64}$'),
  ADD COLUMN activation_state text NOT NULL DEFAULT 'inactive'
    CHECK (activation_state IN ('inactive', 'active', 'degraded', 'suspended')),
  ADD CONSTRAINT rooms_external_ck CHECK ((provider = 'sharednet') = (external_room_id IS NOT NULL));
-- One SharedNet room binds to at most one Chorus room, in one workspace.
CREATE UNIQUE INDEX rooms_external_uniq ON rooms (provider, external_room_id)
  WHERE external_room_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------
-- 3. New tables. chorus_app has NO privileges on any of them; access is only through the SECURITY
--    DEFINER functions in section 4. RLS is enabled and forced with no policies (deny by default).
-- ---------------------------------------------------------------------------------------------------

-- Chorus's own service seat in an activated room. The token is AES-256-GCM encrypted by the app.
CREATE TABLE sharednet_seats (
  workspace_id     uuid        NOT NULL,
  room_id          uuid        NOT NULL,
  member_id        text        NOT NULL CHECK (member_id ~ '^i_[A-Za-z0-9]{6,64}$'),
  principal_id     text        NOT NULL CHECK (principal_id ~ '^p_[A-Za-z0-9]{6,64}$'),
  token_ciphertext bytea       NOT NULL,
  token_nonce      bytea       NOT NULL CHECK (octet_length(token_nonce) = 12),
  key_id           text        NOT NULL CHECK (key_id ~ '^[0-9a-f]{8}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, room_id),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id)
);

-- The watcher's monotonic read position per room.
CREATE TABLE sharednet_cursors (
  workspace_id  uuid        NOT NULL,
  room_id       uuid        NOT NULL,
  last_sequence bigint      NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  last_ok_at    timestamptz,
  PRIMARY KEY (workspace_id, room_id),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id)
);

-- One Chorus actor per (workspace, provider, SharedNet principal).
CREATE TABLE external_identities (
  workspace_id  uuid        NOT NULL,
  actor_id      uuid        NOT NULL,
  provider      text        NOT NULL CHECK (provider = 'sharednet'),
  principal_id  text        NOT NULL CHECK (principal_id ~ '^p_[A-Za-z0-9]{6,64}$'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider, principal_id),
  UNIQUE (workspace_id, actor_id, provider),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors (workspace_id, id)
);

CREATE TABLE enrollments (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid        NOT NULL,
  room_id             uuid        NOT NULL,
  claimed_member_id   text        NOT NULL CHECK (claimed_member_id ~ '^i_[A-Za-z0-9]{6,64}$'),
  display_name        text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  nonce               text        NOT NULL UNIQUE CHECK (nonce ~ '^cvn_[A-Za-z0-9_-]{22}$'),
  secret_sha256       text        NOT NULL CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
  state               text        NOT NULL CHECK (state IN ('pending', 'verified', 'consumed', 'expired')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  start_sequence      bigint      NOT NULL CHECK (start_sequence >= 0),
  verified_at         timestamptz,
  proof_message_id    text,
  proof_sequence      bigint,
  proof_principal_id  text        CHECK (proof_principal_id IS NULL OR proof_principal_id ~ '^p_[A-Za-z0-9]{6,64}$'),
  proof_member_id     text        CHECK (proof_member_id IS NULL OR proof_member_id ~ '^i_[A-Za-z0-9]{6,64}$'),
  consumed_at         timestamptz,
  issued_actor_id     uuid,
  issued_token_id     uuid,
  CHECK (expires_at = created_at + interval '10 minutes'),
  -- verified/consumed imply verified_at; an EXPIRED enrollment may keep the verified_at it earned (the
  -- spec's strict equality would make verified -> expired impossible; noted as a deviation in the PR).
  CHECK ((state IN ('verified', 'consumed')) = (verified_at IS NOT NULL) OR state = 'expired'),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id)
);
CREATE INDEX enrollments_room_state_idx ON enrollments (workspace_id, room_id, state);

-- Operator audit trail (owner-only; the admin CLI writes here). Never contains secrets.
CREATE TABLE admin_audit_log (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  operator     text        NOT NULL CHECK (length(operator) BETWEEN 1 AND 200),
  command      text        NOT NULL,
  workspace_id uuid,
  subject_id   uuid,
  details      jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE TRIGGER admin_audit_log_immutable
  BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER admin_audit_log_no_truncate
  BEFORE TRUNCATE ON admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();

ALTER TABLE sharednet_seats     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharednet_cursors   ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharednet_seats     FORCE ROW LEVEL SECURITY;
ALTER TABLE sharednet_cursors   FORCE ROW LEVEL SECURITY;
ALTER TABLE external_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE enrollments         FORCE ROW LEVEL SECURITY;
-- admin_audit_log is deliberately exempt from RLS (owner-only, no chorus_app privileges at all).

-- ---------------------------------------------------------------------------------------------------
-- 4. SECURITY DEFINER functions. Standard hardening on every one: search_path pg_catalog, public,
--    pg_temp; every relation schema-qualified; EXECUTE revoked from PUBLIC and granted to chorus_app.
--    Custom SQLSTATEs (class CH) carry domain outcomes to the application.
--      CH001 room_not_available   CH002 cursor_regression
-- ---------------------------------------------------------------------------------------------------

-- Start an enrollment for a bound, active room whose watcher is healthy. The start cursor makes sure
-- nothing posted before this moment can ever count as proof.
CREATE FUNCTION chorus_enroll_start(
  p_external_room_id text, p_claimed_member_id text, p_display_name text,
  p_nonce text, p_secret_sha256 text)
  RETURNS TABLE (enrollment_id uuid, expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_ws       uuid;
  v_room     uuid;
  v_seq      bigint;
  v_ok       timestamptz;
  v_id       uuid;
  v_expires  timestamptz;
BEGIN
  SELECT r.workspace_id, r.id, c.last_sequence, c.last_ok_at
    INTO v_ws, v_room, v_seq, v_ok
    FROM public.rooms r
    JOIN public.sharednet_cursors c ON c.workspace_id = r.workspace_id AND c.room_id = r.id
   WHERE r.provider = 'sharednet' AND r.external_room_id = p_external_room_id
     AND r.activation_state = 'active';
  IF NOT FOUND OR v_ok IS NULL OR v_ok <= now() - interval '2 minutes' THEN
    RAISE EXCEPTION 'room_not_available' USING ERRCODE = 'CH001';
  END IF;

  INSERT INTO public.enrollments
    (workspace_id, room_id, claimed_member_id, display_name, nonce, secret_sha256, state,
     created_at, expires_at, start_sequence)
  VALUES
    (v_ws, v_room, p_claimed_member_id, p_display_name, p_nonce, p_secret_sha256, 'pending',
     now(), now() + interval '10 minutes', v_seq)
  RETURNING id, public.enrollments.expires_at INTO v_id, v_expires;

  RETURN QUERY SELECT v_id, v_expires;
END;
$$;

-- Called by the watcher for a candidate nonce. Verifies only if everything matches; otherwise a no-op.
-- The UPDATE is atomic, so the first valid message wins and later duplicates change nothing.
CREATE FUNCTION chorus_enroll_verify(
  p_workspace_id uuid, p_room_id uuid, p_nonce text, p_message_id text, p_sequence bigint,
  p_sender_principal_id text, p_sender_member_id text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.enrollments e
     SET state = 'verified', verified_at = now(), proof_message_id = p_message_id,
         proof_sequence = p_sequence, proof_principal_id = p_sender_principal_id,
         proof_member_id = p_sender_member_id
   WHERE e.workspace_id = p_workspace_id AND e.room_id = p_room_id AND e.nonce = p_nonce
     AND e.state = 'pending' AND now() < e.expires_at
     AND p_sequence > e.start_sequence
     AND e.claimed_member_id = p_sender_member_id;
  RETURN FOUND;
END;
$$;

-- What the application needs to decide the roles before completing: the proven principal. Anything that
-- is not a live, correctly-keyed enrollment looks exactly the same ('invalid').
CREATE FUNCTION chorus_enroll_status(p_enrollment_id uuid, p_secret_sha256 text)
  RETURNS TABLE (status text, workspace_id uuid, room_id uuid, proof_principal_id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_e public.enrollments%ROWTYPE;
BEGIN
  SELECT * INTO v_e FROM public.enrollments e
   WHERE e.id = p_enrollment_id AND e.secret_sha256 = p_secret_sha256;
  IF NOT FOUND OR v_e.state IN ('consumed', 'expired') OR now() >= v_e.expires_at THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::text;
  ELSIF v_e.state = 'pending' THEN
    RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::uuid, NULL::text;
  ELSE
    RETURN QUERY SELECT 'verified'::text, v_e.workspace_id, v_e.room_id, v_e.proof_principal_id;
  END IF;
END;
$$;

-- Issue the credential exactly once. Row-locked, so concurrent completes yield one 'issued'.
-- p_roles is chosen by the application (rolesForEnrollment); until room policies exist the database
-- accepts only {executor}. Enrollment only ADDS missing live grants; it never revokes any.
CREATE FUNCTION chorus_enroll_complete(
  p_enrollment_id uuid, p_secret_sha256 text, p_token_sha256 text, p_roles text[])
  RETURNS TABLE (status text, actor_id uuid, workspace_id uuid, room_id uuid, instance_id uuid,
                 roles text[], token_expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_e        public.enrollments%ROWTYPE;
  v_actor    uuid;
  v_new      uuid;
  v_instance uuid;
  v_token    uuid;
  v_expires  timestamptz;
  v_role     text;
  v_roles    text[];
BEGIN
  IF p_roles IS NULL OR cardinality(p_roles) = 0 OR NOT (p_roles <@ ARRAY['executor']::text[]) THEN
    RAISE EXCEPTION 'unsupported role set for enrollment' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_e FROM public.enrollments e
   WHERE e.id = p_enrollment_id AND e.secret_sha256 = p_secret_sha256 FOR UPDATE;
  IF NOT FOUND OR v_e.state IN ('consumed', 'expired') OR now() >= v_e.expires_at THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
                        NULL::text[], NULL::timestamptz;
    RETURN;
  END IF;
  IF v_e.state = 'pending' THEN
    RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
                        NULL::text[], NULL::timestamptz;
    RETURN;
  END IF;
  -- Suspended or degraded rooms issue nothing.
  IF NOT EXISTS (
    SELECT 1 FROM public.rooms r
     WHERE r.workspace_id = v_e.workspace_id AND r.id = v_e.room_id AND r.activation_state = 'active') THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
                        NULL::text[], NULL::timestamptz;
    RETURN;
  END IF;

  -- One actor per principal: reuse it, or create it and record the identity. A concurrent enrollment
  -- by the same principal may win the identity insert; then ours is discarded and theirs reused.
  SELECT i.actor_id INTO v_actor FROM public.external_identities i
   WHERE i.workspace_id = v_e.workspace_id AND i.provider = 'sharednet'
     AND i.principal_id = v_e.proof_principal_id;
  IF NOT FOUND THEN
    v_new := uuidv7();
    INSERT INTO public.actors (id, workspace_id, kind, display_name)
    VALUES (v_new, v_e.workspace_id, 'agent', v_e.display_name);
    INSERT INTO public.external_identities (workspace_id, actor_id, provider, principal_id)
    VALUES (v_e.workspace_id, v_new, 'sharednet', v_e.proof_principal_id)
    ON CONFLICT DO NOTHING;
    IF FOUND THEN
      v_actor := v_new;
    ELSE
      DELETE FROM public.actors a WHERE a.workspace_id = v_e.workspace_id AND a.id = v_new;
      SELECT i.actor_id INTO v_actor FROM public.external_identities i
       WHERE i.workspace_id = v_e.workspace_id AND i.provider = 'sharednet'
         AND i.principal_id = v_e.proof_principal_id;
    END IF;
  END IF;

  FOREACH v_role IN ARRAY p_roles LOOP
    INSERT INTO public.room_grants (workspace_id, actor_id, room_id, role)
    VALUES (v_e.workspace_id, v_actor, v_e.room_id, v_role)
    ON CONFLICT (workspace_id, actor_id, room_id, role) WHERE revoked_at IS NULL DO NOTHING;
  END LOOP;

  INSERT INTO public.agent_instances (workspace_id, actor_id, label)
  VALUES (v_e.workspace_id, v_actor, 'sharednet:' || v_e.proof_member_id)
  RETURNING id INTO v_instance;

  v_expires := now() + interval '120 minutes';
  INSERT INTO public.api_tokens (workspace_id, actor_id, token_sha256, instance_id, expires_at)
  VALUES (v_e.workspace_id, v_actor, p_token_sha256, v_instance, v_expires)
  RETURNING id INTO v_token;

  UPDATE public.enrollments
     SET state = 'consumed', consumed_at = now(), issued_actor_id = v_actor, issued_token_id = v_token
   WHERE id = v_e.id;

  SELECT array_agg(g.role ORDER BY g.role) INTO v_roles FROM public.room_grants g
   WHERE g.workspace_id = v_e.workspace_id AND g.actor_id = v_actor AND g.room_id = v_e.room_id
     AND g.revoked_at IS NULL;

  RETURN QUERY SELECT 'issued'::text, v_actor, v_e.workspace_id, v_e.room_id, v_instance,
                      v_roles, v_expires;
END;
$$;

-- The watcher's work list: active bound rooms with their encrypted service-seat credential.
CREATE FUNCTION chorus_watcher_rooms()
  RETURNS TABLE (workspace_id uuid, room_id uuid, external_room_id text, member_id text,
                 token_ciphertext bytea, token_nonce bytea, key_id text, last_sequence bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.workspace_id, r.id, r.external_room_id, s.member_id, s.token_ciphertext, s.token_nonce,
         s.key_id, c.last_sequence
    FROM public.rooms r
    JOIN public.sharednet_seats s ON s.workspace_id = r.workspace_id AND s.room_id = r.id
    JOIN public.sharednet_cursors c ON c.workspace_id = r.workspace_id AND c.room_id = r.id
   WHERE r.provider = 'sharednet' AND r.activation_state = 'active'
$$;

-- Monotonic cursor advance; a regression is an error, never a silent rewind.
CREATE FUNCTION chorus_watcher_advance(
  p_workspace_id uuid, p_room_id uuid, p_new_last_sequence bigint, p_ok boolean, p_error text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_last bigint;
BEGIN
  SELECT c.last_sequence INTO v_last FROM public.sharednet_cursors c
   WHERE c.workspace_id = p_workspace_id AND c.room_id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no cursor for room' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_new_last_sequence < v_last THEN
    RAISE EXCEPTION 'cursor regression: % < %', p_new_last_sequence, v_last USING ERRCODE = 'CH002';
  END IF;
  UPDATE public.sharednet_cursors
     SET last_sequence = p_new_last_sequence, updated_at = now(),
         last_ok_at = CASE WHEN p_ok THEN now() ELSE last_ok_at END,
         last_error = CASE WHEN p_ok THEN NULL ELSE left(coalesce(p_error, 'error'), 500) END
   WHERE workspace_id = p_workspace_id AND room_id = p_room_id;
END;
$$;

-- The watcher can only take a room OUT of service (active -> degraded). Only the admin path reactivates.
CREATE FUNCTION chorus_watcher_degrade(p_workspace_id uuid, p_room_id uuid, p_reason text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.rooms r SET activation_state = 'degraded'
   WHERE r.workspace_id = p_workspace_id AND r.id = p_room_id AND r.activation_state = 'active';
  IF FOUND THEN
    UPDATE public.sharednet_cursors
       SET last_error = left(coalesce(p_reason, 'degraded'), 500), updated_at = now()
     WHERE workspace_id = p_workspace_id AND room_id = p_room_id;
  END IF;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION chorus_expire_enrollments() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.enrollments SET state = 'expired'
   WHERE state IN ('pending', 'verified') AND now() >= expires_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Health surface for /healthz: room binding, state and whether the watcher has been ok recently.
CREATE FUNCTION chorus_room_health()
  RETURNS TABLE (external_room_id text, activation_state text, watcher_ok boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.external_room_id, r.activation_state,
         COALESCE(c.last_ok_at > now() - interval '2 minutes', false)
    FROM public.rooms r
    LEFT JOIN public.sharednet_cursors c ON c.workspace_id = r.workspace_id AND c.room_id = r.id
   WHERE r.provider = 'sharednet'
$$;

-- Tokens now also require the actor to hold a live grant in an ACTIVE room: suspending or degrading a
-- room locks out every token whose access came through it (amendment G5, no exceptions). The result also
-- gains token_expires_at (for chorus_whoami), so the return type changes: drop and recreate.
DROP FUNCTION chorus_resolve_token(text);
CREATE FUNCTION chorus_resolve_token(p_token_sha256 text)
  RETURNS TABLE (actor_id uuid, workspace_id uuid, actor_kind text, instance_id uuid,
                 token_expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT t.actor_id, t.workspace_id, a.kind, t.instance_id, t.expires_at
    FROM public.api_tokens t
    JOIN public.actors a ON a.workspace_id = t.workspace_id AND a.id = t.actor_id
   WHERE t.token_sha256 = p_token_sha256
     AND t.revoked_at IS NULL
     AND (t.expires_at IS NULL OR t.expires_at > now())
     AND EXISTS (
       SELECT 1 FROM public.room_grants g
         JOIN public.rooms r ON r.workspace_id = g.workspace_id AND r.id = g.room_id
        WHERE g.workspace_id = t.workspace_id AND g.actor_id = t.actor_id
          AND g.revoked_at IS NULL AND r.activation_state = 'active')
$$;

REVOKE ALL ON FUNCTION chorus_enroll_start(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_enroll_verify(uuid, uuid, text, text, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_enroll_status(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_enroll_complete(uuid, text, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_watcher_rooms() FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_watcher_advance(uuid, uuid, bigint, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_watcher_degrade(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_expire_enrollments() FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_room_health() FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_resolve_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chorus_enroll_start(text, text, text, text, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_enroll_verify(uuid, uuid, text, text, bigint, text, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_enroll_status(uuid, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_enroll_complete(uuid, text, text, text[]) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_watcher_rooms() TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_watcher_advance(uuid, uuid, bigint, boolean, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_watcher_degrade(uuid, uuid, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_expire_enrollments() TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_room_health() TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_resolve_token(text) TO chorus_app;
