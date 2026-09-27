-- CC-2d (spec §10): the room watcher follows every new room message into the sessions whose coordination
-- mode is `observe` or `assist`.
--
-- Why one definer: the watcher runs as chorus_app with NO actor. It must find the following sessions of a
-- room (a session may be non-discoverable, so the `sessions` policy hides it) and then write that session's
-- coordination tables, whose policy is `session_id IN chorus_my_sessions()`. Sessions have no service actor,
-- so there is no member the watcher can already act as. This function answers exactly one question — "which
-- sessions of this active room follow it, and which live administrator's RLS context may the watcher use for
-- each?" — and writes nothing. Every write then runs as chorus_app under the unchanged session RLS (lock,
-- apply, persist: the same path as a scan), so a context that stops being valid (member removed, room left)
-- is refused by the policies themselves. Follow writes record no actor (transitions.actor_id is NULL), so the
-- borrowed context is never attributed to that person.
--
-- Standard hardening: search_path pg_catalog, public, pg_temp; every relation schema-qualified; arguments
-- validated; EXECUTE revoked from PUBLIC and granted to chorus_app only.
CREATE FUNCTION chorus_coordination_apply(p_workspace_id uuid, p_room_id uuid)
  RETURNS TABLE (session_id uuid, coordination_mode text, acting_actor_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF p_workspace_id IS NULL OR p_room_id IS NULL THEN
    RAISE EXCEPTION 'workspace and room are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT s.id, s.coordination_mode, a.actor_id
    FROM public.rooms r
    JOIN public.sessions s ON s.workspace_id = r.workspace_id AND s.room_id = r.id
    CROSS JOIN LATERAL (
      -- A live administrator who is also a live member of the room: exactly chorus_my_sessions()'s test.
      SELECT m.actor_id
        FROM public.session_members m
        JOIN public.room_members rm
          ON rm.workspace_id = m.workspace_id AND rm.room_id = r.id AND rm.actor_id = m.actor_id
       WHERE m.workspace_id = s.workspace_id AND m.session_id = s.id
         AND m.removed_at IS NULL AND rm.removed_at IS NULL AND 'administrator' = ANY (m.roles)
       ORDER BY m.joined_at, m.actor_id
       LIMIT 1) a
   WHERE r.workspace_id = p_workspace_id AND r.id = p_room_id
     AND r.provider = 'sharednet' AND r.activation_state = 'active'
     AND s.state = 'active' AND s.coordination_mode IN ('observe', 'assist')
   ORDER BY s.id;
END;
$$;

REVOKE ALL ON FUNCTION chorus_coordination_apply(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chorus_coordination_apply(uuid, uuid) TO chorus_app;
