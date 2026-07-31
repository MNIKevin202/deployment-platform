export interface TemplateEnvVar {
  key: string;
  /** Fixed default value. Ignored when `generate` is set. */
  value?: string;
  /** Mark the resulting variable as secret. */
  secret?: boolean;
  /** Generate a random value (e.g. a database password) at selection time. */
  generate?: "password";
}

export interface AppTemplate {
  id: string;
  name: string;
  category: "Databases" | "Tools" | "CMS";
  icon: string;
  description: string;
  image: string;
  containerPort: number;
  /** Suggested app name (a valid slug). */
  suggestedName: string;
  env: TemplateEnvVar[];
  /** Container paths that should be backed by a persistent volume. */
  volumes?: string[];
}

/** A random URL-safe secret, e.g. for a generated database password. */
export function generateSecret(length = 24): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/**
 * A curated catalog of common single-container services. Each entry only uses
 * capabilities the Create App wizard already supports (image, port, env vars,
 * and persistent volumes) — no custom entrypoints — so every template deploys
 * cleanly through the normal flow. Add a template by appending to this list.
 */
export const APP_TEMPLATES: AppTemplate[] = [
  {
    id: "postgres",
    name: "PostgreSQL",
    category: "Databases",
    icon: "🐘",
    description: "The popular open-source relational database.",
    image: "postgres:16-alpine",
    containerPort: 5432,
    suggestedName: "postgres",
    env: [
      { key: "POSTGRES_PASSWORD", generate: "password", secret: true },
      { key: "POSTGRES_USER", value: "postgres" },
      { key: "POSTGRES_DB", value: "app" }
    ],
    volumes: ["/var/lib/postgresql/data"]
  },
  {
    id: "mysql",
    name: "MySQL",
    category: "Databases",
    icon: "🐬",
    description: "Widely-used relational database.",
    image: "mysql:8",
    containerPort: 3306,
    suggestedName: "mysql",
    env: [
      { key: "MYSQL_ROOT_PASSWORD", generate: "password", secret: true },
      { key: "MYSQL_DATABASE", value: "app" }
    ],
    volumes: ["/var/lib/mysql"]
  },
  {
    id: "mongodb",
    name: "MongoDB",
    category: "Databases",
    icon: "🍃",
    description: "Document database.",
    image: "mongo:7",
    containerPort: 27017,
    suggestedName: "mongodb",
    env: [
      { key: "MONGO_INITDB_ROOT_USERNAME", value: "root" },
      { key: "MONGO_INITDB_ROOT_PASSWORD", generate: "password", secret: true }
    ],
    volumes: ["/data/db"]
  },
  {
    id: "redis",
    name: "Redis",
    category: "Databases",
    icon: "🧊",
    description: "In-memory key-value store and cache.",
    image: "redis:7-alpine",
    containerPort: 6379,
    suggestedName: "redis",
    env: [],
    volumes: ["/data"]
  },
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    category: "Tools",
    icon: "📈",
    description: "Self-hosted uptime monitoring.",
    image: "louislam/uptime-kuma:1",
    containerPort: 3001,
    suggestedName: "uptime-kuma",
    env: [],
    volumes: ["/app/data"]
  },
  {
    id: "n8n",
    name: "n8n",
    category: "Tools",
    icon: "🔗",
    description: "Workflow automation (self-hosted Zapier alternative).",
    image: "n8nio/n8n",
    containerPort: 5678,
    suggestedName: "n8n",
    env: [],
    volumes: ["/home/node/.n8n"]
  },
  {
    id: "adminer",
    name: "Adminer",
    category: "Tools",
    icon: "🗄️",
    description: "Lightweight database management in a single file.",
    image: "adminer:latest",
    containerPort: 8080,
    suggestedName: "adminer",
    env: []
  },
  {
    id: "vaultwarden",
    name: "Vaultwarden",
    category: "Tools",
    icon: "🔐",
    description: "Lightweight Bitwarden-compatible password manager server.",
    image: "vaultwarden/server:latest",
    containerPort: 80,
    suggestedName: "vaultwarden",
    env: [],
    volumes: ["/data"]
  }
];
