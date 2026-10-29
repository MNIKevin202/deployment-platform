import { useCallback, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import ConfirmationDialog from "../components/ConfirmationDialog";

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
}

/**
 * A promise-based replacement for `window.confirm`, rendered with the styled
 * {@link ConfirmationDialog} instead of the browser's native dialog. Returns
 * the `confirm()` function (resolves true/false) and the dialog element to
 * render once anywhere in the tree. Behaviour mirrors `window.confirm`:
 * resolve `true` on confirm, `false` on cancel or backdrop dismiss.
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactElement] {
  const [state, setState] = useState<ConfirmState | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    setState({ ...options, open: true });
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setState(null);
  }, []);

  const dialog = (
    <ConfirmationDialog
      open={Boolean(state?.open)}
      title={state?.title ?? ""}
      message={state?.message ?? ""}
      confirmLabel={state?.confirmLabel}
      cancelLabel={state?.cancelLabel}
      danger={state?.danger}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return [confirm, dialog];
}
