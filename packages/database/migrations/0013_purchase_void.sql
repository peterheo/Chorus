-- Void and refund a paid purchase that was never delivered. A delivery can be refused after its payment
-- verified (the quote-vs-delivery race: the session changed, the quote no longer holds). The purchase then
-- stays quoted so the buyer can retry with the same payment; when retrying cannot help, the buyer voids it
-- instead and Chorus returns the credits from the room's payee seat. A voided purchase is final: its txn is
-- recorded on it (so the purchases_txn_uniq index keeps that payment from buying anything else) and it can
-- never be delivered. Additive: existing rows keep their states.
ALTER TABLE purchases
  DROP CONSTRAINT purchases_state_check,
  ADD CONSTRAINT purchases_state_check CHECK (state IN ('quoted', 'delivered', 'voided')),
  ADD CONSTRAINT purchases_voided_txn CHECK (state <> 'voided' OR txn_id IS NOT NULL);

CREATE OR REPLACE FUNCTION chorus_guard_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'delivered' THEN
    RAISE EXCEPTION 'a delivered purchase is immutable' USING ERRCODE = 'CH010';
  END IF;
  IF OLD.state = 'voided' THEN
    RAISE EXCEPTION 'a voided purchase is immutable' USING ERRCODE = 'CH010';
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

-- One refund per voided purchase. transfer_key is the SharedNet Idempotency-Key of the refund transfer:
-- every retry reuses it, so however often sending is retried, SharedNet moves the credits at most once.
CREATE TABLE purchase_refunds (
  workspace_id  uuid        NOT NULL,
  purchase_id   uuid        NOT NULL,
  actor_id      uuid        NOT NULL,
  txn_id        text        NOT NULL UNIQUE,
  amount        integer     NOT NULL CHECK (amount >= 1),
  to_member_id  text        NOT NULL CHECK (to_member_id ~ '^i_[A-Za-z0-9]{6,64}$'),
  reason        text        NOT NULL CHECK (reason ~ '^[a-z_]{1,64}$'),
  transfer_key  uuid        NOT NULL DEFAULT gen_random_uuid(),
  refund_txn_id text        CHECK (refund_txn_id ~ '^txn_[A-Za-z0-9]{6,64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  PRIMARY KEY (workspace_id, purchase_id),
  CHECK ((refund_txn_id IS NULL) = (sent_at IS NULL)),
  FOREIGN KEY (workspace_id, purchase_id) REFERENCES purchases (workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES actors (workspace_id, id)
);

-- A refund is recorded as sent once, and nothing else about it ever changes.
CREATE FUNCTION chorus_guard_purchase_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.refund_txn_id IS NOT NULL THEN
    RAISE EXCEPTION 'a sent refund is immutable' USING ERRCODE = 'CH010';
  END IF;
  IF (NEW.workspace_id, NEW.purchase_id, NEW.actor_id, NEW.txn_id, NEW.amount, NEW.to_member_id,
      NEW.reason, NEW.transfer_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.workspace_id, OLD.purchase_id, OLD.actor_id, OLD.txn_id, OLD.amount, OLD.to_member_id,
      OLD.reason, OLD.transfer_key, OLD.created_at) THEN
    RAISE EXCEPTION 'only the sending of a refund can be recorded' USING ERRCODE = 'CH010';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_refunds_guard BEFORE UPDATE ON purchase_refunds
  FOR EACH ROW EXECUTE FUNCTION chorus_guard_purchase_refund();
CREATE TRIGGER purchase_refunds_no_delete BEFORE DELETE ON purchase_refunds
  FOR EACH ROW EXECUTE FUNCTION chorus_reject_mutation();
CREATE TRIGGER purchase_refunds_no_truncate BEFORE TRUNCATE ON purchase_refunds
  FOR EACH STATEMENT EXECUTE FUNCTION chorus_reject_mutation();

ALTER TABLE purchase_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY buyer ON purchase_refunds
  USING (workspace_id = chorus_ws() AND actor_id = chorus_actor())
  WITH CHECK (workspace_id = chorus_ws() AND actor_id = chorus_actor());

GRANT SELECT, INSERT ON purchase_refunds TO chorus_app;
GRANT UPDATE (refund_txn_id, sent_at) ON purchase_refunds TO chorus_app;
