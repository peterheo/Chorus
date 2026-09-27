-- RC-WP3 rev 4: room -> session -> board -> item, SharedNet binding, in-room enrollment, SharedOS audit.
--
-- Hierarchy: SharedNet room (one workspace) -> Chorus session -> board (`projects`) -> work items.
-- The SESSION is the authorization boundary; room membership only proves transport identity.
-- Chorus never creates, clones or posts into a SharedNet room.
--
-- Assumption stated once for every ALTER below: this migration runs before any production data exists
-- (nothing is deployed yet), so the affected tables are empty and NOT NULL columns can be added.
-- room_grants (the WP1 per-room role table) is dropped and replaced by room_members + session_members.

-- ---------------------------------------------------------------------------------------------------
-- 0. Retire what this model replaces: invites, room grants, and every policy that used them.
-- ---------------------------------------------------------------------------------------------------
DROP FUNCTION chorus_redeem_invite(text, text, text);
DROP TABLE invites;

DROP POLICY tenant ON actors;
DROP POLICY tenant ON rooms;
DROP POLICY tenant ON projects;
DROP POLICY tenant ON work_items;
DROP POLICY tenant ON domain_events;
DROP POLICY tenant ON task_details;
DROP POLICY tenant ON task_leases;
DROP POLICY tenant ON task_result_revisions;
DROP POLICY tenant ON review_details;
DROP TABLE room_grants;
DROP FUNCTION chorus_visible_rooms();

-- ---------------------------------------------------------------------------------------------------
-- 1. Room binding.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE rooms
  ADD COLUMN provider text NOT NULL DEFAULT 'internal' CHECK (provider IN ('internal', 'sharednet')),
  ADD COLUMN external_room_id text
    CHECK (external_room_id IS NULL OR external_room_id ~ '^rom_[A-Za-z0-9]{6,64}$'),
  ADD COLUMN activation_state text NOT NULL DEFAULT 'inactive'
    CHECK (activation_state IN ('inactive', 'active', 'degraded', 'suspended')),
  ADD CONSTRAINT rooms_external_ck CHECK ((provider = 'sharednet') = (external_room_id IS NOT NULL));
CREATE UNIQUE INDEX rooms_external_uniq ON rooms (provider, external_room_id)
  WHERE external_room_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------
-- 2. Room membership (written only by enrollment completion) and sessions.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE room_members (
  workspace_id      uuid        NOT NULL,
  room_id           uuid        NOT NULL,
  actor_id          uuid        NOT NULL,
  first_verified_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at  timestamptz NOT NULL DEFAULT now(),
  removed_at        timestamptz,
  -- The SharedNet agent tag seen in the enrollment proof, for `policy_matched` joins.
  agent_tag         text,
  PRIMARY KEY (workspace_id, room_id, actor_id),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors (workspace_id, id)
);

CREATE TABLE sessions (
  id                     uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id           uuid        NOT NULL,
  room_id                uuid        NOT NULL,
  name                   text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  discoverable           boolean     NOT NULL DEFAULT true,
  join_policy            text        NOT NULL DEFAULT 'open'
    CHECK (join_policy IN ('open', 'listed', 'policy_matched', 'session_credential')),
  listed_principals      text[]      NOT NULL DEFAULT '{}',
  policy_agent_ids       text[]      NOT NULL DEFAULT '{}',
  default_claim_policy   text        NOT NULL DEFAULT 'open'
    CHECK (default_claim_policy IN ('open', 'manager_assigned', 'approval_required')),
  manager_review_allowed boolean     NOT NULL DEFAULT false,
  default_review_required boolean    NOT NULL DEFAULT true,
  state                  text        NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  version                integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by             uuid        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, room_id),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id),
  FOREIGN KEY (workspace_id, created_by) REFERENCES actors (workspace_id, id)
);

