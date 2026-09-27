-- S1-3 (rev 3 section 6.1 / rev 4 section 6): self-serve room activation.
--
-- Activation creates a NEW workspace for the SharedNet room, the bound room, the service seat (encrypted
-- member token) and the watcher cursor, in one transaction, and creates NO session. chorus_app has no
-- privileges on any of those tables, so these two SECURITY DEFINER functions are its only way in.
-- Standard hardening: search_path pg_catalog, public, pg_temp; every relation schema-qualified; EXECUTE
-- revoked from PUBLIC and granted to chorus_app.

-- Where a SharedNet room stands, so the HTTP layer can answer "already active" WITHOUT using the invite again.
CREATE FUNCTION chorus_room_lookup(p_external_room_id text)
  RETURNS TABLE (room_id uuid, activation_state text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.id, r.activation_state
    FROM public.rooms r
   WHERE r.provider = 'sharednet' AND r.external_room_id = p_external_room_id
$$;

-- Serialized per SharedNet room. If the room is already bound, nothing is written and `created` is false
-- (the caller drops the seat token it was about to store). A bound room that is not active (degraded or
-- suspended) is refused: only the operator path reactivates.
CREATE FUNCTION chorus_activate_room(
  p_external_room_id text, p_member_id text, p_principal_id text,
  p_token_ciphertext bytea, p_token_nonce bytea, p_key_id text, p_last_sequence bigint)
  RETURNS TABLE (room_id uuid, created boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_room_id uuid;
  v_state text;
  v_workspace_id uuid;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('chorus:activate-room:' || p_external_room_id, 0));

  SELECT r.id, r.activation_state INTO v_room_id, v_state
    FROM public.rooms r
   WHERE r.provider = 'sharednet' AND r.external_room_id = p_external_room_id;
  IF FOUND THEN
    IF v_state <> 'active' THEN
      RAISE EXCEPTION 'room is bound but not active' USING ERRCODE = 'CH001';
    END IF;
    RETURN QUERY SELECT v_room_id, false;
    RETURN;
  END IF;

  INSERT INTO public.workspaces (name) VALUES ('sharednet:' || p_external_room_id)
    RETURNING id INTO v_workspace_id;
  INSERT INTO public.rooms (workspace_id, name, provider, external_room_id, activation_state)
    VALUES (v_workspace_id, 'sharednet:' || p_external_room_id, 'sharednet', p_external_room_id, 'active')
    RETURNING id INTO v_room_id;
  INSERT INTO public.sharednet_seats
    (workspace_id, room_id, member_id, principal_id, token_ciphertext, token_nonce, key_id)
    VALUES (v_workspace_id, v_room_id, p_member_id, p_principal_id,
            p_token_ciphertext, p_token_nonce, p_key_id);
  -- The join just proved the seat works, so the watcher starts out healthy (enrollment needs a recent ok).
  INSERT INTO public.sharednet_cursors (workspace_id, room_id, last_sequence, last_ok_at)
    VALUES (v_workspace_id, v_room_id, greatest(p_last_sequence, 0), now());
  RETURN QUERY SELECT v_room_id, true;
END;
$$;

REVOKE ALL ON FUNCTION chorus_room_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_activate_room(text, text, text, bytea, bytea, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chorus_room_lookup(text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_activate_room(text, text, text, bytea, bytea, text, bigint) TO chorus_app;
