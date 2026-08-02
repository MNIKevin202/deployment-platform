import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import AuthGate from "./AuthGate.tsx";
import { DeployProgressProvider } from "./lib/deployProgress.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>
      <DeployProgressProvider>
        <App />
      </DeployProgressProvider>
    </AuthGate>
  </StrictMode>
);
