-- CC-1b (Conversation coordination, first slice): scans and suggestions extracted from an explicitly
-- selected window of room messages, plus the service-seat read the fetch needs. Rules-v1 (CC-1a) is a pure
-- library; nothing here talks to SharedNet. Standard definer hardening: search_path pg_catalog, public,
-- pg_temp; every relation schema-qualified; EXECUTE revoked from PUBLIC and granted to chorus_app.

-- ---------------------------------------------------------------------------------------------------
-- 1. Scans and suggestions.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE conversation_scans (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid        NOT NULL,
  session_id        uuid        NOT NULL,
  room_id           uuid        NOT NULL,
  from_sequence     bigint      NOT NULL CHECK (from_sequence >= 1),
  to_sequence       bigint      NOT NULL,
  cutoff_sequence   bigint      NOT NULL,
  messages_examined integer     NOT NULL CHECK (messages_examined BETWEEN 0 AND 200),
  extractor         text        NOT NULL CHECK (extractor = 'rules-v1'),
  requested_by      uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (to_sequence >= from_sequence AND to_sequence - from_sequence < 200),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions (workspace_id, id),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id),
  FOREIGN KEY (workspace_id, requested_by) REFERENCES actors (workspace_id, id)
);
CREATE INDEX conversation_scans_session_idx ON conversation_scans (workspace_id, session_id, created_at DESC);

CREATE TABLE conversation_suggestions (
  id                       uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id             uuid        NOT NULL,
  session_id               uuid        NOT NULL,
  kind                     text        NOT NULL CHECK (kind IN ('question', 'commitment')),
  -- sha256(session_id || '|' || fingerprint_input), computed by recordScan; scoped to the session so the
  -- same words in two sessions never collide.
  fingerprint              text        NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  excerpt                  text        NOT NULL CHECK (char_length(excerpt) <= 281),
  confidence               text        NOT NULL CHECK (confidence IN ('high', 'medium')),
  source_message_id        text        NOT NULL,
  source_sequence          bigint      NOT NULL,
  source_member_id         text        NOT NULL,
  source_principal_id      text        NOT NULL,
  source_name              text        NOT NULL CHECK (char_length(source_name) <= 200),
  -- The full source message content, truncated to 32 KiB of UTF-8 on a code-point boundary.
  source_content_snapshot  text        NOT NULL CHECK (octet_length(source_content_snapshot) <= 32768),
  source_content_sha256    text        NOT NULL CHECK (source_content_sha256 ~ '^[0-9a-f]{64}$'),
  replied_by_other         boolean     NOT NULL,
  suggested_next_action    text        NOT NULL,
  state                    text        NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'linked', 'dismissed')),
  linked_item_id           uuid,
  decided_by               uuid,
  decided_at               timestamptz,
  dismiss_reason           text        CHECK (dismiss_reason IS NULL OR char_length(dismiss_reason) <= 500),
  first_scan_id            uuid        NOT NULL,
  last_scan_id             uuid        NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'open') = (decided_by IS NULL)),
  CHECK ((state = 'linked') = (linked_item_id IS NOT NULL)),
  UNIQUE (workspace_id, session_id, fingerprint),
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions (workspace_id, id),
  FOREIGN KEY (workspace_id, linked_item_id, session_id) REFERENCES work_items (workspace_id, id, session_id),
  FOREIGN KEY (workspace_id, decided_by) REFERENCES actors (workspace_id, id),
  FOREIGN KEY (workspace_id, first_scan_id) REFERENCES conversation_scans (workspace_id, id),
  FOREIGN KEY (workspace_id, last_scan_id) REFERENCES conversation_scans (workspace_id, id)
);
-- work_items(workspace_id, id, session_id) needs this composite unique target for the FK above.
ALTER TABLE work_items ADD CONSTRAINT work_items_workspace_id_id_session_id_uniq UNIQUE (workspace_id, id, session_id);
CREATE INDEX conversation_suggestions_session_state_idx
  ON conversation_suggestions (workspace_id, session_id, state, source_sequence DESC, id);

CREATE TRIGGER conversation_scans_immutable BEFORE UPDATE OR DELETE ON conversation_scans
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER conversation_scans_no_truncate BEFORE TRUNCATE ON conversation_scans
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER conversation_suggestions_no_delete BEFORE DELETE ON conversation_suggestions
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER conversation_suggestions_no_truncate BEFORE TRUNCATE ON conversation_suggestions
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();

-- ---------------------------------------------------------------------------------------------------
-- 2. RLS: visible only within the caller's own live sessions (chorus_my_sessions(), the one definition
--    of a live member: session member + room member + active room).
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE conversation_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_scans FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_suggestions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant ON conversation_scans
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON conversation_suggestions
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));

GRANT SELECT, INSERT ON conversation_scans, conversation_suggestions TO chorus_app;
GRANT UPDATE (state, linked_item_id, decided_by, decided_at, dismiss_reason, last_scan_id, replied_by_other,
              updated_at)
  ON conversation_suggestions TO chorus_app;

-- ---------------------------------------------------------------------------------------------------
-- 3. The service seat the fetch needs (rev1.1 section 2.2): only for a live member of the given session,
--    who is (by chorus_my_sessions()'s own definition) also a live member of its active room.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION chorus_conversation_seat(p_session uuid)
  RETURNS TABLE (external_room_id text, member_id text, token_ciphertext bytea, token_nonce bytea, key_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.external_room_id, s.member_id, s.token_ciphertext, s.token_nonce, s.key_id
    FROM public.sessions sess
    JOIN public.rooms r ON r.workspace_id = sess.workspace_id AND r.id = sess.room_id
    JOIN public.sharednet_seats s ON s.workspace_id = sess.workspace_id AND s.room_id = sess.room_id
   WHERE sess.id = p_session
     AND sess.workspace_id = public.chorus_ws()
     AND sess.id IN (SELECT public.chorus_my_sessions())
$$;

REVOKE ALL ON FUNCTION chorus_conversation_seat(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chorus_conversation_seat(uuid) TO chorus_app;
