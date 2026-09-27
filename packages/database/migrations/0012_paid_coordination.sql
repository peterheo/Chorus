-- Paid coordination modes: with billing enabled, raising a session's coordination mode (off → observe,
-- off → assist, observe → assist) is a purchase like the other Arena services. The only schema change is
-- the new service name on purchases; the quote, memo, verification, delivery and immutability rules of
-- 0007 apply unchanged. Additive: RC1-era rows keep their service values.
ALTER TABLE purchases
  DROP CONSTRAINT purchases_service_check,
  ADD CONSTRAINT purchases_service_check
    CHECK (service IN ('create_action_board', 'create_tasks', 'set_coordination_mode'));
