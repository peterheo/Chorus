-- S1-4 (WP5-min rev 1 section 2, amended by Arena rev 2 C1/C9): purchases for the paid Arena services.
--
-- Assumption stated once, as in 0005: nothing is deployed with data in these tables. `agent_instances`
-- rows that exist before this migration get sharednet_member_id NULL and must re-enroll to buy
-- (paid tools answer action_forbidden, reason reenroll_required).
-- Standard definer hardening on everything new: search_path pg_catalog, public, pg_temp; every relation
-- schema-qualified; EXECUTE revoked from PUBLIC and granted to chorus_app.

-- ---------------------------------------------------------------------------------------------------
-- 1. Requester-seat binding (C1): the seat a payment must come from is the one enrollment PROVED.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE agent_instances
  ADD COLUMN sharednet_member_id text
    CHECK (sharednet_member_id IS NULL OR sharednet_member_id ~ '^i_[A-Za-z0-9]{6,64}$');

CREATE OR REPLACE FUNCTION chorus_enroll_complete(
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

  -- The proven SharedNet seat is recorded on the instance: it is who a payment must come from (0007).
  INSERT INTO public.agent_instances (workspace_id, actor_id, label, sharednet_member_id)
  VALUES (v_e.workspace_id, v_actor, 'sharednet:' || v_e.proof_member_id, v_e.proof_member_id)
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

-- ---------------------------------------------------------------------------------------------------
-- 2. Purchases and verification failures.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE purchases (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id        uuid        NOT NULL,
  room_id             uuid        NOT NULL,
  session_id          uuid,
  board_id            uuid,
  actor_id            uuid        NOT NULL,
  requester_member_id text        NOT NULL CHECK (requester_member_id ~ '^i_[A-Za-z0-9]{6,64}$'),
  service             text        NOT NULL CHECK (service IN ('create_action_board', 'create_tasks')),
  request_id          text        NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  fingerprint         text        NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  amount              integer     NOT NULL CHECK (amount >= 1),
  payee_member_id     text        NOT NULL,
  payee_principal_id  text        NOT NULL,
  memo                text        NOT NULL,
  state               text        NOT NULL CHECK (state IN ('quoted', 'delivered')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  delivered_at        timestamptz,
  txn_id              text,
  response            jsonb,
  CHECK ((state = 'delivered') = (txn_id IS NOT NULL AND response IS NOT NULL AND delivered_at IS NOT NULL)),
  FOREIGN KEY (workspace_id, room_id) REFERENCES rooms (workspace_id, id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions (workspace_id, id),
  FOREIGN KEY (workspace_id, board_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors (workspace_id, id)
);
-- One quote per (buyer, service, request id); one ledger transaction pays for at most one purchase, ever.
CREATE UNIQUE INDEX purchases_request_uniq ON purchases (workspace_id, actor_id, service, request_id);
CREATE UNIQUE INDEX purchases_txn_uniq ON purchases (txn_id);

CREATE TABLE payment_verification_failures (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid        NOT NULL,
  actor_id     uuid        NOT NULL,
  purchase_id  uuid        NOT NULL REFERENCES purchases (id),
  txn_id       text        NOT NULL,
  reason       text        NOT NULL CHECK (reason IN ('payee', 'payer_seat', 'room', 'amount', 'memo', 'age')),
  -- Exactly the ten CreditTransfer fields the ledger returned; never a token.
  observed     jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors (workspace_id, id)
);
CREATE INDEX payment_verification_failures_purchase_idx
  ON payment_verification_failures (workspace_id, purchase_id);

-- A delivered purchase never changes again, and the identity/price of a purchase never changes at all.
CREATE FUNCTION chorus_guard_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'delivered' THEN
    RAISE EXCEPTION 'a delivered purchase is immutable' USING ERRCODE = 'CH010';
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.room_id, NEW.session_id, NEW.board_id, NEW.actor_id,
      NEW.requester_member_id, NEW.service, NEW.request_id, NEW.fingerprint, NEW.amount,
      NEW.payee_member_id, NEW.payee_principal_id, NEW.memo, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.workspace_id, OLD.room_id, OLD.session_id, OLD.board_id, OLD.actor_id,
      OLD.requester_member_id, OLD.service, OLD.request_id, OLD.fingerprint, OLD.amount,
      OLD.payee_member_id, OLD.payee_principal_id, OLD.memo, OLD.created_at) THEN
    RAISE EXCEPTION 'the identity and price of a purchase cannot change' USING ERRCODE = 'CH010';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchases_guard BEFORE UPDATE ON purchases
  FOR EACH ROW EXECUTE FUNCTION chorus_guard_purchase();
CREATE TRIGGER purchases_no_delete BEFORE DELETE ON purchases
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER purchases_no_truncate BEFORE TRUNCATE ON purchases
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER payment_verification_failures_immutable
  BEFORE UPDATE OR DELETE ON payment_verification_failures
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER payment_verification_failures_no_truncate
  BEFORE TRUNCATE ON payment_verification_failures
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();

-- Buyers see and write only their own purchases, inside their own workspace.
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_verification_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_verification_failures FORCE ROW LEVEL SECURITY;
CREATE POLICY buyer ON purchases
  USING (workspace_id = chorus_ws() AND actor_id = chorus_actor())
  WITH CHECK (workspace_id = chorus_ws() AND actor_id = chorus_actor());
CREATE POLICY buyer ON payment_verification_failures
  USING (workspace_id = chorus_ws() AND actor_id = chorus_actor())
  WITH CHECK (workspace_id = chorus_ws() AND actor_id = chorus_actor());

GRANT SELECT, INSERT ON purchases, payment_verification_failures TO chorus_app;
GRANT UPDATE (state, delivered_at, txn_id, response) ON purchases TO chorus_app;

-- ---------------------------------------------------------------------------------------------------
-- 3. The payee seat (C9). chorus_app cannot read sharednet_seats, so this narrow definer returns the
--    seat of ONE room, and only to a live member of that (active) room. The token stays sealed; the
--    caller decrypts it in memory when it needs to call the ledger.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION chorus_arena_payee(p_room uuid)
  RETURNS TABLE (member_id text, principal_id text, token_ciphertext bytea, token_nonce bytea, key_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.member_id, s.principal_id, s.token_ciphertext, s.token_nonce, s.key_id
    FROM public.sharednet_seats s
    JOIN public.rooms r ON r.workspace_id = s.workspace_id AND r.id = s.room_id
    JOIN public.room_members m
      ON m.workspace_id = s.workspace_id AND m.room_id = s.room_id
   WHERE s.room_id = p_room
     AND s.workspace_id = public.chorus_ws()
     AND m.actor_id = public.chorus_actor()
     AND m.removed_at IS NULL
     AND r.activation_state = 'active'
$$;

REVOKE ALL ON FUNCTION chorus_arena_payee(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chorus_arena_payee(uuid) TO chorus_app;
