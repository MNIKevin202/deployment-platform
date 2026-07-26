import type { DatabaseSync } from "node:sqlite";

export interface StoredProviderCredential {
  id: number;
  provider: string;
  encryptedPayload: string;
  authenticatedUsername: string | null;
  permissionsJson: string | null;
  lastValidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProviderCredentialRow {
  id: number;
  provider: string;
  encrypted_payload: string;
  authenticated_username: string | null;
  permissions_json: string | null;
  last_validated_at: string | null;
  created_at: string;
  updated_at: string;
}

const CREDENTIAL_COLUMNS = `
  id, provider, encrypted_payload, authenticated_username, permissions_json,
  last_validated_at, created_at, updated_at
`;

function mapCredential(row: ProviderCredentialRow): StoredProviderCredential {
  return {
    id: row.id,
    provider: row.provider,
    encryptedPayload: row.encrypted_payload,
    authenticatedUsername: row.authenticated_username,
    permissionsJson: row.permissions_json,
    lastValidatedAt: row.last_validated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface UpsertProviderCredentialInput {
  provider: string;
  encryptedPayload: string;
  authenticatedUsername: string | null;
  permissionsJson: string | null;
  lastValidatedAt: string | null;
}

export function createCredentialRepository(db: DatabaseSync) {
  function getProviderCredential(provider: string): StoredProviderCredential | null {
    const row = db
      .prepare(`SELECT ${CREDENTIAL_COLUMNS} FROM provider_credentials WHERE provider = ?`)
      .get(provider) as unknown as ProviderCredentialRow | undefined;

    return row ? mapCredential(row) : null;
  }

  /**
   * One credential per provider (enforced by a unique index on `provider`
   * as well) — saving a new token for a provider that already has one
   * replaces it in place rather than accumulating rows.
   */
  function upsertProviderCredential(
    input: UpsertProviderCredentialInput
  ): StoredProviderCredential {
    const existing = getProviderCredential(input.provider);

    if (existing) {
      db.prepare(
        `
          UPDATE provider_credentials
          SET
            encrypted_payload = ?,
            authenticated_username = ?,
            permissions_json = ?,
            last_validated_at = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE provider = ?
        `
      ).run(
        input.encryptedPayload,
        input.authenticatedUsername,
        input.permissionsJson,
        input.lastValidatedAt,
        input.provider
      );
    } else {
      db.prepare(
        `
          INSERT INTO provider_credentials (
            provider, encrypted_payload, authenticated_username,
            permissions_json, last_validated_at
          )
          VALUES (?, ?, ?, ?, ?)
        `
      ).run(
        input.provider,
        input.encryptedPayload,
        input.authenticatedUsername,
        input.permissionsJson,
        input.lastValidatedAt
      );
    }

    const result = getProviderCredential(input.provider);

    if (!result) {
      throw new Error("Provider credential could not be loaded after saving");
    }

    return result;
  }

  function deleteProviderCredential(provider: string): void {
    db.prepare(`DELETE FROM provider_credentials WHERE provider = ?`).run(provider);
  }

  return {
    getProviderCredential,
    upsertProviderCredential,
    deleteProviderCredential
  };
}

export type CredentialRepository = ReturnType<typeof createCredentialRepository>;
