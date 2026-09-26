-- Core schema for the RC1 work lifecycle (design §6, §9, §10, §11).
--
-- Tenant rule: every table carries workspace_id, and every foreign key includes it (composite), so a
-- row can never reference a row in another workspace. Each parent exposes UNIQUE (workspace_id, id)
-- for that purpose. workspaces is the tenant root, so its id is the workspace id.
-- Row-level security is deferred (deviation D7); isolation is enforced by the command layer and tests.

CREATE TABLE workspaces (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE actors (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid        NOT NULL REFERENCES workspaces (id),
  kind         text        NOT NULL CHECK (kind IN ('human', 'agent', 'service')),
  display_name text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE agent_instances (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid        NOT NULL,
  actor_id     uuid        NOT NULL,
  label        text        NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors (workspace_id, id)
);

CREATE TABLE rooms (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid        NOT NULL REFERENCES workspaces (id),
  name         text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

-- Grants are revoked by setting revoked_at, never deleted, so history stays auditable.
CREATE TABLE room_grants (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid        NOT NULL,
  actor_id     uuid        NOT NULL,
  room_id      uuid        NOT NULL,
  role         text        NOT NULL CHECK (role IN ('executor', 'reviewer', 'manager')),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors (workspace_id, id),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id)
);
-- At most one live grant per actor, room and role.
CREATE UNIQUE INDEX room_grants_live_uniq
  ON room_grants (workspace_id, actor_id, room_id, role) WHERE revoked_at IS NULL;

-- Only the SHA-256 of a token is stored, never the token.
CREATE TABLE api_tokens (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid        NOT NULL,
  actor_id     uuid        NOT NULL,
  token_sha256 text        NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors (workspace_id, id)
);

-- Single-use invite codes; redeeming one creates a new actor, so used_by_actor_id is set together with used_at.
CREATE TABLE invites (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid        NOT NULL,
  room_id           uuid        NOT NULL,
  role              text        NOT NULL CHECK (role IN ('executor', 'reviewer', 'manager')),
  code_sha256       text        NOT NULL UNIQUE CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  used_by_actor_id  uuid,
  CHECK ((used_at IS NULL) = (used_by_actor_id IS NULL)),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id),
  FOREIGN KEY (workspace_id, used_by_actor_id) REFERENCES actors (workspace_id, id)
);

CREATE TABLE projects (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid        NOT NULL,
  room_id      uuid        NOT NULL,
  name         text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id)
);

-- Typed work items (design §6.2). RC1 implements task and review only.
CREATE TABLE work_items (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id     uuid        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('task', 'review')),
  home_room_id     uuid        NOT NULL,
  project_id       uuid,
  title            text        NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  body             text        NOT NULL DEFAULT '' CHECK (octet_length(body) <= 65536),
  state            text        NOT NULL,
  version          integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  creator_actor_id uuid        NOT NULL,
  owner_actor_id   uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, kind),
  CHECK (
    (kind = 'task' AND state IN ('backlog', 'ready', 'in_progress', 'review', 'done', 'cancelled'))
    OR (kind = 'review' AND state IN ('requested', 'in_review', 'approved', 'changes_requested', 'cancelled'))
  ),
  FOREIGN KEY (workspace_id, home_room_id) REFERENCES rooms (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (workspace_id, creator_actor_id) REFERENCES actors (workspace_id, id),
  FOREIGN KEY (workspace_id, owner_actor_id) REFERENCES actors (workspace_id, id)
);
CREATE INDEX work_items_room_state_idx ON work_items (workspace_id, home_room_id, state);

-- kind is pinned by the composite FK, so task_details can only attach to a task item.
CREATE TABLE task_details (
  workspace_id        uuid    NOT NULL,
  item_id             uuid    NOT NULL,
  kind                text    NOT NULL DEFAULT 'task' CHECK (kind = 'task'),
  acceptance_criteria jsonb   NOT NULL
    CHECK (jsonb_typeof(acceptance_criteria) = 'array' AND jsonb_array_length(acceptance_criteria) > 0),
  review_required     boolean NOT NULL DEFAULT true,
  PRIMARY KEY (workspace_id, item_id),
  FOREIGN KEY (workspace_id, item_id, kind) REFERENCES work_items (workspace_id, id, kind)
);

