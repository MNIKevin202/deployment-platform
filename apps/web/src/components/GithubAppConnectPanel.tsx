import { useState } from "react";
import type { GithubAppInstallation } from "../types/api";
import StatusBadge from "./StatusBadge";
import ConfirmationDialog from "./ConfirmationDialog";

interface GithubAppConnectPanelProps {
  configured: boolean;
  missing: string[];
  installations: GithubAppInstallation[];
  repositoryCount: number | null;
  onDisconnected: () => void;
  onRefreshRepositories: () => void;
  refreshing: boolean;
}

function manageAccessUrl(installation: GithubAppInstallation): string {
  return installation.targetType === "Organization"
    ? `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.installationId}`
    : `https://github.com/settings/installations/${installation.installationId}`;
}

/**
 * The primary "Connect GitHub" experience — a GitHub App installation,
 * automated end to end (redirect, install/authorize, repository selection,
 * return). The manual personal-access-token flow (GitHubSettingsPanel)
 * remains available but is no longer the first thing an operator sees; see
 * RepositoriesPage.tsx, which renders this above the collapsed "Advanced"
 * section.
 */
export default function GithubAppConnectPanel({
  configured,
  missing,
  installations,
  repositoryCount,
  onDisconnected,
  onRefreshRepositories,
  refreshing
}: GithubAppConnectPanelProps) {
  const [disconnectTarget, setDisconnectTarget] = useState<GithubAppInstallation | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState("");

  const confirmDisconnect = async () => {
    if (!disconnectTarget) return;

    try {
      setDisconnecting(true);
      setDisconnectError("");

      const response = await fetch("/api/github/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId: disconnectTarget.installationId })
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || "Unable to disconnect");
      }

      setDisconnectTarget(null);
      onDisconnected();
    } catch (error) {
      setDisconnectError(error instanceof Error ? error.message : "Unable to disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  if (!configured) {
    return (
      <div className="env-scope-block">
        <div className="env-scope-heading">
          <h3>GitHub Integration</h3>
          <StatusBadge label="Not configured" tone="neutral" />
        </div>
        <p className="section-description">
          The GitHub App has not been configured on this server yet. An operator needs to register a
          GitHub App and set {missing.length > 0 ? missing.join(", ") : "the required environment variables"} before
          Connect GitHub is available. The advanced personal-access-token option below still works in
          the meantime.
        </p>
      </div>
    );
  }

  if (installations.length === 0) {
    return (
      <div className="env-scope-block">
        <div className="env-scope-heading">
          <h3>GitHub Integration</h3>
          <StatusBadge label="Not connected" tone="neutral" />
        </div>
        <p className="section-description">
          Authorize selected repositories through GitHub. No password or manual token is required.
        </p>
        <div className="form-actions form-actions-start">
          <a className="primary-button" href="/api/github/connect">
            Connect GitHub
          </a>
        </div>
      </div>
    );
  }

  const installation = installations[0]!;

  return (
    <div className="env-scope-block">
      <div className="env-scope-heading">
        <h3>GitHub Integration</h3>
        <StatusBadge label="Connected" tone="positive" />
      </div>

      {disconnectError && <div className="error-banner">{disconnectError}</div>}

      <dl className="wizard-review-grid">
        <div>
          <dt>Connected account</dt>
          <dd>{installation.accountLogin}</dd>
        </div>
        <div>
          <dt>Installation</dt>
          <dd>#{installation.installationId}</dd>
        </div>
        <div>
          <dt>Repository access</dt>
          <dd>
            {installation.repositorySelection === "all" ? "All repositories" : "Selected repositories"}
            {repositoryCount !== null ? ` (${repositoryCount} available)` : ""}
          </dd>
        </div>
      </dl>

      <div className="form-actions form-actions-start">
        <button
          className="secondary-button"
          type="button"
          onClick={onRefreshRepositories}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing..." : "Refresh repositories"}
        </button>
        <a className="secondary-button" href={manageAccessUrl(installation)} target="_blank" rel="noreferrer">
          Manage access on GitHub
        </a>
        <button className="danger-button" type="button" onClick={() => setDisconnectTarget(installation)}>
          Disconnect
        </button>
      </div>

      <ConfirmationDialog
        open={disconnectTarget !== null}
        title="Disconnect GitHub?"
        message={
          <p>
            This removes the platform's local record of installation #{disconnectTarget?.installationId}. The
            GitHub App itself stays installed — to fully remove it or change its repository access,
            use <strong>Manage access on GitHub</strong> instead.
          </p>
        }
        confirmLabel="Disconnect"
        danger
        confirming={disconnecting}
        onConfirm={() => void confirmDisconnect()}
        onCancel={() => setDisconnectTarget(null)}
      />
    </div>
  );
}