CREATE TABLE session_members (
  workspace_id uuid        NOT NULL,
  session_id   uuid        NOT NULL,
  actor_id     uuid        NOT NULL,
  roles        text[]      NOT NULL
    CHECK (roles <@ ARRAY['participant', 'manager', 'administrator']::text[] AND 'participant' = ANY (roles)),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  version      integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (workspace_id, session_id, actor_id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions (workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors (workspace_id, id)
);
CREATE INDEX session_members_actor_idx ON session_members (workspace_id, actor_id) WHERE removed_at IS NULL;

-- Definer-only: chorus_app has no privilege on this table at all.
CREATE TABLE session_join_credentials (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid        NOT NULL,
  session_id    uuid        NOT NULL,
  secret_sha256 text        NOT NULL UNIQUE CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
  created_by    uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  max_uses      integer     NOT NULL CHECK (max_uses BETWEEN 1 AND 1000),
  uses          integer     NOT NULL DEFAULT 0 CHECK (uses >= 0),
  revoked_at    timestamptz,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions (workspace_id, id),
  FOREIGN KEY (workspace_id, created_by) REFERENCES actors (workspace_id, id)
);

-- ---------------------------------------------------------------------------------------------------
-- 3. Boards (projects) and work items belong to exactly one session.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE projects DROP COLUMN room_id;
ALTER TABLE projects
  ADD COLUMN session_id uuid NOT NULL,
  ADD FOREIGN KEY (workspace_id, session_id) REFERENCES sessions (workspace_id, id),
  ADD UNIQUE (workspace_id, id, session_id);

-- Re-key work_items: session, board, and the extended kinds/states.
ALTER TABLE work_items DROP COLUMN project_id;
ALTER TABLE work_items DROP CONSTRAINT work_items_kind_check;
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.work_items'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%backlog%'
  LOOP
    EXECUTE format('ALTER TABLE public.work_items DROP CONSTRAINT %I', c.conname);
  END LOOP;
END;
$$;
ALTER TABLE work_items
  ADD COLUMN session_id     uuid        NOT NULL,
  ADD COLUMN board_id       uuid        NOT NULL,
  ADD COLUMN priority       smallint    NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
  ADD COLUMN blocked_reason text        CHECK (blocked_reason IS NULL OR char_length(blocked_reason) <= 2000),
  ADD COLUMN blocked_at     timestamptz,
  ADD COLUMN work_cycle     integer     NOT NULL DEFAULT 1 CHECK (work_cycle >= 1),
  ADD CONSTRAINT work_items_kind_ck
    CHECK (kind IN ('task', 'review', 'question', 'finding', 'proposal')),
  ADD CONSTRAINT work_items_state_ck CHECK (
       (kind = 'task'     AND state IN ('ready', 'in_progress', 'review', 'done', 'cancelled'))
    OR (kind = 'review'   AND state IN ('requested', 'approved', 'changes_requested', 'cancelled'))
    OR (kind = 'question' AND state IN ('open', 'closed'))
    OR (kind = 'finding'  AND state IN ('recorded', 'retracted'))
    OR (kind = 'proposal' AND state IN ('open', 'accepted', 'rejected', 'withdrawn'))),
  ADD CONSTRAINT work_items_blocked_ck CHECK ((blocked_reason IS NULL) = (blocked_at IS NULL)),
  ADD UNIQUE (workspace_id, id, session_id),
  ADD FOREIGN KEY (workspace_id, session_id, home_room_id) REFERENCES sessions (workspace_id, id, room_id),
  ADD FOREIGN KEY (workspace_id, board_id, session_id) REFERENCES projects (workspace_id, id, session_id);
CREATE INDEX work_items_session_idx ON work_items (workspace_id, session_id, kind, id DESC);

-- Child tables carry a denormalized session_id tied to the parent item by a composite FK, so a child
-- can never disagree with its item about which session it belongs to (RLS keys on it).
ALTER TABLE task_details
  ADD COLUMN session_id uuid NOT NULL,
  ADD COLUMN criteria_revision integer NOT NULL DEFAULT 1 CHECK (criteria_revision >= 1),
  ADD COLUMN claim_policy text NOT NULL DEFAULT 'open'
    CHECK (claim_policy IN ('open', 'manager_assigned', 'approval_required')),
  ADD FOREIGN KEY (workspace_id, item_id, session_id) REFERENCES work_items (workspace_id, id, session_id);

ALTER TABLE task_leases
  ADD COLUMN session_id uuid NOT NULL,
  ADD FOREIGN KEY (workspace_id, task_id, session_id) REFERENCES work_items (workspace_id, id, session_id);

ALTER TABLE task_result_revisions
  ADD COLUMN session_id uuid NOT NULL,
  ADD COLUMN criteria_revision integer NOT NULL DEFAULT 1 CHECK (criteria_revision >= 1),
  ADD COLUMN work_cycle integer NOT NULL DEFAULT 1 CHECK (work_cycle >= 1),
  ADD FOREIGN KEY (workspace_id, task_id, session_id) REFERENCES work_items (workspace_id, id, session_id);

ALTER TABLE review_details
  ADD COLUMN session_id uuid NOT NULL,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancel_reason text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 2000),
  ADD CONSTRAINT review_details_cancel_ck CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL)),
  ADD COLUMN verdict_reviewer_roles text[]
    CHECK (verdict_reviewer_roles IS NULL OR verdict_reviewer_roles <@ ARRAY['participant', 'manager', 'administrator']::text[]),
  ADD FOREIGN KEY (workspace_id, review_item_id, session_id) REFERENCES work_items (workspace_id, id, session_id),
  -- A review and the task it judges live in the same session, enforced by the database itself.
  ADD FOREIGN KEY (workspace_id, subject_task_id, session_id) REFERENCES work_items (workspace_id, id, session_id);
-- One NON-cancelled review per (task, revision).
DROP INDEX review_details_one_per_revision;
CREATE UNIQUE INDEX review_details_one_live_per_revision
  ON review_details (workspace_id, subject_task_id, result_revision) WHERE cancelled_at IS NULL;

-- Acceptance criteria are revisioned and immutable; revision 1 is written by create_task.
CREATE TABLE task_criteria_revisions (
  workspace_id        uuid        NOT NULL,
  session_id          uuid        NOT NULL,
  task_id             uuid        NOT NULL,
  criteria_revision   integer     NOT NULL CHECK (criteria_revision >= 1),
  acceptance_criteria jsonb       NOT NULL
    CHECK (jsonb_typeof(acceptance_criteria) = 'array' AND jsonb_array_length(acceptance_criteria) > 0),
  created_by          uuid        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, task_id, criteria_revision),
  FOREIGN KEY (workspace_id, task_id, session_id) REFERENCES work_items (workspace_id, id, session_id),
  FOREIGN KEY (workspace_id, created_by) REFERENCES actors (workspace_id, id)
);

