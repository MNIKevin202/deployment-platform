export interface TemplateEnvVar {
  key: string;
  /** Fixed default value. Ignored when `generate` is set. */
  value?: string;
  /** Mark the resulting variable as secret. */
  secret?: boolean;
  /** Generate a random value (e.g. a database password) at selection time. */
  generate?: "password";
}

export type TemplateCategory = "Databases" | "Tools";

export interface AppTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  icon: string;
  /** One-line summary shown on the card. */
  description: string;
  /** Optional longer blurb shown on the template detail view. */
  longDescription?: string;
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
 * and persistent volumes) — no custom entrypoints or host mounts — so every
 * template deploys cleanly through the normal flow. Add one by appending here.
 */
export const APP_TEMPLATES: AppTemplate[] = [
  // ---- Databases ----
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
    id: "mariadb",
    name: "MariaDB",
    category: "Databases",
    icon: "🦭",
    description: "Community-developed MySQL fork.",
    image: "mariadb:11",
    containerPort: 3306,
    suggestedName: "mariadb",
    env: [
      { key: "MARIADB_ROOT_PASSWORD", generate: "password", secret: true },
      { key: "MARIADB_DATABASE", value: "app" }
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
    id: "valkey",
    name: "Valkey",
    category: "Databases",
    icon: "🗝️",
    description: "Open-source Redis fork; drop-in compatible.",
    longDescription:
      "Valkey is a community-driven fork of Redis that stays protocol-compatible, so existing Redis clients work unchanged. A solid choice for caching, queues, and pub/sub.",
    image: "valkey/valkey:8",
    containerPort: 6379,
    suggestedName: "valkey",
    env: [],
    volumes: ["/data"]
  },
  {
    id: "memcached",
    name: "Memcached",
    category: "Databases",
    icon: "💾",
    description: "High-performance distributed memory cache.",
    image: "memcached:alpine",
    containerPort: 11211,
    suggestedName: "memcached",
    env: []
  },
  {
    id: "couchdb",
    name: "CouchDB",
    category: "Databases",
    icon: "🛋️",
    description: "Document database with an HTTP/JSON API.",
    longDescription:
      "Apache CouchDB stores documents as JSON and speaks HTTP natively, with multi-master replication built in. The admin credentials below are created on first boot.",
    image: "couchdb:3",
    containerPort: 5984,
    suggestedName: "couchdb",
    env: [
      { key: "COUCHDB_USER", value: "admin" },
      { key: "COUCHDB_PASSWORD", generate: "password", secret: true }
    ],
    volumes: ["/opt/couchdb/data"]
  },
  {
    id: "influxdb",
    name: "InfluxDB",
    category: "Databases",
    icon: "📉",
    description: "Time-series database for metrics and events.",
    longDescription:
      "InfluxDB 2 is purpose-built for time-series data — metrics, sensors, and events. It boots in setup mode and creates the org, bucket, and admin user below automatically.",
    image: "influxdb:2",
    containerPort: 8086,
    suggestedName: "influxdb",
    env: [
      { key: "DOCKER_INFLUXDB_INIT_MODE", value: "setup" },
      { key: "DOCKER_INFLUXDB_INIT_USERNAME", value: "admin" },
      { key: "DOCKER_INFLUXDB_INIT_PASSWORD", generate: "password", secret: true },
      { key: "DOCKER_INFLUXDB_INIT_ORG", value: "app" },
      { key: "DOCKER_INFLUXDB_INIT_BUCKET", value: "app" }
    ],
    volumes: ["/var/lib/influxdb2"]
  },

  // ---- Tools ----
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
    id: "pgadmin",
    name: "pgAdmin",
    category: "Tools",
    icon: "🧰",
    description: "Web UI for managing PostgreSQL.",
    image: "dpage/pgadmin4:latest",
    containerPort: 80,
    suggestedName: "pgadmin",
    env: [
      { key: "PGADMIN_DEFAULT_EMAIL", value: "admin@example.com" },
      { key: "PGADMIN_DEFAULT_PASSWORD", generate: "password", secret: true }
    ],
    volumes: ["/var/lib/pgadmin"]
  },
  {
    id: "grafana",
    name: "Grafana",
    category: "Tools",
    icon: "📊",
    description: "Dashboards and observability.",
    image: "grafana/grafana:latest",
    containerPort: 3000,
    suggestedName: "grafana",
    env: [{ key: "GF_SECURITY_ADMIN_PASSWORD", generate: "password", secret: true }],
    volumes: ["/var/lib/grafana"]
  },
  {
    id: "metabase",
    name: "Metabase",
    category: "Tools",
    icon: "🧮",
    description: "Business intelligence and analytics.",
    image: "metabase/metabase:latest",
    containerPort: 3000,
    suggestedName: "metabase",
    env: [{ key: "MB_DB_FILE", value: "/data/metabase.db" }],
    volumes: ["/data"]
  },
  {
    id: "gitea",
    name: "Gitea",
    category: "Tools",
    icon: "🍵",
    description: "Lightweight self-hosted Git service.",
    image: "gitea/gitea:1",
    containerPort: 3000,
    suggestedName: "gitea",
    env: [],
    volumes: ["/data"]
  },
  {
    id: "rabbitmq",
    name: "RabbitMQ",
    category: "Tools",
    icon: "🐰",
    description: "Message broker with a management UI.",
    image: "rabbitmq:3-management",
    containerPort: 15672,
    suggestedName: "rabbitmq",
    env: [
      { key: "RABBITMQ_DEFAULT_USER", value: "admin" },
      { key: "RABBITMQ_DEFAULT_PASS", generate: "password", secret: true }
    ],
    volumes: ["/var/lib/rabbitmq"]
  },
  {
    id: "nextcloud",
    name: "Nextcloud",
    category: "Tools",
    icon: "☁️",
    description: "Self-hosted files, calendar, and collaboration.",
    image: "nextcloud:apache",
    containerPort: 80,
    suggestedName: "nextcloud",
    env: [],
    volumes: ["/var/www/html"]
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
  },
  {
    id: "code-server",
    name: "code-server",
    category: "Tools",
    icon: "💻",
    description: "VS Code in the browser.",
    longDescription:
      "Run a full VS Code editor in the browser, backed by your server. Great for editing from any device. Sign in with the generated password below.",
    image: "codercom/code-server:latest",
    containerPort: 8080,
    suggestedName: "code-server",
    env: [{ key: "PASSWORD", generate: "password", secret: true }],
    volumes: ["/home/coder"]
  },
  {
    id: "it-tools",
    name: "IT-Tools",
    category: "Tools",
    icon: "🛠️",
    description: "A handy collection of developer utilities.",
    longDescription:
      "IT-Tools bundles dozens of everyday developer utilities — encoders, converters, generators, formatters — in one fast, self-hosted page. No configuration required.",
    image: "corentinth/it-tools:latest",
    containerPort: 80,
    suggestedName: "it-tools",
    env: []
  },
  {
    id: "freshrss",
    name: "FreshRSS",
    category: "Tools",
    icon: "📰",
    description: "Self-hosted RSS feed aggregator.",
    longDescription:
      "FreshRSS is a fast, self-hosted RSS/Atom reader. Follow sites and newsletters in one place, with a mobile-friendly UI and an API for third-party apps.",
    image: "freshrss/freshrss:latest",
    containerPort: 80,
    suggestedName: "freshrss",
    env: [],
    volumes: ["/var/www/FreshRSS/data"]
  },
  {
    id: "jellyfin",
    name: "Jellyfin",
    category: "Tools",
    icon: "🎬",
    description: "Free software media server.",
    longDescription:
      "Jellyfin streams your movies, shows, and music to any device — no tracking, no fees. Point it at your media after install through the setup wizard.",
    image: "jellyfin/jellyfin:latest",
    containerPort: 8096,
    suggestedName: "jellyfin",
    env: [],
    volumes: ["/config", "/cache"]
  },
  {
    id: "baserow",
    name: "Baserow",
    category: "Tools",
    icon: "🧾",
    description: "Open-source no-code database (Airtable alternative).",
    longDescription:
      "Baserow is a self-hosted, no-code database you use like a spreadsheet. Build tables, link records, and access everything over a REST API.",
    image: "baserow/baserow:1.30.1",
    containerPort: 80,
    suggestedName: "baserow",
    env: [],
    volumes: ["/baserow/data"]
  },
  {
    id: "prometheus",
    name: "Prometheus",
    category: "Tools",
    icon: "🔥",
    description: "Metrics collection and alerting.",
    longDescription:
      "Prometheus scrapes and stores time-series metrics and powers alerting. It boots with a default config you can extend once it's running (pairs well with Grafana).",
    image: "prom/prometheus:latest",
    containerPort: 9090,
    suggestedName: "prometheus",
    env: [],
    volumes: ["/prometheus"]
  }
];
