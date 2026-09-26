-- RC-WP2 lifecycle schema (spec rev 2, section 1).

-- 1. One agent instance per API token. Nullable at the schema level because human/service tokens have
--    no instance; the trigger below makes it mandatory (and same-actor) for agent actors.
ALTER TABLE api_tokens ADD COLUMN instance_id uuid;
ALTER TABLE api_tokens
  ADD CONSTRAINT api_tokens_instance_fk FOREIGN KEY (workspace_id, instance_id)
  REFERENCES agent_instances (workspace_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX api_tokens_instance_uniq
  ON api_tokens (workspace_id, instance_id) WHERE instance_id IS NOT NULL;

CREATE FUNCTION chorus_api_token_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_kind  text;
  v_owner uuid;
BEGIN
  SELECT a.kind INTO v_kind FROM public.actors a
   WHERE a.workspace_id = NEW.workspace_id AND a.id = NEW.actor_id;
  IF v_kind = 'agent' AND NEW.instance_id IS NULL THEN
    RAISE EXCEPTION 'an agent actor''s API token requires an agent instance'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.instance_id IS NOT NULL THEN
    SELECT i.actor_id INTO v_owner FROM public.agent_instances i
     WHERE i.workspace_id = NEW.workspace_id AND i.id = NEW.instance_id;
    IF v_owner IS DISTINCT FROM NEW.actor_id THEN
      RAISE EXCEPTION 'an API token''s instance must belong to the same actor'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER api_tokens_guard
  BEFORE INSERT OR UPDATE OF actor_id, instance_id ON api_tokens
  FOR EACH ROW EXECUTE FUNCTION chorus_api_token_guard();

-- 2. shareable is set only at create_task; it gates WP4 evidence-link issuance.
ALTER TABLE task_details ADD COLUMN shareable boolean NOT NULL DEFAULT false;

-- 3. Result revisions gain the criteria mapping and the UTF-8 byte length. Adding columns does not fire
--    the row-level immutability triggers (tested). The byte_length CHECK below fails for any existing
--    revision with non-empty content (the column defaults to 0), so this migration REQUIRES an empty
--    task_result_revisions table or a backfill of byte_length first; none exists before first deploy.
ALTER TABLE task_result_revisions
  ADD COLUMN criteria_mapping jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(criteria_mapping) = 'array'),
  ADD COLUMN byte_length integer NOT NULL DEFAULT 0 CHECK (byte_length >= 0);
ALTER TABLE task_result_revisions
  ADD CONSTRAINT task_result_revisions_byte_length_matches
  CHECK (byte_length = octet_length(convert_to(content, 'UTF8')));

-- 4. Verdict notes.
ALTER TABLE review_details
  ADD COLUMN verdict_notes text CHECK (verdict_notes IS NULL OR char_length(verdict_notes) <= 4000);

-- 5. At most one review per (task, revision); replaces the non-unique subject index.
DROP INDEX review_details_subject_idx;
CREATE UNIQUE INDEX review_details_one_per_revision
  ON review_details (workspace_id, subject_task_id, result_revision);

-- 6. Every aggregate version appears in the journal exactly once, so history is totally ordered.
DROP INDEX domain_events_aggregate_idx;
CREATE UNIQUE INDEX domain_events_aggregate_version_uniq
  ON domain_events (workspace_id, aggregate_id, aggregate_version);

-- 7-8. Read paths.
CREATE INDEX work_items_list_idx ON work_items (workspace_id, kind, id DESC);
CREATE INDEX review_items_owner_idx ON work_items (workspace_id, owner_actor_id, state)
  WHERE kind = 'review';

-- 9. Token resolution now also returns the actor kind and the token's instance. The return type
--    changes, which CREATE OR REPLACE cannot do, so drop and recreate with the WP1 hardening:
--    SECURITY DEFINER, search_path pg_catalog, public, pg_temp, schema-qualified relations, EXECUTE
--    revoked from PUBLIC and granted to chorus_app only.
DROP FUNCTION chorus_resolve_token(text);
CREATE FUNCTION chorus_resolve_token(p_token_sha256 text)
  RETURNS TABLE (actor_id uuid, workspace_id uuid, actor_kind text, instance_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT t.actor_id, t.workspace_id, a.kind, t.instance_id
    FROM public.api_tokens t
    JOIN public.actors a ON a.workspace_id = t.workspace_id AND a.id = t.actor_id
   WHERE t.token_sha256 = p_token_sha256
     AND t.revoked_at IS NULL
     AND (t.expires_at IS NULL OR t.expires_at > now())
$$;
REVOKE ALL ON FUNCTION chorus_resolve_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chorus_resolve_token(text) TO chorus_app;

-- Redeeming an invite now also creates the agent instance (label = display name) and binds the new
-- token to it. Same signature and return type as before.
CREATE OR REPLACE FUNCTION chorus_redeem_invite(p_code_sha256 text, p_token_sha256 text, p_display_name text)
  RETURNS TABLE (workspace_id uuid, actor_id uuid, room_id uuid, role text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_invite   public.invites%ROWTYPE;
  v_actor    uuid;
  v_instance uuid;
BEGIN
  SELECT * INTO v_invite FROM public.invites i WHERE i.code_sha256 = p_code_sha256 FOR UPDATE;
  IF NOT FOUND OR v_invite.used_at IS NOT NULL OR v_invite.expires_at <= now() THEN
    RETURN;
  END IF;

  INSERT INTO public.actors (workspace_id, kind, display_name)
  VALUES (v_invite.workspace_id, 'agent', p_display_name)
  RETURNING id INTO v_actor;

  INSERT INTO public.agent_instances (workspace_id, actor_id, label)
  VALUES (v_invite.workspace_id, v_actor, p_display_name)
  RETURNING id INTO v_instance;

  UPDATE public.invites SET used_at = now(), used_by_actor_id = v_actor WHERE id = v_invite.id;

  INSERT INTO public.room_grants (workspace_id, actor_id, room_id, role)
  VALUES (v_invite.workspace_id, v_actor, v_invite.room_id, v_invite.role);

  INSERT INTO public.api_tokens (workspace_id, actor_id, token_sha256, instance_id)
  VALUES (v_invite.workspace_id, v_actor, p_token_sha256, v_instance);

  RETURN QUERY SELECT v_invite.workspace_id, v_actor, v_invite.room_id, v_invite.role;
END;
$$;
REVOKE ALL ON FUNCTION chorus_redeem_invite(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chorus_redeem_invite(text, text, text) TO chorus_app;

-- 10. An actor sees only its own instances.
DROP POLICY tenant ON agent_instances;
CREATE POLICY tenant ON agent_instances
  USING (workspace_id = chorus_ws() AND actor_id = chorus_actor())
  WITH CHECK (workspace_id = chorus_ws() AND actor_id = chorus_actor());