CREATE TABLE claim_requests (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id       uuid        NOT NULL,
  session_id         uuid        NOT NULL,
  task_id            uuid        NOT NULL,
  requester_actor_id uuid        NOT NULL,
  state              text        NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_by         uuid,
  decided_at         timestamptz,
  reason             text        CHECK (reason IS NULL OR char_length(reason) <= 2000),
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, task_id, session_id) REFERENCES work_items (workspace_id, id, session_id),
  FOREIGN KEY (workspace_id, requester_actor_id) REFERENCES actors (workspace_id, id),
  FOREIGN KEY (workspace_id, decided_by) REFERENCES actors (workspace_id, id)
);
CREATE UNIQUE INDEX claim_requests_one_pending
  ON claim_requests (workspace_id, task_id, requester_actor_id) WHERE state = 'pending';

CREATE TABLE comments (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid        NOT NULL,
  session_id      uuid        NOT NULL,
  item_id         uuid        NOT NULL,
  author_actor_id uuid        NOT NULL,
  body            text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, item_id, session_id) REFERENCES work_items (workspace_id, id, session_id),
  FOREIGN KEY (workspace_id, author_actor_id) REFERENCES actors (workspace_id, id)
);

CREATE TABLE proposal_details (
  workspace_id     uuid  NOT NULL,
  session_id       uuid  NOT NULL,
  proposal_item_id uuid  NOT NULL,
  target_item_id   uuid  NOT NULL,
  change_kind      text  NOT NULL
    CHECK (change_kind IN ('edit', 'revise_criteria', 'cancel', 'reopen', 'reassign', 'other')),
  payload          jsonb NOT NULL CHECK (octet_length(payload::text) <= 16384),
  resolution_note  text  CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 2000),
  PRIMARY KEY (workspace_id, proposal_item_id),
  FOREIGN KEY (workspace_id, proposal_item_id, session_id) REFERENCES work_items (workspace_id, id, session_id),
  FOREIGN KEY (workspace_id, target_item_id, session_id) REFERENCES work_items (workspace_id, id, session_id)
);

CREATE TABLE message_links (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid        NOT NULL,
  session_id          uuid        NOT NULL,
  item_id             uuid        NOT NULL,
  sharednet_message_id text       NOT NULL,
  sharednet_sequence  bigint      NOT NULL CHECK (sharednet_sequence >= 1),
  sender_principal_id text        NOT NULL,
  sender_member_id    text        NOT NULL,
  content_snapshot    text        NOT NULL CHECK (octet_length(content_snapshot) <= 32768),
  content_sha256      text        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  linked_by           uuid        NOT NULL,
  linked_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, session_id, item_id, sharednet_message_id),
  FOREIGN KEY (workspace_id, item_id, session_id) REFERENCES work_items (workspace_id, id, session_id),
  FOREIGN KEY (workspace_id, linked_by) REFERENCES actors (workspace_id, id)
);

-- ---------------------------------------------------------------------------------------------------
-- 4. Idempotency is scoped to the session (or 'room' for room-level commands); events know their session.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE commands
  ADD COLUMN session_id uuid,
  ADD COLUMN scope_key text NOT NULL,
  ADD FOREIGN KEY (workspace_id, session_id) REFERENCES sessions (workspace_id, id);
ALTER TABLE commands DROP CONSTRAINT commands_workspace_id_actor_id_idempotency_key_key;
ALTER TABLE commands ADD UNIQUE (workspace_id, actor_id, scope_key, idempotency_key);

ALTER TABLE domain_events
  ADD COLUMN session_id uuid,
  ADD FOREIGN KEY (workspace_id, session_id) REFERENCES sessions (workspace_id, id);
CREATE INDEX domain_events_session_idx ON domain_events (workspace_id, session_id, occurred_at);

-- A room token is scoped to one room.
ALTER TABLE api_tokens
  ADD COLUMN room_id uuid NOT NULL,
  ADD FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id);

-- ---------------------------------------------------------------------------------------------------
-- 5. SharedNet service seat, watcher cursor (with consumer epoch), identities, enrollments, audit.
-- ---------------------------------------------------------------------------------------------------
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

CREATE TABLE sharednet_cursors (
  workspace_id   uuid        NOT NULL,
  room_id        uuid        NOT NULL,
  last_sequence  bigint      NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  consumer_epoch bigint      NOT NULL DEFAULT 0 CHECK (consumer_epoch >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_error     text,
  last_ok_at     timestamptz,
  PRIMARY KEY (workspace_id, room_id),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id)
);

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
  proof_agent_id      text,
  consumed_at         timestamptz,
  issued_actor_id     uuid,
  issued_token_id     uuid,
  CHECK (expires_at = created_at + interval '10 minutes'),
  -- verified/consumed imply verified_at; an EXPIRED enrollment may keep the verified_at it earned.
  CHECK ((state IN ('verified', 'consumed')) = (verified_at IS NOT NULL) OR state = 'expired'),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id)
);
CREATE INDEX enrollments_room_state_idx ON enrollments (workspace_id, room_id, state);

