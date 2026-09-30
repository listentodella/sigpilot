/**
 * Product rename migration: PXLogic Studio → SigPilot.
 *
 * Frontend persistence keys moved from the `pxlogic.*` namespace to `sigpilot.*`.
 * `migrateLegacyKey` copies a legacy value onto the current key on first access and
 * removes the legacy entry, so existing preferences, extension lists and screenshot
 * settings survive the rename instead of silently resetting to defaults.
 *
 * Migration is intentionally tolerant: a storage implementation without `removeItem`,
 * or one that throws (private browsing, disabled storage), still reads correctly —
 * the current key simply starts empty.
 */
export interface LegacyMigratableStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Current key prefix. Legacy keys use `pxlogic`. */
export const STORAGE_NAMESPACE = "sigpilot";
export const LEGACY_STORAGE_NAMESPACE = "pxlogic";

export function migrateLegacyKey(
  storage: LegacyMigratableStorage | null | undefined,
  currentKey: string,
  legacyKey: string,
): void {
  if (!storage) return;
  try {
    const legacyValue = storage.getItem(legacyKey);
    if (legacyValue === null) return;
    if (storage.getItem(currentKey) === null) {
      storage.setItem(currentKey, legacyValue);
    }
    storage.removeItem?.(legacyKey);
  } catch {
    // Best-effort: the current key starts empty when migration is impossible.
  }
}
