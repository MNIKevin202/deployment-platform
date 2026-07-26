export type BuildBriefRuntime =
  | "nodejs"
  | "python"
  | "php"
  | "static"
  | "docker"
  | "other";

const RUNTIME_LABELS: Record<BuildBriefRuntime, string> = {
  nodejs: "Node.js",
  python: "Python",
  php: "PHP",
  static: "Static site",
  docker: "Generic / pre-built Docker image",
  other: "Other / unspecified runtime"
};

export interface BuildBriefEnvVar {
  key: string;
  isSecret: boolean;
}

export interface BuildBriefStorageMount {
  containerPath: string;
  readOnly: boolean;
}

export interface BuildBriefInput {
  appName: string;
  domain: string;
  /** Empty/omitted means no image was decided yet — Claude should propose a Dockerfile. */
  image?: string;
  containerPort: number;
  runtime: BuildBriefRuntime;
  description?: string;
  startCommand?: string;
  healthCheckPath?: string;
  /** Keys and secret flags only — values are never accepted by this function. */
  environmentVariables: BuildBriefEnvVar[];
  storageMounts: BuildBriefStorageMount[];
}

function formatEnvVarList(vars: BuildBriefEnvVar[]): string {
  if (vars.length === 0) {
    return "(No environment variables are configured yet. If the application needs any, list them here so they can be added before deployment.)";
  }

  return vars
    .map((envVar) =>
      envVar.isSecret
        ? `- ${envVar.key} — secret. The platform injects the real value at container start; never hard-code it or log it.`
        : `- ${envVar.key} — regular value, read from the environment at runtime.`
    )
    .join("\n");
}

function formatStorageList(mounts: BuildBriefStorageMount[]): string {
  if (mounts.length === 0) {
    return "(No persistent storage is configured. If the application needs to retain data across restarts or redeploys, list the paths it needs here.)";
  }

  return mounts
    .map(
      (mount) =>
        `- ${mount.containerPath} (${mount.readOnly ? "read-only" : "read-write"})`
    )
    .join("\n");
}

/**
 * Deterministically builds a copy-pasteable brief for Claude (or any
 * assistant) to prepare an application for this platform. Pure template
 * assembly from already-validated, secret-value-free input — no AI call,
 * no network access, same output for the same input every time.
 */
export function generateBuildBrief(input: BuildBriefInput): string {
  const runtimeLabel = RUNTIME_LABELS[input.runtime];
  const hasImage = Boolean(input.image && input.image.trim().length > 0);

  const dockerfileGuidance = hasImage
    ? `An existing image is planned: \`${input.image}\`. If this image doesn't already meet the requirements below, either adjust the image or produce a Dockerfile that does.`
    : "No image has been chosen yet — please produce a production-ready Dockerfile for this application.";

  const sections: string[] = [];

  sections.push(
    [
      "# Deployment preparation brief",
      "",
      "This is a PREPARATION request, not a deployment notification — the application has NOT been deployed yet. Please prepare the application's code, Dockerfile, and configuration so it is ready to hand off to a self-hosted deployment platform.",
      "",
      `App name: ${input.appName}`,
      `Planned public URL: https://${input.domain}`,
      `Runtime/framework selected in the deployment wizard: ${runtimeLabel}`
    ].join("\n")
  );

  if (input.description && input.description.trim().length > 0) {
    sections.push(
      ["## Notes from the person deploying this app", "", input.description.trim()].join(
        "\n"
      )
    );
  }

  sections.push(
    [
      "## Configuration the platform already provides — do not implement these yourself",
      "",
      "- Public HTTPS and TLS certificates are obtained, renewed, and terminated automatically by the platform's reverse proxy. The application must NOT attempt to manage TLS, certificates, or HTTPS itself.",
      `- Domain routing to this app is automatic once deployed, at https://${input.domain}. No in-app routing/domain configuration is needed.`,
      "- Persistent storage is provided through Docker named volumes, mounted at fixed container paths chosen during deployment (listed below). The platform creates and manages these volumes — the application does not need to create or configure them.",
      "- Environment variables (listed below) are injected into the container's environment by the platform at container start.",
      "- There are no host bind mounts and no Docker socket access available to the application container, and none should be assumed or required.",
      "- Networking, container naming, and restart policy are managed by the platform."
    ].join("\n")
  );

  sections.push(
    [
      "## What you need to prepare",
      "",
      `- ${dockerfileGuidance}`,
      `- The application MUST bind to 0.0.0.0 (not localhost or 127.0.0.1) on port ${input.containerPort}. The platform forwards external traffic to this internal container port — if the app only listens on localhost, it will be unreachable.`,
      input.startCommand
        ? `- Intended startup command (confirm this matches the Dockerfile's ENTRYPOINT/CMD): \`${input.startCommand}\``
        : "- Define a clear, single startup command for the container (Dockerfile ENTRYPOINT/CMD).",
      input.healthCheckPath
        ? `- Expose a health check endpoint at ${input.healthCheckPath} that returns HTTP 200 once the app is ready to serve traffic.`
        : "- Consider adding a lightweight health check endpoint (e.g. GET /health returning HTTP 200) if the application doesn't already have one.",
      "- Include a .dockerignore file excluding unnecessary build context (e.g. node_modules, .git, local .env files, build artifacts) if producing or updating a Dockerfile.",
      "- Write application logs to stdout/stderr, not only to log files inside the container.",
      "- Handle SIGTERM by shutting down gracefully within a short grace period; the platform stops containers with a timeout before force-killing them.",
      "- Do not hard-code any production secret values anywhere in the source code, Dockerfile, or committed configuration — read them from the environment variables listed below.",
      "- Do not rely on any file surviving anywhere in the container filesystem except the persistent storage paths listed below — everything else is disposable and is lost on redeploy."
    ].join("\n")
  );

  sections.push(
    [
      "## Required environment variables",
      "",
      "Read these from the environment at runtime — do not hard-code values, and do not print secret values to logs:",
      "",
      formatEnvVarList(input.environmentVariables)
    ].join("\n")
  );

  sections.push(
    [
      "## Persistent storage paths",
      "",
      "Data written to these paths survives container recreation and redeployment. Any data the application needs to keep MUST be written only to these paths — data written anywhere else in the container filesystem is lost on the next redeploy:",
      "",
      formatStorageList(input.storageMounts)
    ].join("\n")
  );

  sections.push(
    [
      "## Please confirm with the user before proceeding",
      "",
      "- The exact runtime version, framework, and build tooling in use — this brief only states the general category selected in the deployment wizard.",
      "- Whether any environment variables are required beyond the list above.",
      "- Whether the persistent storage paths listed above match what the application actually needs to write to, and whether any listed path is missing.",
      "- Any external services (databases, queues, third-party APIs) the app depends on that aren't already reflected in the environment variables above."
    ].join("\n")
  );

  return sections.join("\n\n");
}
