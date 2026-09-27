-- CC-2b: resolve historical SharedNet member IDs for actors named in an authorized receipt.
-- The runtime role cannot read other actors' agent_instances under RLS. This helper returns only the
-- requested actors' IDs, and only when the caller is a live member of the requested session.
-- Standard definer hardening: fixed search_path, schema-qualified relations, and least-privilege EXECUTE.
CREATE FUNCTION chorus_session_member_ids(p_session_id uuid, p_actor_ids uuid[])
  RETURNS TABLE (actor_id uuid, member_id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF p_session_id IS NULL OR p_actor_ids IS NULL OR cardinality(p_actor_ids) > 10 THEN
    RAISE EXCEPTION 'session and actor IDs are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_session_id NOT IN (SELECT public.chorus_my_sessions())
     OR NOT EXISTS (
       SELECT 1 FROM public.sessions s
        WHERE s.workspace_id = public.chorus_ws() AND s.id = p_session_id
     ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH requested AS (
    SELECT DISTINCT ids.actor_id
      FROM unnest(p_actor_ids) AS ids(actor_id)
     WHERE ids.actor_id IS NOT NULL
  )
  SELECT requested.actor_id,
         CASE WHEN count(DISTINCT ai.sharednet_member_id) = 1
              THEN min(ai.sharednet_member_id)
              ELSE NULL
          END AS member_id
    FROM requested
    JOIN public.session_members sm
      ON sm.workspace_id = public.chorus_ws()
     AND sm.session_id = p_session_id
     AND sm.actor_id = requested.actor_id
    LEFT JOIN public.agent_instances ai
      ON ai.workspace_id = sm.workspace_id
     AND ai.actor_id = sm.actor_id
     AND ai.sharednet_member_id IS NOT NULL
   GROUP BY requested.actor_id;
END;
$$;

REVOKE ALL ON FUNCTION chorus_session_member_ids(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chorus_session_member_ids(uuid, uuid[]) TO chorus_app;
