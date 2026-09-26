-- Tenant and room isolation in the database (design §10.3, standards §3.6).
--
-- The application connects as `chorus_app`: not a superuser, no BYPASSRLS, and owner of nothing. Every
-- tenant table has RLS enabled AND forced. The command layer sets two transaction-local settings,
-- chorus.workspace_id and chorus.actor_id; when they are unset every policy evaluates to NULL and the
-- role sees nothing (fail closed). RLS is defense in depth under the command layer's own checks.
--
-- Requirement on the migration/owner role: it must be a superuser or hold BYPASSRLS. FORCE applies the
-- policies to table owners too, and the SECURITY DEFINER functions below run as that owner across tenants.
-- The login password of chorus_app is never stored in the repository; see README (CHORUS_APP_PASSWORD).

DO $$
BEGIN
  CREATE ROLE chorus_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN NULL;
END;
$$;
-- If the role pre-existed, make sure it has exactly the attributes this design relies on. The
-- condition avoids a needless ALTER, which would collide with concurrent migrations on one cluster.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'chorus_app'
       AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR NOT rolcanlogin)
  ) THEN
    ALTER ROLE chorus_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Context helpers. NULLIF turns the empty string left behind after a transaction ends into NULL.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION chorus_ws() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('chorus.workspace_id', true), '')::uuid
$$;

CREATE FUNCTION chorus_actor() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('chorus.actor_id', true), '')::uuid
$$;

-- Rooms in which the current actor holds a live grant. SECURITY DEFINER so that policies on
-- room_grants itself can use it without recursing into their own policy.
CREATE FUNCTION chorus_visible_rooms() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT room_id FROM room_grants
   WHERE workspace_id = chorus_ws() AND actor_id = chorus_actor() AND revoked_at IS NULL
$$;

-- ---------------------------------------------------------------------------------------------------
-- Least privilege for the runtime role. Nothing here allows UPDATE/DELETE on task_result_revisions,
-- DELETE on domain_events or commands, or any access to api_tokens and invites (those go through the
-- SECURITY DEFINER functions below or the operator CLI).
-- ---------------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO chorus_app;

GRANT SELECT ON workspaces, actors, rooms, room_grants TO chorus_app;
GRANT SELECT, INSERT ON agent_instances, projects, task_details, task_result_revisions, domain_events
  TO chorus_app;
GRANT SELECT, INSERT, UPDATE ON work_items, task_leases, review_details, commands TO chorus_app;

-- ---------------------------------------------------------------------------------------------------
-- Enable and force RLS on every tenant table.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE workspaces              ENABLE ROW LEVEL SECURITY;
ALTER TABLE actors                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_instances         ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_grants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens              ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects                ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_details            ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_leases             ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_result_revisions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_details          ENABLE ROW LEVEL SECURITY;
ALTER TABLE commands                ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events           ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspaces              FORCE ROW LEVEL SECURITY;
ALTER TABLE actors                  FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_instances         FORCE ROW LEVEL SECURITY;
ALTER TABLE rooms                   FORCE ROW LEVEL SECURITY;
ALTER TABLE room_grants             FORCE ROW LEVEL SECURITY;
ALTER TABLE api_tokens              FORCE ROW LEVEL SECURITY;
ALTER TABLE invites                 FORCE ROW LEVEL SECURITY;
ALTER TABLE projects                FORCE ROW LEVEL SECURITY;
ALTER TABLE work_items              FORCE ROW LEVEL SECURITY;
ALTER TABLE task_details            FORCE ROW LEVEL SECURITY;
ALTER TABLE task_leases             FORCE ROW LEVEL SECURITY;
ALTER TABLE task_result_revisions   FORCE ROW LEVEL SECURITY;
ALTER TABLE review_details          FORCE ROW LEVEL SECURITY;
ALTER TABLE commands                FORCE ROW LEVEL SECURITY;
ALTER TABLE domain_events           FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------------
-- Policies. FOR ALL with the same expression for USING and WITH CHECK: a row must be visible to be
-- read or updated, and a written row must stay inside the actor's workspace and rooms.
-- ---------------------------------------------------------------------------------------------------

