import type { ReactNode } from "react";

interface NoticeProps {
  kind: "error" | "success";
  children: ReactNode;
}

export default function Notice({ kind, children }: NoticeProps) {
  return (
    <div className={kind === "error" ? "error-banner" : "notice-banner"} role="status">
      {children}
    </div>
  );
}
