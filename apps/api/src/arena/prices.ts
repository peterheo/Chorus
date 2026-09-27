/** Arena prices in SharedNet credits (Arena rev 2 C5). A typed constant: there is no runtime config file. */
export const PRICES = {
  room_pulse: 0,
  create_action_board: 8,
  create_tasks_per_task: 1,
  create_tasks_max: 20,
  /** Per enable of a session's coordination mode; raising observe → assist pays the difference. */
  set_coordination_mode_observe: 2,
  set_coordination_mode_assist: 3,
} as const;

/** What one coordination mode costs to hold; `off` is free. */
const MODE_PRICE = {
  off: 0,
  observe: PRICES.set_coordination_mode_observe,
  assist: PRICES.set_coordination_mode_assist,
} as const;

/**
 * The price of changing a session's coordination mode from `current` to `target`: the difference of their
 * prices, floored at 0. Raising pays the difference; the same mode, lowering, and `off` are free.
 */
export function coordinationModePrice(
  current: keyof typeof MODE_PRICE,
  target: keyof typeof MODE_PRICE,
): number {
  return Math.max(0, MODE_PRICE[target] - MODE_PRICE[current]);
}
