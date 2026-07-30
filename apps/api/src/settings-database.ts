import type { DatabaseSync } from "node:sqlite";

/**
 * Key-value access to platform_settings. Values are stored as text; callers
 * that need structured data JSON-encode it themselves. Reads return null for
 * an absent key so callers can fall back to a default or an env value.
 */
export function createSettingsRepository(db: DatabaseSync) {
  function getSetting(key: string): string | null {
    const row = db
      .prepare("SELECT value FROM platform_settings WHERE key = ?")
      .get(key) as unknown as { value: string } | undefined;
    return row ? row.value : null;
  }

  function setSetting(key: string, value: string): void {
    db.prepare(
      `
        INSERT INTO platform_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `
    ).run(key, value);
  }

  function deleteSetting(key: string): void {
    db.prepare("DELETE FROM platform_settings WHERE key = ?").run(key);
  }

  /** Convenience typed accessors for JSON-encoded settings. */
  function getJsonSetting<T>(key: string): T | null {
    const raw = getSetting(key);
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  function setJsonSetting(key: string, value: unknown): void {
    setSetting(key, JSON.stringify(value));
  }

  return {
    getSetting,
    setSetting,
    deleteSetting,
    getJsonSetting,
    setJsonSetting
  };
}

export type SettingsRepository = ReturnType<typeof createSettingsRepository>;
