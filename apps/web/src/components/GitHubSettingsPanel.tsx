import { useCallback, useEffect, useState } from "react";
import type {
  ApiError,
  GithubConnectionInfo,
  SourceAccount,
  TestGithubTokenResponse
} from "../types/api";
import StatusBadge from "./StatusBadge";
import ConfirmationDialog from "./ConfirmationDialog";

interface GitHubSettingsPanelProps {
  onConnectionChanged?: () => void;
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string | null): string {
  if (!value) {
    return "Never";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

const CREDENTIAL_STATUS_LABELS: Record<string, string> = {
  "not-configured": "Not connected",
  connected: "Connected",
  "encryption-key-missing": "Server setup required",
  "encryption-key-invalid": "Server setup required",
  "credential-unavailable": "Credential unavailable"
};

export default function GitHubSettingsPanel({ onConnectionChanged }: GitHubSettingsPanelProps) {
  const [connection, setConnection] = useState<GithubConnectionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [testedAccount, setTestedAccount] = useState<SourceAccount | null>(null);
  const [testError, setTestError] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");

  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const loadConnection = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError("");

      const response = await fetch("/api/integrations/github");

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to load GitHub connection status"));
      }

      const result = (await response.json()) as GithubConnectionInfo;
      setConnection(result);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Unable to load GitHub connection status"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnection();
  }, [loadConnection]);

  // Never store the token anywhere but this component's own in-memory
  // state, and only for as long as the user is actively typing/testing.
  const clearToken = () => setToken("");

  const testConnection = async () => {
    if (!token) {
      return;
    }

    try {
      setTesting(true);
      setTestError("");
      setTestedAccount(null);

      const response = await fetch("/api/integrations/github/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      });

      const result = (await response.json().catch(() => ({}))) as Partial<TestGithubTokenResponse>;

      if (!response.ok || !result.success || !result.account) {
        throw new Error(result.message || "Unable to validate this token");
      }

      setTestedAccount(result.account);
    } catch (error) {
      setTestError(error instanceof Error ? error.message : "Unable to validate this token");
    } finally {
      setTesting(false);
    }
  };

  const saveConnection = async () => {
    if (!token) {
      return;
    }

    try {
      setSaving(true);
      setSaveError("");
      setNotice("");

      const response = await fetch("/api/integrations/github", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      });

      const result = (await response.json().catch(() => ({}))) as Partial<GithubConnectionInfo>;

      if (!response.ok || !result.connected) {
        throw new Error(result.message || "Unable to save this token");
      }

      setNotice(`Connected to GitHub as ${result.username ?? "unknown user"}.`);
      clearToken();
      setTestedAccount(null);
      await loadConnection();
      onConnectionChanged?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save this token");
    } finally {
      setSaving(false);
    }
  };

  const confirmDisconnect = async () => {
    try {
      setDisconnecting(true);

      const response = await fetch("/api/integrations/github", { method: "DELETE" });

      if (!response.ok) {
        throw new Error(await readApiError(response, "Unable to disconnect GitHub"));
      }

      setShowDisconnectConfirm(false);
      setNotice("GitHub disconnected. Linked repositories are not deleted, but will show as needing a connection.");
      await loadConnection();
      onConnectionChanged?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to disconnect GitHub");
      setShowDisconnectConfirm(false);
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading && !connection) {
    return <div className="empty-state">Loading GitHub connection...</div>;
  }

  if (loadError) {
    return <div className="error-banner">{loadError}</div>;
  }

  if (!connection) {
    return null;
  }

  const statusTone =
    connection.credentialStatus === "connected"
      ? "positive"
      : connection.credentialStatus === "not-configured"
        ? "neutral"
        : "negative";

  return (
    <div className="env-scope-block">
      <div className="env-scope-heading">
        <h3>GitHub Integration</h3>
        <StatusBadge
          label={CREDENTIAL_STATUS_LABELS[connection.credentialStatus] ?? connection.credentialStatus}
          tone={statusTone}
        />
      </div>

      <p className="section-description">
        Paste a fine-grained GitHub token to let this server read your repositories. The token only
        needs <strong>Contents: Read-only</strong> and <strong>Metadata: Read-only</strong>, and it is
        stored encrypted after saving.
      </p>

      <div className="form-actions form-actions-start">
        <a
          className="secondary-button compact"
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noreferrer"
        >
          Create fine-grained token on GitHub
        </a>
      </div>

      {notice && <div className="notice-banner">{notice}</div>}
      {saveError && <div className="error-banner">{saveError}</div>}

      {connection.setupRequired && (
        <div className="warning-banner">
          The server is missing a valid CREDENTIAL_ENCRYPTION_KEY. An operator must configure it
          before a GitHub token can be saved.
        </div>
      )}

      {connection.connected && (
        <dl className="wizard-review-grid">
          <div>
            <dt>Connected as</dt>
            <dd>{connection.username ?? "Unknown"}</dd>
          </div>
          <div>
            <dt>Last validated</dt>
            <dd>{formatDate(connection.lastValidatedAt)}</dd>
          </div>
          <div>
            <dt>Permissions</dt>
            <dd>{connection.permissions?.length ? connection.permissions.join(", ") : "Not reported"}</dd>
          </div>
        </dl>
      )}

      <div className="github-token-section">
        <label>
          <span>{connection.connected ? "Replace token" : "GitHub token"}</span>
          <input
            type="password"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setTestedAccount(null);
              setTestError("");
            }}
            placeholder="github_pat_..."
            autoComplete="off"
            disabled={connection.setupRequired}
          />
          <small>
            Never shown again after saving. Stored encrypted — this field always starts empty, even
            when a token is already connected.
          </small>
        </label>

        {testError && <div className="error-banner">{testError}</div>}
        {testedAccount && (
          <div className="notice-banner">
            Token is valid for GitHub user <strong>{testedAccount.username}</strong>.
          </div>
        )}

        <div className="form-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => void testConnection()}
            disabled={!token || testing || saving || connection.setupRequired}
          >
            {testing ? "Testing..." : connection.connected ? "Test Again" : "Test Token"}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => void saveConnection()}
            disabled={!token || saving || testing || connection.setupRequired}
          >
            {saving ? "Saving..." : connection.connected ? "Replace Token" : "Save Token"}
          </button>
          {connection.connected && (
            <button
              className="danger-button"
              type="button"
              onClick={() => setShowDisconnectConfirm(true)}
              disabled={saving}
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      <ConfirmationDialog
        open={showDisconnectConfirm}
        title="Disconnect GitHub?"
        message={
          <p>
            This removes the stored GitHub credential. Apps with a linked repository are{" "}
            <strong>not</strong> unlinked, but will show as needing a GitHub connection until you
            reconnect.
          </p>
        }
        confirmLabel="Disconnect"
        danger
        confirming={disconnecting}
        onConfirm={() => void confirmDisconnect()}
        onCancel={() => setShowDisconnectConfirm(false)}
      />
    </div>
  );
}
