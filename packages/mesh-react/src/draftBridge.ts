/**
 * One-way draft bridge — UI surfaces outside the chat composer (roster,
 * tool list, persona panels) can mutate the composer's draft input via
 * a small singleton. The composer registers a setter on mount; click
 * handlers in sibling panels call `insertIntoDraft` to mutate it.
 *
 * Same pattern as leet's `leetMeshDraftBridge.ts`. Single global slot
 * by design — the demo has one chat composer; supporting multiple
 * composers wasn't a goal in leet either.
 */

export type DraftMutator = (current: string) => string;

let currentSetter: ((mutator: DraftMutator) => void) | null = null;

/**
 * The composer calls this on mount with a setter that mutates its
 * draft state, and with `null` on unmount.
 */
export function registerDraftSetter(setter: ((m: DraftMutator) => void) | null): void {
  currentSetter = setter;
}

/**
 * Apply `mutator` against the current chat draft. Silent no-op if no
 * composer is mounted.
 */
export function insertIntoDraft(mutator: DraftMutator): void {
  if (currentSetter) currentSetter(mutator);
}