-- Persisted SharedOS audit events (appended by the host's AuditSink; SharedOS events carry no secrets).
CREATE TABLE sharedos_audit_events (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid        NOT NULL REFERENCES workspaces (id),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  event        jsonb       NOT NULL
);
CREATE INDEX sharedos_audit_trace_idx ON sharedos_audit_events (workspace_id, (event ->> 'traceId'));

-- Operator audit trail (owner-only; infrastructure commands write here). Never contains secrets.
CREATE TABLE admin_audit_log (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  operator     text        NOT NULL CHECK (length(operator) BETWEEN 1 AND 200),
  command      text        NOT NULL,
  workspace_id uuid,
  subject_id   uuid,
  details      jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Immutability: append-only records.
CREATE TRIGGER admin_audit_log_immutable BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER admin_audit_log_no_truncate BEFORE TRUNCATE ON admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER sharedos_audit_immutable BEFORE UPDATE OR DELETE ON sharedos_audit_events
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER sharedos_audit_no_truncate BEFORE TRUNCATE ON sharedos_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER task_criteria_revisions_immutable BEFORE UPDATE OR DELETE ON task_criteria_revisions
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER task_criteria_revisions_no_truncate BEFORE TRUNCATE ON task_criteria_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER comments_immutable BEFORE UPDATE OR DELETE ON comments
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER comments_no_truncate BEFORE TRUNCATE ON comments
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER message_links_immutable BEFORE UPDATE OR DELETE ON message_links
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER message_links_no_truncate BEFORE TRUNCATE ON message_links
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();

-- ---------------------------------------------------------------------------------------------------
-- 6. Row-level security. Every new table: ENABLE + FORCE (admin_audit_log is the one deliberate
--    exemption: owner-only, no chorus_app privilege at all).
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE room_members             ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_members          ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_join_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_criteria_revisions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_requests           ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_details         ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_links            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharednet_seats          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharednet_cursors        ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_identities      ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharedos_audit_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_members             FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions                 FORCE ROW LEVEL SECURITY;
ALTER TABLE session_members          FORCE ROW LEVEL SECURITY;
ALTER TABLE session_join_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE task_criteria_revisions  FORCE ROW LEVEL SECURITY;
ALTER TABLE claim_requests           FORCE ROW LEVEL SECURITY;
ALTER TABLE comments                 FORCE ROW LEVEL SECURITY;
ALTER TABLE proposal_details         FORCE ROW LEVEL SECURITY;
ALTER TABLE message_links            FORCE ROW LEVEL SECURITY;
ALTER TABLE sharednet_seats          FORCE ROW LEVEL SECURITY;
ALTER TABLE sharednet_cursors        FORCE ROW LEVEL SECURITY;
ALTER TABLE external_identities      FORCE ROW LEVEL SECURITY;
ALTER TABLE enrollments              FORCE ROW LEVEL SECURITY;
ALTER TABLE sharedos_audit_events    FORCE ROW LEVEL SECURITY;

-- Sessions the current actor may act in: a live session member who is ALSO a live member of the session's
-- (active) room. Removing someone from the room therefore closes every session to them at once, in the
-- database itself. SECURITY DEFINER so policies on session_members can use it without recursing into
-- their own policy.
CREATE FUNCTION chorus_my_sessions() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT m.session_id
    FROM public.session_members m
    JOIN public.sessions s ON s.workspace_id = m.workspace_id AND s.id = m.session_id
    JOIN public.rooms r ON r.workspace_id = s.workspace_id AND r.id = s.room_id
    JOIN public.room_members rm
      ON rm.workspace_id = s.workspace_id AND rm.room_id = s.room_id AND rm.actor_id = m.actor_id
   WHERE m.workspace_id = public.chorus_ws() AND m.actor_id = public.chorus_actor()
     AND m.removed_at IS NULL AND rm.removed_at IS NULL AND r.activation_state = 'active'
$$;

-- Workspace-level (rooms and room membership).
CREATE POLICY tenant ON rooms
  USING (workspace_id = chorus_ws()) WITH CHECK (workspace_id = chorus_ws());
CREATE POLICY tenant ON room_members
  USING (workspace_id = chorus_ws()) WITH CHECK (workspace_id = chorus_ws());

-- A session is visible if it is discoverable or the actor is a live member. It is never writable by
-- chorus_app directly: every change goes through the chorus_session_* definers below.
CREATE POLICY visible ON sessions FOR SELECT
  USING (workspace_id = chorus_ws() AND (discoverable OR id IN (SELECT chorus_my_sessions())));

-- An actor sees itself and the actors it shares a session with (session_members is itself session-scoped).
CREATE POLICY tenant ON actors
  USING (workspace_id = chorus_ws()
         AND (id = chorus_actor()
              OR EXISTS (SELECT 1 FROM session_members m
                          WHERE m.workspace_id = actors.workspace_id AND m.actor_id = actors.id)))
  WITH CHECK (workspace_id = chorus_ws());

-- Session-scoped tables: workspace match AND the row's session is one of the actor's sessions.
CREATE POLICY tenant ON session_members
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON projects
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON work_items
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON task_details
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON task_criteria_revisions
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON task_leases
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON task_result_revisions
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON review_details
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON claim_requests
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON comments
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON proposal_details
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON message_links
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));
CREATE POLICY tenant ON domain_events
  USING (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()))
  WITH CHECK (workspace_id = chorus_ws() AND session_id IN (SELECT chorus_my_sessions()));

-- SharedOS audit: append-only; readable within the workspace (the HTTP layer narrows further).
CREATE POLICY tenant ON sharedos_audit_events
  USING (workspace_id = chorus_ws()) WITH CHECK (workspace_id = chorus_ws());

-- ---------------------------------------------------------------------------------------------------
-- 7. Least-privilege grants. chorus_app has NO privileges on sharednet_seats, sharednet_cursors,
--    external_identities, enrollments, session_join_credentials or admin_audit_log.
-- ---------------------------------------------------------------------------------------------------
GRANT SELECT ON room_members TO chorus_app;
GRANT SELECT ON sessions, session_members TO chorus_app;
GRANT SELECT, INSERT ON task_criteria_revisions, comments, message_links, sharedos_audit_events TO chorus_app;
GRANT SELECT, INSERT, UPDATE ON claim_requests, proposal_details, projects TO chorus_app;
GRANT UPDATE ON task_details TO chorus_app;
-- sessions and session_members are read-only for chorus_app: creation, joining, role and policy changes,
-- removal and version bumps all go through the SECURITY DEFINER functions below, each of which
-- re-verifies the caller's CURRENT session role, so membership and roles can never be self-granted.

