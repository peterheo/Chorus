-- CC-2 (conversation coordination engine): per-session inferred conversation state, maintained by the pure
-- engine (packages/domain/src/coordination) from scanned or followed room messages. Everything here is INFERRED;
-- it never changes canonical work (spec D1). No new definers: the runtime role writes under the same session RLS
-- as 0008.

-- ---------------------------------------------------------------------------------------------------
-- 1. Engine state: one row per session, holding the monotonic cursor (spec D7) and the next short-ref numbers.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE conversation_engine_state (
  workspace_id  uuid        NOT NULL,
  session_id    uuid        NOT NULL,
  cursor        bigint      NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  next_refs     jsonb       NOT NULL DEFAULT '{"Q":1,"C":1,"H":1,"D":1,"K":1,"X":1,"P":1}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions (workspace_id, id)
);

-- ---------------------------------------------------------------------------------------------------
-- 2. Objects: one row per inferred object (the columns of spec §2; member lists and provenance as jsonb).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE conversation_objects (
  workspace_id   uuid        NOT NULL,
  session_id     uuid        NOT NULL,
  ref            text        NOT NULL CHECK (ref ~ '^[QCHDKXP][1-9][0-9]{0,8}$'),
  kind           text        NOT NULL
    CHECK (kind IN ('question', 'commitment', 'handoff', 'decision', 'claim', 'conflict', 'dependency')),
  status         text        NOT NULL CHECK (char_length(status) BETWEEN 1 AND 40),
  body           jsonb       NOT NULL,          -- the full CoordObject as the engine returned it
  linked_item_id uuid,
  created_seq    bigint      NOT NULL CHECK (created_seq >= 1),
  touched_seq    bigint      NOT NULL CHECK (touched_seq >= created_seq),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_id, ref),
  CHECK (left(ref, 1) = CASE kind
    WHEN 'question' THEN 'Q' WHEN 'commitment' THEN 'C' WHEN 'handoff' THEN 'H' WHEN 'decision' THEN 'D'
    WHEN 'claim' THEN 'K' WHEN 'conflict' THEN 'X' ELSE 'P' END),
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions (workspace_id, id),
  -- Same-session links only (the composite key added in 0008).
  FOREIGN KEY (workspace_id, linked_item_id, session_id) REFERENCES work_items (workspace_id, id, session_id)
);
CREATE INDEX conversation_objects_status_idx
  ON conversation_objects (workspace_id, session_id, kind, status);

CREATE TRIGGER conversation_objects_no_delete BEFORE DELETE ON conversation_objects
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER conversation_objects_no_truncate BEFORE TRUNCATE ON conversation_objects
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();

-- ---------------------------------------------------------------------------------------------------
-- 3. Transitions: append-only log of every status change (engine or command).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE conversation_transitions (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid        NOT NULL,
  session_id    uuid        NOT NULL,
  ref           text        NOT NULL,
  from_status   text,
  to_status     text        NOT NULL,
  cause         text        NOT NULL CHECK (cause IN ('message', 'command')),
  message_id    text,
  reason        text        NOT NULL CHECK (char_length(reason) <= 500),
  actor_id      uuid,                           -- the caller, for cause = 'command' (and the scanner for 'message')
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, session_id, ref) REFERENCES conversation_objects (workspace_id, session_id, ref),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors (workspace_id, id)
);
CREATE INDEX conversation_transitions_ref_idx
  ON conversation_transitions (workspace_id, session_id, ref, created_at);

CREATE TRIGGER conversation_transitions_immutable BEFORE UPDATE OR DELETE ON conversation_transitions
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER conversation_transitions_no_truncate BEFORE TRUNCATE ON conversation_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();

-- ---------------------------------------------------------------------------------------------------
-- 4. CC-2d: per-session coordination mode, and the signals already posted in assist mode (at-most-once).
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE sessions ADD COLUMN coordination_mode text NOT NULL DEFAULT 'off'
  CHECK (coordination_mode IN ('off', 'observe', 'assist'));

