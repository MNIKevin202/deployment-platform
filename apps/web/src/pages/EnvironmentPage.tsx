import { useCallback, useEffect, useState } from "react";
import EnvVarDialog from "../components/EnvVarDialog";
import EnvVarTable from "../components/EnvVarTable";
import ConfirmationDialog from "../components/ConfirmationDialog";
import type { ApiError, EnvVarFormValues, MaskedGlobalEnvVar } from "../types/api";

interface GlobalEnvVarsResponse {
  variables: MaskedGlobalEnvVar[];
}

async function readApiError(
  response: Response,
  fallbackMessage: string
): Promise<string> {
  try {
    const result = (await response.json()) as ApiError;
    return result.message || fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

export default function EnvironmentPage() {
  const [variables, setVariables] = useState<MaskedGlobalEnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");

  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<MaskedGlobalEnvVar | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<MaskedGlobalEnvVar | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadVariables = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError("");

      const response = await fetch("/api/environment/global");

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to load global variables")
        );
      }

      const result = (await response.json()) as GlobalEnvVarsResponse;
      setVariables(result.variables);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Unable to load global variables"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVariables();
  }, [loadVariables]);

  const openCreateDialog = () => {
    setEditing(null);
    setDialogError("");
    setShowDialog(true);
  };

  const openEditDialog = (variable: MaskedGlobalEnvVar) => {
    setEditing(variable);
    setDialogError("");
    setShowDialog(true);
  };

  const submitDialog = async (values: EnvVarFormValues) => {
    try {
      setSubmitting(true);
      setDialogError("");

      if (editing) {
        const body: Partial<EnvVarFormValues> = {
          isSecret: values.isSecret,
          enabled: values.enabled
        };

        if (!(editing.isSecret && values.value === "")) {
          body.value = values.value;
        }

        const response = await fetch(`/api/environment/global/${editing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          throw new Error(
            await readApiError(response, "Unable to update variable")
          );
        }

        setNotice(`${editing.key} was updated.`);
      } else {
        const response = await fetch("/api/environment/global", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values)
        });

        if (!response.ok) {
          throw new Error(
            await readApiError(response, "Unable to create variable")
          );
        }

        setNotice(`${values.key} was added.`);
      }

      setShowDialog(false);
      await loadVariables();
    } catch (error) {
      setDialogError(
        error instanceof Error ? error.message : "Unable to save variable"
      );
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) {
      return;
    }

    try {
      setDeleting(true);

      const response = await fetch(
        `/api/environment/global/${deleteTarget.id}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Unable to delete variable")
        );
      }

      setNotice(`${deleteTarget.key} was deleted.`);
      setDeleteTarget(null);
      await loadVariables();
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Unable to delete variable"
      );
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page">
      <section className="page-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Environment</p>
            <h2>Global Variables</h2>
            <p className="section-description">
              Global variables are inherited by every managed app unless an
              app defines its own variable with the same key.
            </p>
          </div>

          <button className="primary-button compact" type="button" onClick={openCreateDialog}>
            Add Variable
          </button>
        </div>

        {notice && <div className="notice-banner">{notice}</div>}
        {loadError && <div className="error-banner">{loadError}</div>}

        {loading ? (
          <div className="empty-state">Loading global variables...</div>
        ) : (
          <EnvVarTable
            variables={variables}
            emptyMessage="No global variables yet. Add one to share it across every managed app."
            onEdit={openEditDialog}
            onDelete={(variable) => setDeleteTarget(variable)}
          />
        )}
      </section>

      <EnvVarDialog
        open={showDialog}
        title={editing ? `Edit ${editing.key}` : "Add Global Variable"}
        keyLocked={editing !== null}
        initialValues={
          editing
            ? {
                key: editing.key,
                value: "",
                isSecret: editing.isSecret,
                enabled: editing.enabled
              }
            : undefined
        }
        secretValuePlaceholder={
          editing?.isSecret
            ? "Leave blank to keep the current secret value"
            : undefined
        }
        submitting={submitting}
        error={dialogError}
        onSubmit={(values) => void submitDialog(values)}
        onCancel={() => setShowDialog(false)}
      />

      <ConfirmationDialog
        open={deleteTarget !== null}
        title={`Delete ${deleteTarget?.key}?`}
        message={
          <p>
            This removes the global variable <strong>{deleteTarget?.key}</strong>{" "}
            from every app that inherits it. Apps must be redeployed for the
            removal to take effect.
          </p>
        }
        confirmLabel="Delete variable"
        danger
        confirming={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