-- ---------------------------------------------------------------------------------------------------
-- 8. SECURITY DEFINER functions. Standard hardening on every one: search_path pg_catalog, public,
--    pg_temp; every relation schema-qualified; EXECUTE revoked from PUBLIC and granted to chorus_app.
--    Custom SQLSTATEs carry outcomes: CH001 room_not_available, CH002 cursor_regression,
--    CH003 stale_epoch, CH004 forbidden_in_room.
-- ---------------------------------------------------------------------------------------------------
-- chorus_resolve_token exists from 0004 with a different return type, so it is dropped and recreated.
DROP FUNCTION chorus_resolve_token(text);

CREATE FUNCTION chorus_enroll_start(
  p_external_room_id text, p_claimed_member_id text, p_display_name text,
  p_nonce text, p_secret_sha256 text)
  RETURNS TABLE (enrollment_id uuid, expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_ws uuid; v_room uuid; v_seq bigint; v_ok timestamptz; v_id uuid; v_expires timestamptz;
BEGIN
  SELECT r.workspace_id, r.id, c.last_sequence, c.last_ok_at INTO v_ws, v_room, v_seq, v_ok
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
  VALUES (v_ws, v_room, p_claimed_member_id, p_display_name, p_nonce, p_secret_sha256, 'pending',
          now(), now() + interval '10 minutes', v_seq)
  RETURNING id, public.enrollments.expires_at INTO v_id, v_expires;
  RETURN QUERY SELECT v_id, v_expires;
END;
$$;

CREATE FUNCTION chorus_enroll_verify(
  p_workspace_id uuid, p_room_id uuid, p_nonce text, p_message_id text, p_sequence bigint,
  p_sender_principal_id text, p_sender_member_id text, p_sender_agent_id text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.enrollments e
     SET state = 'verified', verified_at = now(), proof_message_id = p_message_id,
         proof_sequence = p_sequence, proof_principal_id = p_sender_principal_id,
         proof_member_id = p_sender_member_id, proof_agent_id = p_sender_agent_id
   WHERE e.workspace_id = p_workspace_id AND e.room_id = p_room_id AND e.nonce = p_nonce
     AND e.state = 'pending' AND now() < e.expires_at
     AND p_sequence > e.start_sequence
     AND e.claimed_member_id = p_sender_member_id;
  RETURN FOUND;
END;
$$;

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

-- Issues the room token exactly once (row-locked). Creates or reuses the actor for the SharedNet
-- principal, records live room membership and the agent tag, and binds a new instance to the token.
-- It grants NO session access: sessions are joined separately, per policy.
CREATE FUNCTION chorus_enroll_complete(
  p_enrollment_id uuid, p_secret_sha256 text, p_token_sha256 text)
  RETURNS TABLE (status text, actor_id uuid, workspace_id uuid, room_id uuid, instance_id uuid,
                 token_expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_e public.enrollments%ROWTYPE;
  v_actor uuid; v_new uuid; v_instance uuid; v_expires timestamptz; v_removed timestamptz;
BEGIN
  SELECT * INTO v_e FROM public.enrollments e
   WHERE e.id = p_enrollment_id AND e.secret_sha256 = p_secret_sha256 FOR UPDATE;
  IF NOT FOUND OR v_e.state IN ('consumed', 'expired') OR now() >= v_e.expires_at THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_e.state = 'pending' THEN
    RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.rooms r
     WHERE r.workspace_id = v_e.workspace_id AND r.id = v_e.room_id AND r.activation_state = 'active') THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

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

  -- A member removed from the room stays removed; re-admission is an explicit administrative act.
  SELECT m.removed_at INTO v_removed FROM public.room_members m
   WHERE m.workspace_id = v_e.workspace_id AND m.room_id = v_e.room_id AND m.actor_id = v_actor;
  IF FOUND AND v_removed IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  INSERT INTO public.room_members (workspace_id, room_id, actor_id, agent_tag)
  VALUES (v_e.workspace_id, v_e.room_id, v_actor, v_e.proof_agent_id)
  ON CONFLICT (workspace_id, room_id, actor_id)
  DO UPDATE SET last_verified_at = now(), agent_tag = EXCLUDED.agent_tag;

  INSERT INTO public.agent_instances (workspace_id, actor_id, label)
  VALUES (v_e.workspace_id, v_actor, 'sharednet:' || v_e.proof_member_id)
  RETURNING id INTO v_instance;

  v_expires := now() + interval '120 minutes';
  INSERT INTO public.api_tokens (workspace_id, actor_id, token_sha256, instance_id, expires_at, room_id)
  VALUES (v_e.workspace_id, v_actor, p_token_sha256, v_instance, v_expires, v_e.room_id);

  UPDATE public.enrollments
     SET state = 'consumed', consumed_at = now(), issued_actor_id = v_actor
   WHERE id = v_e.id;

  RETURN QUERY SELECT 'issued'::text, v_actor, v_e.workspace_id, v_e.room_id, v_instance, v_expires;
END;
$$;

-- A token is live only while: unrevoked, unexpired, its room is active, and its actor is a live member of that room.
CREATE FUNCTION chorus_resolve_token(p_token_sha256 text)
  RETURNS TABLE (actor_id uuid, workspace_id uuid, actor_kind text, instance_id uuid,
                 token_expires_at timestamptz, room_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT t.actor_id, t.workspace_id, a.kind, t.instance_id, t.expires_at, t.room_id
    FROM public.api_tokens t
    JOIN public.actors a ON a.workspace_id = t.workspace_id AND a.id = t.actor_id
    JOIN public.rooms r ON r.workspace_id = t.workspace_id AND r.id = t.room_id
    JOIN public.room_members m
      ON m.workspace_id = t.workspace_id AND m.room_id = t.room_id AND m.actor_id = t.actor_id
   WHERE t.token_sha256 = p_token_sha256
     AND t.revoked_at IS NULL
     AND (t.expires_at IS NULL OR t.expires_at > now())
     AND r.activation_state = 'active'
     AND m.removed_at IS NULL
$$;

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

-- Consumer lease: a process that holds the room's advisory lock claims a NEW epoch; every later advance
-- carries it, so a slower ex-holder can never move the cursor.
CREATE FUNCTION chorus_watcher_claim_epoch(p_workspace_id uuid, p_room_id uuid)
  RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_epoch bigint;
BEGIN
  UPDATE public.sharednet_cursors SET consumer_epoch = consumer_epoch + 1, updated_at = now()
   WHERE workspace_id = p_workspace_id AND room_id = p_room_id
   RETURNING consumer_epoch INTO v_epoch;
  IF NOT FOUND THEN RAISE EXCEPTION 'no cursor for room' USING ERRCODE = 'no_data_found'; END IF;
  RETURN v_epoch;
END;
$$;

CREATE FUNCTION chorus_watcher_advance(
  p_workspace_id uuid, p_room_id uuid, p_new_last_sequence bigint, p_epoch bigint,
  p_ok boolean, p_error text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_last bigint; v_epoch bigint;
BEGIN
  SELECT c.last_sequence, c.consumer_epoch INTO v_last, v_epoch FROM public.sharednet_cursors c
   WHERE c.workspace_id = p_workspace_id AND c.room_id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no cursor for room' USING ERRCODE = 'no_data_found'; END IF;
  IF p_epoch <> v_epoch THEN
    RAISE EXCEPTION 'stale consumer epoch % (current %)', p_epoch, v_epoch USING ERRCODE = 'CH003';
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

-- The watcher can only take a room OUT of service (active -> degraded); only the operator path reactivates.
CREATE FUNCTION chorus_set_room_state(p_workspace_id uuid, p_room_id uuid, p_state text, p_reason text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_state <> 'degraded' THEN
    RAISE EXCEPTION 'this function can only degrade a room' USING ERRCODE = 'invalid_parameter_value';
  END IF;
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

-- Create a session and its first board atomically, with the caller as participant + manager + administrator.
-- The caller's identity comes from the transaction settings, never from arguments.
CREATE FUNCTION chorus_create_session(
  p_room_id uuid, p_name text, p_board_name text, p_discoverable boolean, p_join_policy text,
  p_listed_principals text[], p_policy_agent_ids text[], p_claim_policy text,
  p_manager_review_allowed boolean, p_review_required boolean)
  RETURNS TABLE (session_id uuid, board_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_ws uuid := public.chorus_ws(); v_actor uuid := public.chorus_actor(); v_session uuid; v_board uuid;
BEGIN
  IF v_ws IS NULL OR v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.room_members m JOIN public.rooms r
        ON r.workspace_id = m.workspace_id AND r.id = m.room_id
     WHERE m.workspace_id = v_ws AND m.room_id = p_room_id AND m.actor_id = v_actor
       AND m.removed_at IS NULL AND r.activation_state = 'active') THEN
    RAISE EXCEPTION 'not a live member of an active room' USING ERRCODE = 'CH004';
  END IF;
  INSERT INTO public.sessions
    (workspace_id, room_id, name, discoverable, join_policy, listed_principals, policy_agent_ids,
     default_claim_policy, manager_review_allowed, default_review_required, created_by)
  VALUES (v_ws, p_room_id, p_name, p_discoverable, p_join_policy, p_listed_principals, p_policy_agent_ids,
          p_claim_policy, p_manager_review_allowed, p_review_required, v_actor)
  RETURNING id INTO v_session;
  INSERT INTO public.session_members (workspace_id, session_id, actor_id, roles)
  VALUES (v_ws, v_session, v_actor, ARRAY['participant', 'manager', 'administrator']);
  INSERT INTO public.projects (workspace_id, session_id, name)
  VALUES (v_ws, v_session, p_board_name) RETURNING id INTO v_board;
  RETURN QUERY SELECT v_session, v_board;
END;
$$;

-- Join a session per its policy. Not eligible, nonexistent and not visible are indistinguishable (zero rows).
CREATE FUNCTION chorus_join_session(p_session_id uuid, p_credential_sha256 text)
  RETURNS TABLE (session_id uuid, roles text[], newly_joined boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_ws uuid := public.chorus_ws(); v_actor uuid := public.chorus_actor();
  v_s public.sessions%ROWTYPE; v_principal text; v_tag text; v_member public.session_members%ROWTYPE;
  v_cred public.session_join_credentials%ROWTYPE; v_ok boolean := false;
BEGIN
  IF v_ws IS NULL OR v_actor IS NULL THEN RETURN; END IF;
  SELECT * INTO v_s FROM public.sessions s WHERE s.workspace_id = v_ws AND s.id = p_session_id AND s.state = 'active';
  IF NOT FOUND THEN RETURN; END IF;
  -- Must be a live member of the session's active room.
  SELECT m.agent_tag INTO v_tag FROM public.room_members m JOIN public.rooms r
      ON r.workspace_id = m.workspace_id AND r.id = m.room_id
   WHERE m.workspace_id = v_ws AND m.room_id = v_s.room_id AND m.actor_id = v_actor
     AND m.removed_at IS NULL AND r.activation_state = 'active';
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO v_member FROM public.session_members m
   WHERE m.workspace_id = v_ws AND m.session_id = p_session_id AND m.actor_id = v_actor FOR UPDATE;
  IF FOUND AND v_member.removed_at IS NULL THEN
    RETURN QUERY SELECT p_session_id, v_member.roles, false;   -- already a member: idempotent
    RETURN;
  END IF;

  SELECT i.principal_id INTO v_principal FROM public.external_identities i
   WHERE i.workspace_id = v_ws AND i.actor_id = v_actor AND i.provider = 'sharednet';

  IF v_s.join_policy = 'open' THEN
    -- Non-discoverable only hides the session from listings (A4.2); an open one is joinable by id.
    v_ok := true;
  ELSIF v_s.join_policy = 'listed' THEN
    v_ok := v_principal IS NOT NULL AND v_principal = ANY (v_s.listed_principals);
  ELSIF v_s.join_policy = 'policy_matched' THEN
    v_ok := v_tag IS NOT NULL AND v_tag = ANY (v_s.policy_agent_ids);
  ELSIF v_s.join_policy = 'session_credential' THEN
    IF p_credential_sha256 IS NOT NULL THEN
      SELECT * INTO v_cred FROM public.session_join_credentials c
       WHERE c.workspace_id = v_ws AND c.session_id = p_session_id AND c.secret_sha256 = p_credential_sha256
         AND c.revoked_at IS NULL AND c.expires_at > now() AND c.uses < c.max_uses FOR UPDATE;
      IF FOUND THEN
        UPDATE public.session_join_credentials SET uses = uses + 1 WHERE id = v_cred.id;
        v_ok := true;
      END IF;
    END IF;
  END IF;
  IF NOT v_ok THEN RETURN; END IF;

  IF v_member.actor_id IS NOT NULL THEN   -- a removed member rejoins as participant only
    UPDATE public.session_members
       SET removed_at = NULL, roles = ARRAY['participant'], joined_at = now(), version = version + 1
     WHERE workspace_id = v_ws AND session_id = p_session_id AND actor_id = v_actor;
  ELSE
    INSERT INTO public.session_members (workspace_id, session_id, actor_id, roles)
    VALUES (v_ws, p_session_id, v_actor, ARRAY['participant']);
  END IF;
  RETURN QUERY SELECT p_session_id, ARRAY['participant']::text[], true;
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

-- Health surface for /healthz: binding, state and whether the watcher has been ok recently.
CREATE FUNCTION chorus_room_health()
  RETURNS TABLE (external_room_id text, activation_state text, watcher_ok boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.external_room_id, r.activation_state,
         COALESCE(c.last_ok_at > now() - interval '2 minutes', false)
    FROM public.rooms r
    LEFT JOIN public.sharednet_cursors c ON c.workspace_id = r.workspace_id AND c.room_id = r.id
   WHERE r.provider = 'sharednet'
$$;

-- ---------------------------------------------------------------------------------------------------
-- Session writes (A4.3). chorus_app cannot UPDATE sessions or session_members; these definers are the
-- only writers. Each derives the caller from chorus.actor_id and re-checks the CURRENT role.
-- ---------------------------------------------------------------------------------------------------

-- The caller's roles in a session, or NULL unless the caller is a live session member of a live room
-- membership in an active room (the single definition of "live member": chorus_my_sessions()).
CREATE FUNCTION chorus_session_roles(p_session_id uuid) RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT m.roles FROM public.session_members m
   WHERE m.workspace_id = public.chorus_ws() AND m.session_id = p_session_id
     AND m.actor_id = public.chorus_actor()
     AND m.session_id IN (SELECT public.chorus_my_sessions())
$$;

-- Locks the session row (mode 'none' | 'share' | 'update') and only THEN reads the caller's roles, so a
-- command that waited on the lock authorizes against the roles that are current when it proceeds.
CREATE FUNCTION chorus_session_lock(p_session_id uuid, p_mode text)
  RETURNS TABLE (id uuid, room_id uuid, version integer, join_policy text, default_claim_policy text,
                 manager_review_allowed boolean, default_review_required boolean, state text, roles text[])
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ws uuid := public.chorus_ws();
  v_roles text[];
BEGIN
  IF p_mode NOT IN ('none', 'share', 'update') THEN
    RAISE EXCEPTION 'invalid lock mode' USING ERRCODE = '22023';
  END IF;
  IF v_ws IS NULL OR public.chorus_actor() IS NULL THEN RETURN; END IF;
  -- Non-members never reach the lock, so they cannot stall anyone.
  IF public.chorus_session_roles(p_session_id) IS NULL THEN RETURN; END IF;
  IF p_mode = 'update' THEN
    PERFORM 1 FROM public.sessions s WHERE s.workspace_id = v_ws AND s.id = p_session_id FOR UPDATE;
  ELSIF p_mode = 'share' THEN
    PERFORM 1 FROM public.sessions s WHERE s.workspace_id = v_ws AND s.id = p_session_id FOR SHARE;
  END IF;
  v_roles := public.chorus_session_roles(p_session_id);
  IF v_roles IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT s.id, s.room_id, s.version, s.join_policy, s.default_claim_policy, s.manager_review_allowed,
           s.default_review_required, s.state, v_roles
      FROM public.sessions s WHERE s.workspace_id = v_ws AND s.id = p_session_id;
END;
$$;

CREATE FUNCTION chorus_session_bump(p_session_id uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_version integer;
BEGIN
  IF public.chorus_session_roles(p_session_id) IS NULL THEN
    RAISE EXCEPTION 'not a live session member' USING ERRCODE = '42501';
  END IF;
  UPDATE public.sessions SET version = version + 1
   WHERE workspace_id = public.chorus_ws() AND id = p_session_id
   RETURNING version INTO v_version;
  RETURN v_version;
END;
$$;

CREATE FUNCTION chorus_session_set_policy(p_session_id uuid, p_changes jsonb) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_roles text[] := public.chorus_session_roles(p_session_id);
BEGIN
  IF v_roles IS NULL OR NOT ('administrator' = ANY (v_roles)) THEN
    RAISE EXCEPTION 'administrator role required' USING ERRCODE = '42501';
  END IF;
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
      THEN (p_changes ->> 'default_review_required')::boolean ELSE s.default_review_required END
   WHERE s.workspace_id = public.chorus_ws() AND s.id = p_session_id;
END;
$$;

-- Members that are live under the SAME definition as chorus_my_sessions(): a live session member who is
-- also a live member of the session's active room. Empty unless the caller is itself a live member.
CREATE FUNCTION chorus_session_live_members(p_session_id uuid)
  RETURNS TABLE (actor_id uuid, roles text[], joined_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT m.actor_id, m.roles, m.joined_at
    FROM public.session_members m
    JOIN public.sessions s ON s.workspace_id = m.workspace_id AND s.id = m.session_id
    JOIN public.rooms r ON r.workspace_id = s.workspace_id AND r.id = s.room_id
    JOIN public.room_members rm
      ON rm.workspace_id = s.workspace_id AND rm.room_id = s.room_id AND rm.actor_id = m.actor_id
   WHERE m.workspace_id = public.chorus_ws() AND m.session_id = p_session_id
     AND m.removed_at IS NULL AND rm.removed_at IS NULL AND r.activation_state = 'active'
     AND p_session_id IN (SELECT public.chorus_my_sessions())
$$;

-- Administrator-only: replace a LIVE member's roles. NULL when the target is not a live member.
CREATE FUNCTION chorus_session_set_roles(p_session_id uuid, p_actor_id uuid, p_roles text[])
  RETURNS text[]
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_roles text[] := public.chorus_session_roles(p_session_id);
  v_new text[];
BEGIN
  IF v_roles IS NULL OR NOT ('administrator' = ANY (v_roles)) THEN
    RAISE EXCEPTION 'administrator role required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chorus_session_live_members(p_session_id) l
                  WHERE l.actor_id = p_actor_id) THEN
    RETURN NULL;
  END IF;
  UPDATE public.session_members m SET roles = p_roles, version = m.version + 1
   WHERE m.workspace_id = public.chorus_ws() AND m.session_id = p_session_id AND m.actor_id = p_actor_id
     AND m.removed_at IS NULL
   RETURNING m.roles INTO v_new;
  RETURN v_new;
END;
$$;

-- Administrator removes a member, or any member removes themself (leave). Closes the membership row.
CREATE FUNCTION chorus_session_remove_member(p_session_id uuid, p_actor_id uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_roles text[] := public.chorus_session_roles(p_session_id);
BEGIN
  IF v_roles IS NULL THEN
    RAISE EXCEPTION 'not a live session member' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id <> public.chorus_actor() AND NOT ('administrator' = ANY (v_roles)) THEN
    RAISE EXCEPTION 'administrator role required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.session_members m SET removed_at = now(), version = m.version + 1
   WHERE m.workspace_id = public.chorus_ws() AND m.session_id = p_session_id AND m.actor_id = p_actor_id
     AND m.removed_at IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION chorus_my_sessions() FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_enroll_start(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_enroll_verify(uuid, uuid, text, text, bigint, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_enroll_status(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_enroll_complete(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_resolve_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_watcher_rooms() FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_watcher_claim_epoch(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_watcher_advance(uuid, uuid, bigint, bigint, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_set_room_state(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_create_session(uuid, text, text, boolean, text, text[], text[], text, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_join_session(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_expire_enrollments() FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_room_health() FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_session_roles(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_session_lock(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_session_bump(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_session_set_policy(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_session_live_members(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_session_set_roles(uuid, uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION chorus_session_remove_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chorus_my_sessions() TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_session_roles(uuid) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_session_lock(uuid, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_session_bump(uuid) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_session_set_policy(uuid, jsonb) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_session_live_members(uuid) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_session_set_roles(uuid, uuid, text[]) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_session_remove_member(uuid, uuid) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_enroll_start(text, text, text, text, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_enroll_verify(uuid, uuid, text, text, bigint, text, text, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_enroll_status(uuid, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_enroll_complete(uuid, text, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_resolve_token(text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_watcher_rooms() TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_watcher_claim_epoch(uuid, uuid) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_watcher_advance(uuid, uuid, bigint, bigint, boolean, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_set_room_state(uuid, uuid, text, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_create_session(uuid, text, text, boolean, text, text[], text[], text, boolean, boolean) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_join_session(uuid, text) TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_expire_enrollments() TO chorus_app;
GRANT EXECUTE ON FUNCTION chorus_room_health() TO chorus_app;