-- One lease row per task, created with the task and never deleted. The fence only increases.
CREATE TABLE task_leases (
  workspace_id uuid        NOT NULL,
  task_id      uuid        NOT NULL,
  fence        bigint      NOT NULL DEFAULT 0 CHECK (fence >= 0),
  instance_id  uuid,
  expires_at   timestamptz,
  PRIMARY KEY (workspace_id, task_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES work_items (workspace_id, id),
  FOREIGN KEY (workspace_id, instance_id) REFERENCES agent_instances (workspace_id, id)
);

-- Immutable result snapshots. The database itself checks that the stored digest matches the stored bytes.
CREATE TABLE task_result_revisions (
  workspace_id    uuid        NOT NULL,
  task_id         uuid        NOT NULL,
  revision        integer     NOT NULL CHECK (revision >= 1),
  content         text        NOT NULL CHECK (octet_length(content) <= 262144),
  content_type    text        NOT NULL DEFAULT 'text/plain',
  content_sha256  text        NOT NULL,
  submitted_by    uuid        NOT NULL,
  fence           bigint      NOT NULL CHECK (fence >= 1),
  supporting_refs jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(supporting_refs) = 'array'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, task_id, revision),
  UNIQUE (workspace_id, task_id, revision, content_sha256),
  CHECK (content_sha256 = encode(digest(convert_to(content, 'UTF8'), 'sha256'), 'hex')),
  FOREIGN KEY (workspace_id, task_id) REFERENCES work_items (workspace_id, id),
  FOREIGN KEY (workspace_id, submitted_by) REFERENCES actors (workspace_id, id)
);

-- A review binds to (task, revision, digest); the composite FK makes a digest mismatch unrepresentable.
CREATE TABLE review_details (
  workspace_id    uuid        NOT NULL,
  review_item_id  uuid        NOT NULL,
  kind            text        NOT NULL DEFAULT 'review' CHECK (kind = 'review'),
  subject_task_id uuid        NOT NULL,
  result_revision integer     NOT NULL,
  content_sha256  text        NOT NULL,
  criteria        jsonb       NOT NULL CHECK (jsonb_typeof(criteria) = 'array'),
  verdict         text        CHECK (verdict IN ('approved', 'changes_requested')),
  verdict_at      timestamptz,
  PRIMARY KEY (workspace_id, review_item_id),
  CHECK ((verdict IS NULL) = (verdict_at IS NULL)),
  FOREIGN KEY (workspace_id, review_item_id, kind) REFERENCES work_items (workspace_id, id, kind),
  FOREIGN KEY (workspace_id, subject_task_id, result_revision, content_sha256)
    REFERENCES task_result_revisions (workspace_id, task_id, revision, content_sha256)
);
CREATE INDEX review_details_subject_idx
  ON review_details (workspace_id, subject_task_id, result_revision);

-- Idempotency records (design §11.3): unique per workspace + actor + key.
CREATE TABLE commands (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid        NOT NULL,
  actor_id        uuid        NOT NULL,
  idempotency_key text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash    text        NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  command_type    text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('in_progress', 'succeeded')),
  response        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, actor_id, idempotency_key),
  CHECK ((status = 'succeeded') = (response IS NOT NULL)),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors (workspace_id, id)
);

-- Append-only event journal (design §9.2).
CREATE TABLE domain_events (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id      uuid        NOT NULL,
  room_id           uuid        NOT NULL,
  aggregate_id      uuid        NOT NULL,
  aggregate_version integer     NOT NULL CHECK (aggregate_version >= 1),
  event_type        text        NOT NULL,
  actor_id          uuid        NOT NULL,
  command_id        uuid        NOT NULL,
  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors (workspace_id, id),
  FOREIGN KEY (workspace_id, command_id) REFERENCES commands (workspace_id, id)
);
CREATE INDEX domain_events_aggregate_idx
  ON domain_events (workspace_id, aggregate_id, aggregate_version);
CREATE INDEX domain_events_command_idx ON domain_events (workspace_id, command_id);

-- Immutability and monotonicity guards.
CREATE FUNCTION chorus_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: rows are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER task_result_revisions_immutable
  BEFORE UPDATE OR DELETE ON task_result_revisions
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER task_result_revisions_no_truncate
  BEFORE TRUNCATE ON task_result_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();

CREATE TRIGGER domain_events_immutable
  BEFORE UPDATE OR DELETE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER domain_events_no_truncate
  BEFORE TRUNCATE ON domain_events
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();

CREATE FUNCTION chorus_guard_task_lease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task_leases rows are never deleted (the fence must survive release)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.fence < OLD.fence THEN
    RAISE EXCEPTION 'task_leases.fence may only increase (% -> %)', OLD.fence, NEW.fence
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_leases_guard
  BEFORE UPDATE OR DELETE ON task_leases
  FOR EACH ROW EXECUTE FUNCTION chorus_guard_task_lease();
