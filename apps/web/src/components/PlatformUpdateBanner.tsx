import { useState } from "react";
import { usePlatformUpdate } from "../lib/usePlatformUpdate";
import UpdateConfirmModal from "./UpdateConfirmModal";

/**
 * The dashboard's platform self-update surface. Tasteful when up to date,
 * noticeable when an update is available, and a live progress view (that
 * survives the API restart during the container swap) once an update runs.
 * All logic lives in usePlatformUpdate; this is presentation only.
 */
export default function PlatformUpdateBanner() {
  const update = usePlatformUpdate();
  const [modalOpen, setModalOpen] = useState(false);

  if (update.loading) {
    return null;
  }

  const confirmAndApply = async () => {
    await update.apply();
    // Close the modal once the apply has been accepted (progress then shows in
    // the banner). If it errored, keep the modal open to show the error.
    if (!update.actionError) {
      setModalOpen(false);
    }
  };

  // --- Active update (or reconnecting through the restart) ---
  if (update.isUpdating) {
    return (
      <section className="update-banner update-banner-progress" aria-live="polite">
        <div className="update-banner-main">
          <span className="update-spinner" aria-hidden="true" />
          <div>
            <p className="update-banner-title">{update.phaseLabel}</p>
            {update.isReconnecting ? (
              <p className="update-banner-sub">The connection will return automatically — please wait.</p>
            ) : (
              update.detail && <p className="update-banner-sub">{update.detail}</p>
            )}
          </div>
        </div>
      </section>
    );
  }

  // --- Terminal outcomes from the most recent run ---
  if (update.outcome === "successful") {
    return (
      <section className="update-banner update-banner-success" role="status">
        <p className="update-banner-title">✓ Updated successfully to {update.currentVersion}</p>
      </section>
    );
  }
  if (update.outcome === "rolled_back") {
    return (
      <section className="update-banner update-banner-warn" role="status">
        <p className="update-banner-title">Update did not complete — previous version restored</p>
        <p className="update-banner-sub">
          ClovaForge automatically rolled back and is running normally on {update.currentVersion}.
          {update.detail ? ` Reason: ${update.detail}.` : ""}
        </p>
        <div className="update-banner-actions">
          <button className="secondary-button" type="button" onClick={update.dismissOutcome}>
            Dismiss
          </button>
        </div>
      </section>
    );
  }
  if (update.outcome === "manual_intervention_required") {
    return (
      <section className="update-banner update-banner-danger" role="alert">
        <p className="update-banner-title">⚠ ClovaForge needs manual recovery</p>
        <p className="update-banner-sub">
          An update could not complete safely and automatic rollback was not possible.
          {update.detail ? ` ${update.detail}.` : ""} Do not start another update — see
          docs/SELF_UPDATE_ARCHITECTURE.md “Emergency manual recovery”.
        </p>
      </section>
    );
  }
  if (update.outcome === "failed") {
    return (
      <section className="update-banner update-banner-warn" role="status">
        <p className="update-banner-title">Update failed before any change was made</p>
        <p className="update-banner-sub">
          ClovaForge is unchanged and running on {update.currentVersion}.
          {update.detail ? ` Reason: ${update.detail}.` : ""}
        </p>
        <div className="update-banner-actions">
          <button className="secondary-button" type="button" onClick={update.dismissOutcome}>
            Dismiss
          </button>
        </div>
      </section>
    );
  }

  // --- Queued for the scheduled timer (bridge unavailable; explicit request kept) ---
  if (update.scheduledQueued) {
    return (
      <section className="update-banner update-banner-available" role="status" aria-live="polite">
        <div className="update-banner-main">
          <span className="update-banner-badge">Queued</span>
          <p className="update-banner-title">
            {update.lastApplyMessage ||
              "Update queued — it will apply automatically on the next scheduled check (within ~15 minutes)."}
          </p>
        </div>
      </section>
    );
  }

  // --- Update available ---
  if (update.updateAvailable) {
    const directlyInstallable = !update.requiresIncrementalUpgrade && update.availableVersion != null;
    return (
      <section className="update-banner update-banner-available">
        <div className="update-banner-main">
          <span className="update-banner-badge">Update</span>
          <div>
            <p className="update-banner-title">ClovaForge {update.availableVersion} is available</p>
            <p className="update-banner-sub">You are on {update.currentVersion}.</p>
          </div>
        </div>
        <div className="update-banner-actions">
          <button className="secondary-button" type="button" onClick={() => void update.check()} disabled={update.checking}>
            {update.checking ? "Checking…" : "Check again"}
          </button>
          {directlyInstallable ? (
            <button
              className="primary-button"
              type="button"
              onClick={() => setModalOpen(true)}
              disabled={!update.updateNowAllowed || update.applying}
            >
              {update.pendingVersion ? "Update queued…" : "Update Now"}
            </button>
          ) : (
            <span className="update-banner-sub">An incremental upgrade is required first.</span>
          )}
        </div>

        <UpdateConfirmModal
          open={modalOpen}
          currentVersion={update.currentVersion}
          newVersion={update.availableVersion ?? ""}
          signedVerified={update.signedVerified}
          compatible={!update.requiresIncrementalUpgrade}
          rollbackSafe={update.rollbackSafe}
          confirming={update.applying}
          error={update.actionError}
          onConfirm={() => void confirmAndApply()}
          onCancel={() => setModalOpen(false)}
        />
      </section>
    );
  }

  // --- Up to date ---
  return (
    <section className="update-banner update-banner-uptodate">
      <p className="update-banner-title">ClovaForge is up to date</p>
      <div className="update-banner-actions">
        <button className="secondary-button" type="button" onClick={() => void update.check()} disabled={update.checking}>
          {update.checking ? "Checking…" : "Check for Updates"}
        </button>
      </div>
      {update.checkFailedReason && <p className="update-banner-sub">Last check: {update.checkFailedReason}</p>}
    </section>
  );
}