-- Workspace-scoped only.
CREATE POLICY tenant ON workspaces
  USING (id = chorus_ws()) WITH CHECK (id = chorus_ws());

-- An actor sees itself and the actors it shares a room with (room_grants is already room-scoped).
CREATE POLICY tenant ON actors
  USING (workspace_id = chorus_ws()
         AND (id = chorus_actor() OR id IN (SELECT g.actor_id FROM room_grants g)))
  WITH CHECK (workspace_id = chorus_ws());

CREATE POLICY tenant ON agent_instances
  USING (workspace_id = chorus_ws() AND actor_id IN (SELECT a.id FROM actors a))
  WITH CHECK (workspace_id = chorus_ws() AND actor_id = chorus_actor());

CREATE POLICY tenant ON api_tokens
  USING (workspace_id = chorus_ws() AND actor_id = chorus_actor())
  WITH CHECK (workspace_id = chorus_ws() AND actor_id = chorus_actor());

-- Idempotency records belong to the actor that issued the command.
CREATE POLICY tenant ON commands
  USING (workspace_id = chorus_ws() AND actor_id = chorus_actor())
  WITH CHECK (workspace_id = chorus_ws() AND actor_id = chorus_actor());

-- Room-scoped: the row's room must be one the actor holds a live grant in.
CREATE POLICY tenant ON rooms
  USING (workspace_id = chorus_ws() AND id IN (SELECT chorus_visible_rooms()))
  WITH CHECK (workspace_id = chorus_ws() AND id IN (SELECT chorus_visible_rooms()));

CREATE POLICY tenant ON room_grants
  USING (workspace_id = chorus_ws() AND room_id IN (SELECT chorus_visible_rooms()))
  WITH CHECK (workspace_id = chorus_ws() AND room_id IN (SELECT chorus_visible_rooms()));

CREATE POLICY tenant ON invites
  USING (workspace_id = chorus_ws() AND room_id IN (SELECT chorus_visible_rooms()))
  WITH CHECK (workspace_id = chorus_ws() AND room_id IN (SELECT chorus_visible_rooms()));

CREATE POLICY tenant ON projects
  USING (workspace_id = chorus_ws() AND room_id IN (SELECT chorus_visible_rooms()))
  WITH CHECK (workspace_id = chorus_ws() AND room_id IN (SELECT chorus_visible_rooms()));

CREATE POLICY tenant ON work_items
  USING (workspace_id = chorus_ws() AND home_room_id IN (SELECT chorus_visible_rooms()))
  WITH CHECK (workspace_id = chorus_ws() AND home_room_id IN (SELECT chorus_visible_rooms()));

CREATE POLICY tenant ON domain_events
  USING (workspace_id = chorus_ws() AND room_id IN (SELECT chorus_visible_rooms()))
  WITH CHECK (workspace_id = chorus_ws() AND room_id IN (SELECT chorus_visible_rooms()));

-- Children of a work item are visible exactly when their parent item is (work_items applies its own
-- policy inside these subqueries).
CREATE POLICY tenant ON task_details
  USING (workspace_id = chorus_ws()
         AND EXISTS (SELECT 1 FROM work_items w WHERE w.workspace_id = task_details.workspace_id AND w.id = task_details.item_id))
  WITH CHECK (workspace_id = chorus_ws()
         AND EXISTS (SELECT 1 FROM work_items w WHERE w.workspace_id = task_details.workspace_id AND w.id = task_details.item_id));

