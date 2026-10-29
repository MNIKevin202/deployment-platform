import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../migrations/index.js";
import type { PlatformFacts } from "../migration/facts.js";
import type { ReadOnlyDockerClient } from "../migration/probes.js";
import { encryptSecret } from "../services/crypto-service.js";
import { makeFacts, makeTempDir } from "./migration-fixtures.js";

/**
 * A synthetic installation: a real SQLite database built by the REAL migrations
 * and populated from `PlatformFacts`, plus a fake Docker daemon that RECORDS every
 * call. No real server, credentials or application data is involved.
 */

export const GITHUB_TOKEN = "ghp_synthetic_token_value_0123456789";

export function makeKey(): Buffer {
  return randomBytes(32);
}

export function buildSyntheticDatabase(
  facts: PlatformFacts = makeFacts(),
  key: Buffer = makeKey(),
  directory: string = makeTempDir("cfmig-db-")
): { path: string; key: Buffer } {
  const path = join(directory, "deployment-platform.sqlite");
  const db = new DatabaseSync(path);
  runMigrations(db);

  const run = (sql: string, ...params: Array<string | number | null>): void => {
    db.prepare(sql).run(...params);
  };

  for (const app of facts.apps) {
    run(
      `INSERT INTO apps (id, name, container_name, image, container_port, domain, internal_only,
                         desired_status, restart_policy, memory_limit_mb, cpu_limit)
       VALUES (?, ?, ?, ?, 80, ?, ?, ?, ?, ?, ?)`,
      app.id,
      app.name,
      app.containerName,
      app.image,
      app.domain,
      app.internalOnly ? 1 : 0,
      app.desiredStatus,
      app.restartPolicy,
      app.memoryLimitMb,
      app.cpuLimit
    );
    for (const entry of app.env) {
      run(
        "INSERT INTO app_environment_variables (app_id, key, value, is_secret, enabled) VALUES (?, ?, ?, ?, ?)",
        app.id,
        entry.key,
        entry.value,
        entry.isSecret ? 1 : 0,
        entry.enabled ? 1 : 0
      );
    }
    for (const volume of app.volumes) {
      run(
        "INSERT INTO app_volumes (app_id, volume_name, container_path, read_only) VALUES (?, ?, ?, ?)",
        app.id,
        volume.volumeName,
        volume.containerPath,
        volume.readOnly ? 1 : 0
      );
    }
    for (const port of app.publishedPorts) {
      run(
        "INSERT INTO app_published_ports (app_id, host_port, container_port, protocol) VALUES (?, ?, ?, ?)",
        app.id,
        port.hostPort,
        port.containerPort,
        port.protocol
      );
    }
    for (const job of app.cronJobs) {
      run(
        "INSERT INTO cron_jobs (app_id, name, cron_expression, command, enabled) VALUES (?, ?, ?, ?, ?)",
        app.id,
        job.name,
        job.cronExpression,
        job.command,
        job.enabled ? 1 : 0
      );
    }
    if (app.source) {
      run(
        `INSERT INTO app_sources (app_id, provider, repository_owner, repository_name, branch, deployment_mode, auto_deploy)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        app.id,
        app.source.provider,
        app.source.repositoryOwner,
        app.source.repositoryName,
        app.source.branch,
        app.source.deploymentMode,
        app.source.autoDeploy ? 1 : 0
      );
    }
    for (const deployment of app.deployments) {
      run(
        "INSERT INTO app_deployments (app_id, version, image_tag, source_kind, is_current) VALUES (?, ?, ?, ?, ?)",
        app.id,
        deployment.version,
        deployment.imageTag,
        deployment.sourceKind,
        deployment.isCurrent ? 1 : 0
      );
    }
    if (app.healthCheck) {
      run("INSERT INTO app_health_checks (app_id, enabled) VALUES (?, ?)", app.id, app.healthCheck.enabled ? 1 : 0);
    }
  }

  for (const entry of facts.globalEnv) {
    run(
      "INSERT INTO global_environment_variables (key, value, is_secret, enabled) VALUES (?, ?, ?, ?)",
      entry.key,
      entry.value,
      entry.isSecret ? 1 : 0,
      entry.enabled ? 1 : 0
    );
  }
  for (const connection of facts.databaseConnections) {
    run(
      "INSERT INTO database_connections (name, kind, connection_string, env_key) VALUES (?, ?, ?, ?)",
      connection.name,
      connection.kind,
      "mongodb+srv://placeholder.example.test/x",
      connection.envKey
    );
  }
  for (const provider of facts.credentialProviders) {
    run(
      "INSERT INTO provider_credentials (provider, encrypted_payload) VALUES (?, ?)",
      provider,
      encryptSecret(key, GITHUB_TOKEN)
    );
  }
  for (const appId of facts.activeDeploymentLockAppIds) {
    run("INSERT INTO github_deployment_locks (app_id, started_at) VALUES (?, ?)", appId, new Date().toISOString());
  }
  if (facts.lastUpdate) {
    run(
      `INSERT INTO platform_update_history (from_version, to_version, channel, policy, trigger, started_at, finished_at, result)
       VALUES ('1.8.0', ?, 'stable', 'notify_only', 'manual', ?, ?, ?)`,
      facts.lastUpdate.toVersion,
      new Date().toISOString(),
      facts.lastUpdate.finishedAt,
      facts.lastUpdate.result
    );
  }

  db.close();

  return { path, key };
}

// ----------------------------------------------------------------- fake docker ----

export interface FakeDockerOptions {
  /** App container names that do not exist. */
  missingContainers?: string[];
  /** App container names that exist but are stopped. */
  stoppedContainers?: string[];
  privileged?: string[];
  bindMounts?: Record<string, string>;
  /** Volume names that do not exist in Docker. */
  missingVolumes?: string[];
  /** Local image tags that do not exist. */
  missingImages?: string[];
  /** Volume name -> bytes (default sizes otherwise). */
  volumeSizes?: Record<string, number>;
  failInfo?: boolean;
  failDf?: boolean;
  arch?: string;
  /** Extra containers/volumes/images already on this daemon (to create conflicts). */
  extraContainers?: Array<{ name: string; labels?: Record<string, string> }>;
  extraVolumes?: Array<{ name: string; labels?: Record<string, string> }>;
  extraImages?: Array<{ tag: string; id?: string }>;
}

export const MIB = 1024 * 1024;

export class FakeDocker implements ReadOnlyDockerClient {
  readonly calls: string[] = [];

  constructor(
    private readonly facts: PlatformFacts,
    private readonly options: FakeDockerOptions = {}
  ) {}

  private record(name: string): void {
    this.calls.push(name);
  }

  private allImageTags(): string[] {
    const missing = new Set(this.options.missingImages ?? []);
    const tags = new Set<string>();

    for (const app of this.facts.apps) {
      tags.add(app.image);
      for (const deployment of app.deployments) {
        tags.add(deployment.imageTag);
      }
    }
    for (const extra of this.options.extraImages ?? []) {
      tags.add(extra.tag);
    }

    return [...tags].filter((tag) => !missing.has(tag));
  }

  async info(): Promise<unknown> {
    this.record("info");
    if (this.options.failInfo) {
      throw new Error("connect ENOENT /var/run/docker.sock");
    }

    return {
      ID: "SYNTHETIC-DAEMON-ID-0001",
      Name: "synthetic-host",
      ServerVersion: "27.0.0",
      OperatingSystem: "Synthetic Linux",
      OSType: "linux",
      Architecture: this.options.arch ?? "x86_64",
      KernelVersion: "6.8.0",
      MemTotal: 16 * 1024 * MIB,
      NCPU: 4,
      DockerRootDir: "/var/lib/docker"
    };
  }

  async version(): Promise<unknown> {
    this.record("version");

    return { Version: "27.0.0", ApiVersion: "1.46", Os: "linux", Arch: "amd64" };
  }

  async listContainers(): Promise<unknown[]> {
    this.record("listContainers");
    const missing = new Set(this.options.missingContainers ?? []);

    return [
      ...this.facts.apps
        .filter((app) => !missing.has(app.containerName))
        .map((app) => ({
          Id: `c${app.id}`,
          Names: [`/${app.containerName}`],
          Image: app.image,
          State: (this.options.stoppedContainers ?? []).includes(app.containerName) ? "exited" : "running",
          Labels: { "com.deployment-platform.managed": "true" },
          Mounts: [],
          Ports: []
        })),
      ...(this.options.extraContainers ?? []).map((extra, index) => ({
        Id: `x${index}`,
        Names: [`/${extra.name}`],
        Image: "other:latest",
        State: "running",
        Labels: extra.labels ?? {},
        Mounts: [],
        Ports: []
      }))
    ];
  }

  getContainer(id: string): { inspect(): Promise<unknown> } {
    return {
      inspect: async () => {
        this.record(`inspect:${id}`);
        const app = this.facts.apps.find((candidate) => candidate.containerName === id);

        if (!app || (this.options.missingContainers ?? []).includes(id)) {
          throw Object.assign(new Error(`No such container: ${id}`), { statusCode: 404 });
        }

        const running = !(this.options.stoppedContainers ?? []).includes(id);
        const mounts: unknown[] = app.volumes.map((volume) => ({
          Type: "volume",
          Name: volume.volumeName,
          Destination: volume.containerPath,
          RW: !volume.readOnly
        }));
        const bind = this.options.bindMounts?.[id];
        if (bind) {
          mounts.push({ Type: "bind", Source: "/srv/host-path", Destination: bind, RW: true });
        }

        return {
          Id: `c${app.id}`,
          Name: `/${app.containerName}`,
          Config: { Image: app.image, Labels: { "com.deployment-platform.managed": "true" } },
          State: { Status: running ? "running" : "exited", Running: running, ExitCode: 0, OOMKilled: false },
          HostConfig: {
            Privileged: (this.options.privileged ?? []).includes(id),
            NetworkMode: "deployment-apps",
            RestartPolicy: { Name: app.restartPolicy },
            PortBindings: Object.fromEntries(
              app.publishedPorts.map((port) => [`${port.containerPort}/${port.protocol}`, [{ HostPort: String(port.hostPort) }]])
            )
          },
          Mounts: mounts,
          NetworkSettings: { Networks: { "deployment-apps": {} } }
        };
      }
    };
  }

  async listVolumes(): Promise<{ Volumes: unknown[] }> {
    this.record("listVolumes");
    const missing = new Set(this.options.missingVolumes ?? []);

    return {
      Volumes: [
        ...this.facts.apps
          .flatMap((app) => app.volumes)
          .filter((volume) => !missing.has(volume.volumeName))
          .map((volume) => ({ Name: volume.volumeName, Driver: "local", Labels: { "com.deployment-platform.managed": "true" } })),
        ...(this.options.extraVolumes ?? []).map((extra) => ({ Name: extra.name, Driver: "local", Labels: extra.labels ?? {} }))
      ]
    };
  }

  async listImages(): Promise<unknown[]> {
    this.record("listImages");
    const extra = new Map((this.options.extraImages ?? []).map((image) => [image.tag, image.id]));

    return this.allImageTags().map((tag, index) => ({
      Id: extra.get(tag) ?? `sha256:image${index}`,
      RepoTags: [tag],
      Size: 100 * MIB
    }));
  }

  getImage(name: string): { inspect(): Promise<unknown> } {
    return {
      inspect: async () => {
        this.record(`inspectImage:${name}`);
        if (!this.allImageTags().includes(name)) {
          throw Object.assign(new Error("No such image"), { statusCode: 404 });
        }

        return { Id: "sha256:x", RepoTags: [name], Size: 100 * MIB, Architecture: "amd64", Os: "linux" };
      }
    };
  }

  async df(): Promise<unknown> {
    this.record("df");
    if (this.options.failDf) {
      throw new Error("df failed");
    }

    return {
      Volumes: this.facts.apps.flatMap((app) =>
        app.volumes.map((volume) => ({
          Name: volume.volumeName,
          UsageData: { Size: this.options.volumeSizes?.[volume.volumeName] ?? (volume.volumeName === "db-data" ? 50 * MIB : 5 * MIB), RefCount: 1 }
        }))
      ),
      Images: this.allImageTags().map((tag) => ({ RepoTags: [tag], Size: 100 * MIB }))
    };
  }
}

/** The complete set of Docker operations preflight is permitted to perform. */
export const ALLOWED_DOCKER_CALLS = /^(info|version|listContainers|listVolumes|listImages|df|inspect:.+|inspectImage:.+)$/;