CREATE TABLE conversation_posts (
  workspace_id  uuid        NOT NULL,
  session_id    uuid        NOT NULL,
  signal_key    text        NOT NULL CHECK (signal_key ~ '^[0-9a-f]{64}$'),
  message_id    text        NOT NULL,
  posted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_id, signal_key),
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions (workspace_id, id)
);
CREATE TRIGGER conversation_posts_immutable BEFORE UPDATE OR DELETE ON conversation_posts
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER conversation_posts_no_truncate BEFORE TRUNCATE ON conversation_posts
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();

-- ---------------------------------------------------------------------------------------------------
-- 5. CC-1 suggestions point at their CC-2 object (spec D9).
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE conversation_suggestions ADD COLUMN object_ref text
  CHECK (object_ref IS NULL OR object_ref ~ '^[QC][1-9][0-9]{0,8}$');
GRANT UPDATE (object_ref) ON conversation_suggestions TO chorus_app;

-- ---------------------------------------------------------------------------------------------------
-- 6. RLS: visible and writable only within the caller's own live sessions, exactly like 0008.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE conversation_engine_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_engine_state FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_transitions FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_posts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant ON conversation_engine_state
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON conversation_objects
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON conversation_transitions
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON conversation_posts
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));

GRANT SELECT, INSERT ON conversation_engine_state, conversation_objects, conversation_transitions,
  conversation_posts TO chorus_app;
GRANT UPDATE (cursor, next_refs, updated_at) ON conversation_engine_state TO chorus_app;
GRANT UPDATE (status, body, linked_item_id, touched_seq, updated_at) ON conversation_objects TO chorus_app;
-- The mode changes only through the existing hardened session-policy definer (administrator-only), like every
-- other session policy column: chorus_app still has no UPDATE on sessions. CREATE OR REPLACE keeps the
-- function's owner, EXECUTE grants and REVOKE from PUBLIC. The body is 0005's with one added column.
CREATE OR REPLACE FUNCTION chorus_session_set_policy(p_session_id uuid, p_changes jsonb) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_roles text[] := public.chorus_session_roles(p_session_id);
BEGIN
  IF v_roles IS NULL OR NOT ('administrator' = ANY (v_roles)) THEN
    RAISE EXCEPTION 'administrator role required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.sessions s WHERE s.workspace_id = public.chorus_ws() AND s.id = p_session_id FOR UPDATE;
  UPDATE public.sessions s SET
    name = CASE WHEN p_changes ? 'name' THEN p_changes ->> 'name' ELSE s.name END,
    discoverable = CASE WHEN p_changes ? 'discoverable'
      THEN (p_changes ->> 'discoverable')::boolean ELSE s.discoverable END,
    join_policy = CASE WHEN p_changes ? 'join_policy' THEN p_changes ->> 'join_policy' ELSE s.join_policy END,
    listed_principals = CASE WHEN p_changes ? 'listed_principals'
      THEN ARRAY(SELECT jsonb_array_elements_text(p_changes -> 'listed_principals')) ELSE s.listed_principals END,
    policy_agent_ids = CASE WHEN p_changes ? 'policy_agent_ids'
      THEN ARRAY(SELECT jsonb_array_elements_text(p_changes -> 'policy_agent_ids')) ELSE s.policy_agent_ids END,
    default_claim_policy = CASE WHEN p_changes ? 'default_claim_policy'
      THEN p_changes ->> 'default_claim_policy' ELSE s.default_claim_policy END,
    manager_review_allowed = CASE WHEN p_changes ? 'manager_review_allowed'
      THEN (p_changes ->> 'manager_review_allowed')::boolean ELSE s.manager_review_allowed END,
    default_review_required = CASE WHEN p_changes ? 'default_review_required'
      THEN (p_changes ->> 'default_review_required')::boolean ELSE s.default_review_required END,
    coordination_mode = CASE WHEN p_changes ? 'coordination_mode'
      THEN p_changes ->> 'coordination_mode' ELSE s.coordination_mode END
   WHERE s.workspace_id = public.chorus_ws() AND s.id = p_session_id;
  RETURN public.chorus_session_bump(p_session_id);
END;
$$;