CREATE POLICY tenant ON task_leases
  USING (workspace_id = chorus_ws()
         AND EXISTS (SELECT 1 FROM work_items w WHERE w.workspace_id = task_leases.workspace_id AND w.id = task_leases.task_id))
  WITH CHECK (workspace_id = chorus_ws()
         AND EXISTS (SELECT 1 FROM work_items w WHERE w.workspace_id = task_leases.workspace_id AND w.id = task_leases.task_id));

CREATE POLICY tenant ON task_result_revisions
  USING (workspace_id = chorus_ws()
         AND EXISTS (SELECT 1 FROM work_items w WHERE w.workspace_id = task_result_revisions.workspace_id AND w.id = task_result_revisions.task_id))
  WITH CHECK (workspace_id = chorus_ws()
         AND EXISTS (SELECT 1 FROM work_items w WHERE w.workspace_id = task_result_revisions.workspace_id AND w.id = task_result_revisions.task_id));

CREATE POLICY tenant ON review_details
  USING (workspace_id = chorus_ws()
         AND EXISTS (SELECT 1 FROM work_items w WHERE w.workspace_id = review_details.workspace_id AND w.id = review_details.review_item_id))
  WITH CHECK (workspace_id = chorus_ws()
         AND EXISTS (SELECT 1 FROM work_items w WHERE w.workspace_id = review_details.workspace_id AND w.id = review_details.review_item_id));

-- ---------------------------------------------------------------------------------------------------
-- The only two operations that must cross tenants. Each is a narrow SECURITY DEFINER function with a
-- pinned search_path, returning the minimum needed; execution is limited to chorus_app.
-- ---------------------------------------------------------------------------------------------------

-- Token -> identity. Zero rows unless the token is live: unknown, revoked and expired all look alike.
CREATE FUNCTION chorus_resolve_token(p_token_sha256 text)
  RETURNS TABLE (actor_id uuid, workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.actor_id, t.workspace_id
    FROM api_tokens t
   WHERE t.token_sha256 = p_token_sha256
     AND t.revoked_at IS NULL
     AND (t.expires_at IS NULL OR t.expires_at > now())
$$;

-- Redeems a single-use invite: creates a NEW agent actor, its grant (role from the invite) and its API
-- token (only the hash, supplied by the caller), and marks the invite used, atomically. The invite row
-- is locked first, so concurrent redemptions of one code serialize and exactly one succeeds. Zero rows
-- when the code is unknown, used or expired; the caller cannot tell which.
CREATE FUNCTION chorus_redeem_invite(p_code_sha256 text, p_token_sha256 text, p_display_name text)
  RETURNS TABLE (workspace_id uuid, actor_id uuid, room_id uuid, role text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  v_invite invites%ROWTYPE;
  v_actor  uuid;
BEGIN
  SELECT * INTO v_invite FROM invites i WHERE i.code_sha256 = p_code_sha256 FOR UPDATE;
  IF NOT FOUND OR v_invite.used_at IS NOT NULL OR v_invite.expires_at <= now() THEN
    RETURN;
  END IF;

  INSERT INTO actors (workspace_id, kind, display_name)
  VALUES (v_invite.workspace_id, 'agent', p_display_name)
  RETURNING id INTO v_actor;

  UPDATE invites SET used_at = now(), used_by_actor_id = v_actor WHERE id = v_invite.id;

  INSERT INTO room_grants (workspace_id, actor_id, room_id, role)
  VALUES (v_invite.workspace_id, v_actor, v_invite.room_id, v_invite.role);

  INSERT INTO api_tokens (workspace_id, actor_id, token_sha256)
  VALUES (v_invite.workspace_id, v_actor, p_token_sha256);

  RETURN QUERY SELECT v_invite.workspace_id, v_actor, v_invite.room_id, v_invite.role;
END;
$$;

REVOKE ALL ON FUNCTION chorus_visible_rooms() FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_resolve_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_redeem_invite(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chorus_visible_rooms() TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_resolve_token(text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_redeem_invite(text, text, text) TO chorus_app;
