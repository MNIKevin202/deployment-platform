export interface TemplateEnvVar {
  key: string;
  /** Fixed default value. Ignored when `generate` is set. */
  value?: string;
  /** Mark the resulting variable as secret. */
  secret?: boolean;
  /** Generate a random value (e.g. a database password) at selection time. */
  generate?: "password";
  /** Length of the generated value, when `generate` is set. Defaults to 24. */
  generateLength?: number;
}

export type TemplateCategory = "AI" | "Databases" | "Apps" | "Tools";

/**
 * A second service a template deploys alongside its main app — e.g.
 * Blueprint's Ollama model server. Each companion becomes a NORMAL managed
 * app of its own (its own container, volumes, database record, and Delete
 * button), so nothing here is a parallel deployment system: routing,
 * backups, image-update checks, health, and cleanup all work on it exactly
 * as they do for any other app.
 *
 * Companions are created BEFORE the main app so the main app's first boot
 * can already reach them. See resolveTemplatePlaceholders for how the main
 * app's env vars refer to a companion's container name.
 */
export interface TemplateCompanion {
  /** Stable key referenced by `{{companion:<key>}}` placeholders. */
  key: string;
  /**
   * Appended to the app name the operator chose, so a second install under
   * a different name gets its own companion instead of colliding
   * (blueprint -> blueprint-ollama, blueprint-2 -> blueprint-2-ollama).
   */
  nameSuffix: string;
  /** Shown in the template detail and the wizard's review step. */
  label: string;
  description: string;
  image: string;
  containerPort: number;
  env?: TemplateEnvVar[];
  volumes?: string[];
  /**
   * Companions default to internal-only — a backing service reached over
   * the private network should not get a public domain unless a template
   * explicitly opts in.
   */
  internalOnly?: boolean;
}

/** Minimum/recommended host resources, shown before install. */
export interface TemplateResourceGuidance {
  minCpu: number;
  minMemoryMb: number;
  minDiskGb: number;
  recommendedCpu: number;
  recommendedMemoryMb: number;
  recommendedDiskGb: number;
}

export interface AppTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  icon: string;
  /**
   * A first-party icon served from /public, used instead of the emoji when
   * present (the emoji stays as the fallback for older/basic renderers).
   */
  iconImage?: string;
  /** A short ribbon on the card, e.g. "DevMinted Original". */
  badge?: string;
  /** One-line summary shown on the card. */
  description: string;
  /** A short paragraph shown on the template detail view. */
  longDescription: string;
  /** A few feature bullets shown on the template detail view. */
  highlights: string[];
  image: string;
  containerPort: number;
  /** Suggested app name (a valid slug). */
  suggestedName: string;
  env: TemplateEnvVar[];
  /** Container paths that should be backed by a persistent volume. */
  volumes?: string[];
  /**
   * Raw host ports to publish (game servers, etc.). Most templates omit this —
   * they're reached over the platform's HTTP routing.
   */
  publishedPorts?: TemplatePublishedPort[];
  /**
   * When true, the seeded app skips a public HTTP domain — appropriate for
   * services reached only through a published port (e.g. a game server).
   */
  internalOnly?: boolean;
  /**
   * The id of another template in this catalog that must be installed and
   * running first (e.g. Joomla requires "mariadb"). Purely informational —
   * used to warn before install, never to block it.
   */
  requiresTemplateId?: string;
  /**
   * Extra services deployed with this template as managed apps of their
   * own. Unlike `requiresTemplateId` (which only *warns* that the operator
   * should install something separately), these are created automatically
   * as part of the same install.
   */
  companions?: TemplateCompanion[];
  /** Host sizing shown before install. Never blocks installation. */
  resources?: TemplateResourceGuidance;
  /** A prominent caveat shown before install (e.g. CPU-only performance). */
  warning?: string;
  /** Optional post-install model choice — see MODEL_CHOICES below. */
  modelChoices?: TemplateModelChoice[];
}

/**
 * A curated, CPU-friendly model offered at install time. Every identifier
 * here was verified to exist in Ollama's library registry rather than
 * assumed — an invalid one would fail only later, during the pull.
 */
export interface TemplateModelChoice {
  /** Ollama model identifier, e.g. "llama3.2:3b". */
  id: string;
  label: string;
  /** Approximate download size, for setting expectations. */
  sizeLabel: string;
  /** Extra caveat, e.g. needing more RAM. */
  note?: string;
}

/**
 * Replaces `{{companion:<key>}}` in a template env value with the container
 * name the companion will actually get, which depends on the app name the
 * operator chose. Unknown keys are left untouched rather than replaced with
 * an empty string, so a typo shows up as a visible placeholder in the
 * wizard's review step instead of a silently broken URL.
 */
export function resolveTemplatePlaceholders(
  value: string,
  appName: string,
  companions: ReadonlyArray<Pick<TemplateCompanion, "key" | "nameSuffix">>
): string {
  return value.replace(/\{\{companion:([a-z0-9-]+)\}\}/gi, (match, key: string) => {
    const companion = companions.find((item) => item.key === key);
    return companion ? `app-${appName}${companion.nameSuffix}` : match;
  });
}

/** The app name a companion gets for a given main app name. */
export function companionAppName(
  appName: string,
  companion: Pick<TemplateCompanion, "nameSuffix">
): string {
  return `${appName}${companion.nameSuffix}`;
}

export interface TemplatePublishedPort {
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
}

/** Templates in a category, sorted A–Z by name (case-insensitive). */
export function templatesInCategory(category: TemplateCategory): AppTemplate[] {
  return APP_TEMPLATES.filter((template) => template.category === category).sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
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
/**
 * CPU-friendly models offered when installing Blueprint. Every identifier
 * below was checked against Ollama's own library registry
 * (registry.ollama.ai) rather than assumed — a wrong one would surface only
 * later as a failed pull. Sizes are the quantized download sizes Ollama
 * reports for the default quantization of each tag.
 */
export const BLUEPRINT_MODEL_CHOICES: TemplateModelChoice[] = [
  {
    id: "gemma3:270m",
    label: "Gemma 3 270M — fastest",
    sizeLabel: "~300 MB",
    note: "Measured ~3.5x faster than Llama 3.2 1B on a 2 vCPU server. Good for short chat and simple questions; not for code or multi-step reasoning."
  },
  {
    id: "llama3.2:1b",
    label: "Llama 3.2 1B — fast",
    sizeLabel: "~1.3 GB",
    note: "Fits comfortably on a 4 GB server, but derails easily on longer or more involved prompts."
  },
  {
    id: "qwen3:1.7b",
    label: "Qwen 3 1.7B — fast",
    sizeLabel: "~1.4 GB"
  },
  {
    id: "llama3.2:3b",
    label: "Llama 3.2 3B — balanced (recommended)",
    sizeLabel: "~2.0 GB",
    note: "A good default on 8 GB of RAM."
  },
  {
    id: "gemma3:4b",
    label: "Gemma 3 4B — balanced",
    sizeLabel: "~3.3 GB"
  },
  {
    id: "llama3.1:8b",
    label: "Llama 3.1 8B — most capable",
    sizeLabel: "~4.9 GB",
    note: "Needs 8 GB+ RAM and is noticeably slower on CPU."
  }
];

export const APP_TEMPLATES: AppTemplate[] = [
  // ---- AI ----
  {
    id: "blueprint",
    name: "Blueprint",
    category: "AI",
    icon: "🧠",
    iconImage: "/blueprint-icon.png",
    badge: "DevMinted Original",
    description: "Private AI workspace powered by models running directly on your VPS.",
    longDescription:
      "Blueprint is a private AI chat workspace that runs entirely on your own server — no API keys, no third-party provider, and no conversation ever leaving your VPS. Installing it deploys two services: the Blueprint chat interface (Open WebUI) on its own HTTPS domain, and a private model server (Ollama) that is reachable only from Blueprint over the platform's internal network. Both keep their data on persistent volumes, so conversations and downloaded models survive restarts and redeploys. The first account you create in the web interface becomes its administrator.",
    highlights: [
      "Runs AI models locally on your VPS — nothing is sent to a third party",
      "Deploys the chat interface and a private model server together",
      "The model server has no public domain and no published port",
      "Conversations and downloaded models persist on their own volumes"
    ],
    warning:
      "Blueprint runs AI models on your VPS CPU. Responses may generate gradually, especially on smaller servers.",
    resources: {
      minCpu: 4,
      minMemoryMb: 4 * 1024,
      minDiskGb: 10,
      recommendedCpu: 6,
      recommendedMemoryMb: 8 * 1024,
      recommendedDiskGb: 20
    },
    modelChoices: BLUEPRINT_MODEL_CHOICES,
    image: "ghcr.io/open-webui/open-webui:0.11.0",
    containerPort: 8080,
    suggestedName: "blueprint",
    env: [
      // Points at the companion below by its real container name — the
      // placeholder is resolved once the operator picks an app name.
      { key: "OLLAMA_BASE_URL", value: "http://{{companion:ollama}}:11434" },
      // Open WebUI 0.11 refuses to start with authentication enabled and no
      // secret key set, so this is required, not optional.
      { key: "WEBUI_SECRET_KEY", generate: "password", generateLength: 48, secret: true },
      // V1 is local-models-only; leaving the OpenAI integration on makes the
      // UI probe an endpoint that was never configured.
      { key: "ENABLE_OPENAI_API", value: "false" },
      // Open WebUI 0.11 enables Notes, Calendar, Automations, and the code
      // interpreter by default, and each registers a NATIVE TOOL that is
      // attached to every chat message. That breaks Blueprint two ways on
      // the small CPU models this template is built around:
      //   - Gemma has no tool support at all, so the request is rejected
      //     outright with "does not support tools" and nothing is answered;
      //   - Llama 3.2 accepts tools, and a 1-3B model handed a pile of
      //     function schemas starts emitting invented calendar/note code
      //     instead of replying (verified live — this is exactly the
      //     "confused" output it produces).
      // None of these features are usable on a CPU-only install anyway, so
      // they start off. Re-enable any of them from Admin Settings once a
      // tool-capable model is in use.
      { key: "ENABLE_CALENDAR", value: "false" },
      { key: "ENABLE_NOTES", value: "false" },
      { key: "ENABLE_AUTOMATIONS", value: "false" },
      { key: "ENABLE_CODE_INTERPRETER", value: "false" },
      // A second model call per message purely to suggest follow-up
      // questions — real CPU cost on a 2 vCPU box, for output most people
      // don't read.
      { key: "ENABLE_FOLLOW_UP_GENERATION", value: "false" }
    ],
    volumes: ["/app/backend/data"],
    companions: [
      {
        key: "ollama",
        nameSuffix: "-ollama",
        label: "Model server (Ollama)",
        description:
          "Runs the AI models themselves. Internal only — no public domain and no published port, so it is reachable only by Blueprint over the private network.",
        image: "ollama/ollama:0.32.5",
        containerPort: 11434,
        internalOnly: true,
        // Ollama defaults to $HOME/.ollama/models — i.e. /root/.ollama in
        // this image — but the platform reserves /root and every path under
        // it for system use, so a volume can't be mounted there. Point
        // Ollama at a normal application path instead and mount that.
        env: [{ key: "OLLAMA_MODELS", value: "/models" }],
        volumes: ["/models"]
      }
    ]
  },

  // ---- Databases ----
  {
    id: "postgres",
    name: "PostgreSQL",
    category: "Databases",
    icon: "🐘",
    description: "The popular open-source relational database.",
    longDescription:
      "PostgreSQL is a powerful, open-source object-relational database with more than 30 years of active development and a strong reputation for reliability, data integrity, and standards compliance.",
    highlights: [
      "ACID-compliant transactions",
      "JSON/JSONB, full-text search, and rich indexing",
      "Extensible with custom types, functions, and extensions"
    ],
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
    longDescription:
      "MySQL is the world's most popular open-source relational database, trusted everywhere from small sites to large-scale platforms and backed by a huge ecosystem of tools and ORMs.",
    highlights: [
      "Battle-tested and widely supported",
      "Fast reads for typical web workloads",
      "Works with virtually every framework and ORM"
    ],
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
    longDescription:
      "MariaDB is a community-developed, drop-in compatible fork of MySQL, created by the database's original authors and kept fully open-source under an independent foundation.",
    highlights: [
      "Drop-in replacement for MySQL",
      "Extra storage engines (Aria, ColumnStore)",
      "Open governance, no vendor lock-in"
    ],
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
    longDescription:
      "MongoDB is a cross-platform, document-oriented NoSQL database. It stores data in flexible, JSON-like documents, so fields can vary between records and your schema can evolve over time.",
    highlights: [
      "Flexible JSON-like documents",
      "Powerful ad-hoc queries and aggregation pipelines",
      "Scales horizontally with sharding"
    ],
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
    longDescription:
      "Redis is an in-memory data store used as a database, cache, and message broker. Keeping data in RAM gives it microsecond response times, ideal for caching, sessions, and queues.",
    highlights: [
      "Sub-millisecond latency",
      "Caching, sessions, queues, and pub/sub",
      "Rich data types beyond plain key/value"
    ],
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
      "Valkey is a community-driven fork of Redis that stays protocol-compatible, so existing Redis clients work unchanged. A solid choice for caching, queues, and pub/sub without licensing concerns.",
    highlights: [
      "Drop-in Redis replacement",
      "Same protocol and client libraries",
      "Community-governed and fully open-source"
    ],
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
    longDescription:
      "Memcached is a high-performance, distributed memory caching system. It's deliberately simple — an in-memory key/value store for small chunks of data used to speed up dynamic applications.",
    highlights: [
      "Extremely fast key/value cache",
      "Tiny memory footprint",
      "Ideal for offloading repeated database reads"
    ],
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
    highlights: [
      "Documents over a simple HTTP/JSON API",
      "Multi-master replication built in",
      "Runs from the datacenter to the browser (PouchDB)"
    ],
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
    id: "immich-postgres",
    name: "Immich PostgreSQL",
    category: "Databases",
    icon: "🐘",
    description: "PostgreSQL with the vector extension Immich requires.",
    longDescription:
      "A PostgreSQL image bundled with the pgvecto/VectorChord extension that Immich needs for its facial recognition and smart search features — plain PostgreSQL won't run Immich's database migrations. Deploy this before the Immich template.",
    highlights: [
      "Drop-in PostgreSQL with vector search support built in",
      "Required by the Immich template — deploy this first",
      "Not a general-purpose database; use plain PostgreSQL for other apps"
    ],
    image: "ghcr.io/immich-app/postgres:14-vectorchord-0.3.0",
    containerPort: 5432,
    suggestedName: "immich-postgres",
    internalOnly: true,
    env: [
      { key: "POSTGRES_PASSWORD", generate: "password", secret: true },
      { key: "POSTGRES_USER", value: "postgres" },
      { key: "POSTGRES_DB", value: "immich" }
    ],
    volumes: ["/var/lib/postgresql/data"]
  },
  {
    id: "immich-machine-learning",
    name: "Immich Machine Learning",
    category: "Apps",
    icon: "🧠",
    description: "Facial recognition and smart search backend for Immich.",
    longDescription:
      "The machine learning worker Immich uses for facial recognition, object detection, and natural-language smart search. It has no web UI of its own — deploy it alongside Immich and point the main Immich server's IMMICH_MACHINE_LEARNING_URL at it (the default already assumes an app named \"immich-machine-learning\").",
    highlights: [
      "Powers Immich's facial recognition and smart search",
      "No web UI — internal service only",
      "Deploy alongside the Immich template"
    ],
    image: "ghcr.io/immich-app/immich-machine-learning:v3.1.0",
    containerPort: 3003,
    suggestedName: "immich-machine-learning",
    internalOnly: true,
    env: [],
    volumes: ["/cache"]
  },
  {
    id: "immich",
    name: "Immich",
    category: "Apps",
    icon: "📸",
    description: "Self-hosted photo and video backup, Google Photos alternative. Requires companion apps.",
    longDescription:
      "Immich is a fast, full-featured self-hosted photo and video backup solution with mobile apps, facial recognition, and smart search. It needs three companion apps deployed first: \"Immich PostgreSQL\" (a Postgres build with the vector extension it requires — plain PostgreSQL won't work), \"Redis\" (from the Databases templates), and \"Immich Machine Learning\". The defaults below assume they're named immich-postgres, redis, and immich-machine-learning.",
    highlights: [
      "Mobile apps with automatic background backup",
      "Facial recognition and smart, natural-language search",
      "Requires Immich PostgreSQL, Redis, and Immich Machine Learning apps"
    ],
    image: "ghcr.io/immich-app/immich-server:v3.1.0",
    containerPort: 2283,
    suggestedName: "immich",
    requiresTemplateId: "immich-postgres",
    env: [
      { key: "DB_HOSTNAME", value: "app-immich-postgres" },
      { key: "DB_USERNAME", value: "postgres" },
      { key: "DB_PASSWORD", value: "", secret: true },
      { key: "DB_DATABASE_NAME", value: "immich" },
      { key: "REDIS_HOSTNAME", value: "app-redis" },
      { key: "IMMICH_MACHINE_LEARNING_URL", value: "http://app-immich-machine-learning:3003" }
    ],
    // Immich's own compose mounts its media store at /data. (Its older
    // /usr/src/app/upload path would also be rejected outright — the
    // platform reserves everything under /usr.)
    volumes: ["/data"]
  },
  {
    id: "influxdb",
    name: "InfluxDB",
    category: "Databases",
    icon: "📉",
    description: "Time-series database for metrics and events.",
    longDescription:
      "InfluxDB 2 is purpose-built for time-series data — metrics, sensors, and events. It boots in setup mode and creates the org, bucket, and admin user below automatically.",
    highlights: [
      "Purpose-built for time-series data",
      "SQL-like Flux query language",
      "Great for metrics, IoT, and monitoring"
    ],
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
    longDescription:
      "Uptime Kuma is a self-hosted monitoring tool — a polished open-source alternative to services like Uptime Robot. Watch your sites and services and get notified the moment they go down.",
    highlights: [
      "Monitor HTTP(s), TCP, ping, DNS, and more",
      "Alerts via Telegram, Discord, Slack, email, and webhooks",
      "Clean, reactive status dashboard"
    ],
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
    longDescription:
      "n8n is a workflow automation tool — a self-hosted alternative to Zapier and Make. Connect apps and APIs and automate tasks with a visual, node-based editor, with your data staying on your server.",
    highlights: [
      "Visual node-based workflow builder",
      "400+ integrations plus custom code nodes",
      "Self-hosted — your data stays yours"
    ],
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
    longDescription:
      "Adminer is a full-featured database management tool packed into a single file — a lightweight alternative to phpMyAdmin that supports MySQL, PostgreSQL, SQLite, MongoDB, and more.",
    highlights: [
      "One-file, lightweight database GUI",
      "Works with MySQL, PostgreSQL, SQLite, and more",
      "Browse, query, and edit right from the browser"
    ],
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
    longDescription:
      "pgAdmin is the most popular open-source administration and development platform for PostgreSQL. Manage databases, run queries, and monitor activity from a rich web interface.",
    highlights: [
      "Full-featured PostgreSQL web UI",
      "Visual query tool and data editor",
      "Server and database monitoring dashboards"
    ],
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
    longDescription:
      "Grafana is the open-source standard for dashboards and observability. Query, visualize, and alert on metrics and logs from dozens of data sources — all in one place.",
    highlights: [
      "Beautiful, flexible dashboards",
      "Connects to Prometheus, PostgreSQL, and many more",
      "Powerful alerting rules"
    ],
    image: "grafana/grafana:latest",
    containerPort: 3000,
    suggestedName: "grafana",
    env: [{ key: "GF_SECURITY_ADMIN_PASSWORD", generate: "password", secret: true }],
    volumes: ["/var/lib/grafana"]
  },
  {
    id: "metabase",
    name: "Metabase",
    category: "Apps",
    icon: "🧮",
    description: "Business intelligence and analytics.",
    longDescription:
      "Metabase is an open-source business intelligence tool. Ask questions of your data and share dashboards without writing SQL — while power users can drop into SQL whenever they need to.",
    highlights: [
      "No-SQL question builder for everyone",
      "Shareable dashboards and charts",
      "Connects to most SQL databases"
    ],
    image: "metabase/metabase:latest",
    containerPort: 3000,
    suggestedName: "metabase",
    env: [{ key: "MB_DB_FILE", value: "/data/metabase.db" }],
    volumes: ["/data"]
  },
  {
    id: "gitea",
    name: "Gitea",
    category: "Apps",
    icon: "🍵",
    description: "Lightweight self-hosted Git service.",
    longDescription:
      "Gitea is a painless, self-hosted Git service — a lightweight alternative to GitHub and GitLab with repositories, issues, pull requests, and CI, all from a single binary.",
    highlights: [
      "Full Git hosting: repos, issues, and pull requests",
      "Lightweight enough for small servers",
      "Built-in Actions CI (GitHub-compatible)"
    ],
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
    longDescription:
      "RabbitMQ is a widely-deployed open-source message broker. It reliably routes messages between producers and consumers and ships with a friendly web management UI.",
    highlights: [
      "Reliable message queuing over AMQP",
      "Web management UI included",
      "Flexible routing: fanout, topic, and direct"
    ],
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
    category: "Apps",
    icon: "☁️",
    description: "Self-hosted files, calendar, and collaboration.",
    longDescription:
      "Nextcloud is a self-hosted productivity platform — your own private cloud for files, calendars, contacts, and collaboration, extensible with a large ecosystem of apps.",
    highlights: [
      "Files, calendar, contacts, and more",
      "Sync and share across all your devices",
      "Extend with hundreds of add-on apps"
    ],
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
    longDescription:
      "Vaultwarden is a lightweight, Bitwarden-compatible password manager server written in Rust. Run your own vault and use it with all of the official Bitwarden client apps.",
    highlights: [
      "Works with the official Bitwarden apps",
      "Tiny resource footprint",
      "Full control over your own secrets"
    ],
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
      "code-server runs a full VS Code editor in the browser, backed by your server — great for editing from any device. Sign in with the generated password below.",
    highlights: [
      "Full VS Code in any browser",
      "Code from a tablet or Chromebook",
      "Keep your dev environment on the server"
    ],
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
      "IT-Tools bundles dozens of everyday developer utilities — encoders, converters, generators, and formatters — into one fast, self-hosted page. No configuration required.",
    highlights: [
      "Dozens of dev utilities in one place",
      "Encoders, converters, generators, and formatters",
      "Zero configuration"
    ],
    image: "corentinth/it-tools:latest",
    containerPort: 80,
    suggestedName: "it-tools",
    env: []
  },
  {
    id: "freshrss",
    name: "FreshRSS",
    category: "Apps",
    icon: "📰",
    description: "Self-hosted RSS feed aggregator.",
    longDescription:
      "FreshRSS is a fast, self-hosted RSS and Atom reader. Follow sites and newsletters in one place, with a mobile-friendly UI and an API for third-party apps.",
    highlights: [
      "Fast, self-hosted RSS/Atom reader",
      "Mobile-friendly with a full API",
      "Keep up with sites without the noise"
    ],
    image: "freshrss/freshrss:latest",
    containerPort: 80,
    suggestedName: "freshrss",
    env: [],
    volumes: ["/var/www/FreshRSS/data"]
  },
  {
    id: "jellyfin",
    name: "Jellyfin",
    category: "Apps",
    icon: "🎬",
    description: "Free software media server.",
    longDescription:
      "Jellyfin streams your movies, shows, and music to any device — with no tracking and no fees. Point it at your media after install through the setup wizard.",
    highlights: [
      "Stream movies, shows, and music",
      "Apps for phones, TVs, and browsers",
      "Free and open — no tracking, no fees"
    ],
    image: "jellyfin/jellyfin:latest",
    containerPort: 8096,
    suggestedName: "jellyfin",
    env: [],
    volumes: ["/config", "/cache"]
  },
  {
    id: "navidrome",
    name: "Navidrome",
    category: "Apps",
    icon: "🎵",
    description: "Self-hosted music streaming, Spotify-like UI.",
    longDescription:
      "Navidrome turns your music collection into a private streaming service with a clean, Spotify-like web UI. It also speaks the Subsonic API, so most Subsonic-compatible mobile and desktop apps work with it out of the box. No external database needed — it keeps its own SQLite library.",
    highlights: [
      "Stream your own music library from anywhere",
      "Works with Subsonic-compatible apps (DSub, play:Sub, Substreamer, etc.)",
      "No external database required"
    ],
    image: "deluan/navidrome:latest",
    containerPort: 4533,
    suggestedName: "navidrome",
    env: [],
    volumes: ["/data", "/music"]
  },
  {
    id: "baserow",
    name: "Baserow",
    category: "Apps",
    icon: "🧾",
    description: "Open-source no-code database (Airtable alternative).",
    longDescription:
      "Baserow is a self-hosted, no-code database you use like a spreadsheet. Build tables, link records, and access everything over a REST API — a great open Airtable alternative.",
    highlights: [
      "No-code database you use like a spreadsheet",
      "Link records and build relations",
      "REST API for every table"
    ],
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
      "Prometheus scrapes and stores time-series metrics and powers alerting. It boots with a default config you can extend once it's running, and pairs perfectly with Grafana.",
    highlights: [
      "Powerful time-series metrics store",
      "Flexible PromQL queries and alerting",
      "Pairs perfectly with Grafana"
    ],
    image: "prom/prometheus:latest",
    containerPort: 9090,
    suggestedName: "prometheus",
    env: [],
    volumes: ["/prometheus"]
  },
  {
    id: "mailpit",
    name: "Mailpit",
    category: "Tools",
    icon: "📬",
    description: "SMTP testing inbox for your other apps.",
    longDescription:
      "Mailpit captures email your other apps send so you can inspect it in a web inbox — nothing is delivered to the outside world. Point your apps' SMTP settings at app-mailpit on port 1025, then read the messages in the UI.",
    highlights: [
      "Catch outbound email in a web inbox",
      "Great for testing sign-up, reset, and receipt emails",
      "Apps send to app-mailpit:1025; you read it in the browser"
    ],
    image: "axllent/mailpit:latest",
    containerPort: 8025,
    suggestedName: "mailpit",
    env: [{ key: "MP_DATABASE", value: "/data/mailpit.db" }],
    volumes: ["/data"]
  },
  {
    id: "photoprism",
    name: "PhotoPrism",
    category: "Apps",
    icon: "🖼️",
    description: "Self-hosted photo library and image storage.",
    longDescription:
      "PhotoPrism is an AI-powered app for browsing, organizing, and sharing your photo collection. Upload images, and it automatically tags and groups them. Sign in as admin with the generated password below.",
    highlights: [
      "Store and organize your whole photo library",
      "Automatic tagging, search, and albums",
      "Originals kept on a persistent volume you control"
    ],
    image: "photoprism/photoprism:latest",
    containerPort: 2342,
    suggestedName: "photoprism",
    env: [
      { key: "PHOTOPRISM_ADMIN_USER", value: "admin" },
      { key: "PHOTOPRISM_ADMIN_PASSWORD", generate: "password", secret: true }
    ],
    volumes: ["/photoprism/originals", "/photoprism/storage"]
  },
  {
    id: "wordpress",
    name: "WordPress",
    category: "Apps",
    icon: "📝",
    description: "The world's most popular CMS. Requires a database.",
    longDescription:
      "WordPress powers a huge share of the web — blogs, marketing sites, and full CMS-driven apps. It needs a MySQL or MariaDB database: create one from the Databases templates first, then set the connection details below (the defaults assume a MariaDB app named \"mariadb\" with database \"app\").",
    highlights: [
      "Themes and plugins for almost anything",
      "Full-featured blogging and CMS",
      "Requires a separate MySQL/MariaDB app"
    ],
    image: "wordpress:latest",
    containerPort: 80,
    suggestedName: "wordpress",
    requiresTemplateId: "mariadb",
    env: [
      { key: "WORDPRESS_DB_HOST", value: "app-mariadb" },
      { key: "WORDPRESS_DB_USER", value: "root" },
      { key: "WORDPRESS_DB_PASSWORD", value: "", secret: true },
      { key: "WORDPRESS_DB_NAME", value: "app" }
    ],
    volumes: ["/var/www/html"]
  },
  {
    id: "joomla",
    name: "Joomla",
    category: "Apps",
    icon: "🌐",
    description: "Flexible open-source CMS. Requires a database.",
    longDescription:
      "Joomla is a flexible open-source CMS for websites and applications. Like WordPress, it needs a MySQL or MariaDB database: create one from the Databases templates first, then set the connection details below (the defaults assume a MariaDB app named \"mariadb\" with database \"app\"). Unlike most templates here, Joomla's own web installer (at /installation) doesn't read these env vars for its form — when it asks for a database host, type app-mariadb, not the \"localhost\" it suggests by default.",
    highlights: [
      "Powerful content and user management",
      "Large extension and template ecosystem",
      "Requires a separate MySQL/MariaDB app",
      "Its installer needs app-mariadb typed in manually, not localhost"
    ],
    image: "joomla:latest",
    containerPort: 80,
    suggestedName: "joomla",
    requiresTemplateId: "mariadb",
    env: [
      { key: "JOOMLA_DB_HOST", value: "app-mariadb" },
      { key: "JOOMLA_DB_USER", value: "root" },
      { key: "JOOMLA_DB_PASSWORD", value: "", secret: true },
      { key: "JOOMLA_DB_NAME", value: "app" }
    ],
    volumes: ["/var/www/html"]
  },
  {
    id: "minecraft-java",
    name: "Minecraft (Java)",
    category: "Apps",
    icon: "🧱",
    description: "Java Edition game server. Publishes TCP 25565.",
    longDescription:
      "A Minecraft: Java Edition server. Because Minecraft speaks a raw TCP protocol rather than HTTP, it's published on a host port (25565 by default) — players connect using your server's IP address and that port. By selecting this you agree to the Minecraft EULA (https://aka.ms/MinecraftEULA).",
    highlights: [
      "Java Edition multiplayer server",
      "Players connect at your-server-ip:25565",
      "World data persists on a volume; EULA acceptance required"
    ],
    image: "itzg/minecraft-server:latest",
    containerPort: 25565,
    suggestedName: "minecraft",
    internalOnly: true,
    env: [{ key: "EULA", value: "TRUE" }],
    volumes: ["/data"],
    publishedPorts: [{ hostPort: 25565, containerPort: 25565, protocol: "tcp" }]
  },
  {
    id: "minecraft-bedrock",
    name: "Minecraft (Bedrock)",
    category: "Apps",
    icon: "⛏️",
    description: "Bedrock Edition game server. Publishes UDP 19132.",
    longDescription:
      "A Minecraft: Bedrock Edition server (phones, consoles, Windows 10/11). Bedrock uses a raw UDP protocol, so it's published on a host port (19132/UDP by default) — players add your server by its IP address and that port. By selecting this you agree to the Minecraft EULA (https://aka.ms/MinecraftEULA).",
    highlights: [
      "Bedrock Edition server (mobile, console, Windows)",
      "Players connect at your-server-ip on UDP 19132",
      "World data persists on a volume; EULA acceptance required"
    ],
    image: "itzg/minecraft-bedrock-server:latest",
    containerPort: 19132,
    suggestedName: "minecraft-bedrock",
    internalOnly: true,
    env: [{ key: "EULA", value: "TRUE" }],
    volumes: ["/data"],
    publishedPorts: [{ hostPort: 19132, containerPort: 19132, protocol: "udp" }]
  },
  {
    id: "quipora-irc",
    name: "Quipora IRC",
    category: "Apps",
    icon: "💬",
    description: "Our own IRC server, built on Ergo. Publishes TCP 6697 (TLS).",
    longDescription:
      "Quipora IRC is our own IRC server template, built on Ergo — a modern IRC daemon that works out of the box with no config file required. It generates a self-signed TLS certificate and listens on a published host port (6697 by default), so any IRC client (mIRC, etc.) can connect at your-server-ip on port 6697 with TLS enabled. Because the certificate is self-signed, your client needs to be told to accept/trust it. After install, check this app's Console/Logs tab for the one-time operator username and password Ergo prints on first boot — use it to /oper in, then register your nickname and channel from your IRC client with NickServ/ChanServ, same as any Ergo server.",
    highlights: [
      "IRC over TLS on port 6697 — no config file needed to start",
      "One-time operator password appears in this app's Console/Logs on first boot",
      "Config, account/channel registrations, and certs persist on a volume"
    ],
    image: "ghcr.io/ergochat/ergo:latest",
    containerPort: 6697,
    suggestedName: "quipora-irc",
    internalOnly: true,
    env: [],
    volumes: ["/ircd"],
    publishedPorts: [{ hostPort: 6697, containerPort: 6697, protocol: "tcp" }]
  },
  {
    id: "rustdesk",
    name: "RustDesk Server",
    category: "Tools",
    icon: "🖥️",
    description: "Self-hosted remote desktop relay. Publishes the hbbs/hbbr ports.",
    longDescription:
      "A self-hosted RustDesk server, so your remote-desktop traffic never touches a public relay. RustDesk needs two services: hbbs (the ID/rendezvous server clients register with) and hbbr (the relay that carries a session when a direct peer-to-peer connection can't be established). Both are deployed here — hbbs as the main app and hbbr as a companion app of its own. On first boot hbbs generates an encryption keypair and writes it to its data volume; the public key is what clients need alongside your server address, and you can read it from the app's Console tab (cat /root/id_ed25519.pub) once it's running.",
    highlights: [
      "Both services included — hbbs (ID/rendezvous) and hbbr (relay)",
      "Keypair generated automatically on first boot and kept on a volume",
      "Clients need your server IP plus the public key from /root/id_ed25519.pub",
      "Publishes TCP 21115-21117 and 21119, plus UDP 21116 for discovery"
    ],
    image: "rustdesk/rustdesk-server:latest",
    // hbbs's own signalling port; the full set is published below.
    containerPort: 21116,
    suggestedName: "rustdesk",
    internalOnly: true,
    env: [
      // hbbr is reached over the managed-apps network by container name, so
      // hbbs can hand clients a working relay without a public hostname.
      { key: "RELAY", value: "{{companion:hbbr}}:21117" },
      { key: "ENCRYPTED_ONLY", value: "1" }
    ],
    volumes: ["/root"],
    publishedPorts: [
      // hbbs: NAT type test, ID registration/signalling (TCP+UDP), and the
      // web client's websocket.
      { hostPort: 21115, containerPort: 21115, protocol: "tcp" },
      { hostPort: 21116, containerPort: 21116, protocol: "tcp" },
      { hostPort: 21116, containerPort: 21116, protocol: "udp" },
      { hostPort: 21118, containerPort: 21118, protocol: "tcp" }
    ],
    companions: [
      {
        key: "hbbr",
        nameSuffix: "-hbbr",
        label: "RustDesk relay (hbbr)",
        description:
          "Carries session traffic when two peers can't connect directly. Keeps its own key material on a volume.",
        image: "rustdesk/rustdesk-server:latest",
        containerPort: 21117,
        volumes: ["/root"],
        internalOnly: true
      }
    ],
    resources: {
      minCpu: 1,
      minMemoryMb: 512,
      minDiskGb: 1,
      recommendedCpu: 1,
      recommendedMemoryMb: 1024,
      recommendedDiskGb: 5
    },
    warning:
      "The relay carries session traffic, so bandwidth — not CPU — is the limit. Clients also need TCP 21117 open to the relay companion; publish it from that app if your peers can't connect directly."
  },
  {
    id: "openspeedtest",
    name: "OpenSpeedTest",
    category: "Tools",
    icon: "🚀",
    description: "Self-hosted HTML5 network speed test. No database needed.",
    longDescription:
      "A self-hosted, browser-based network speed test — download, upload, ping, and jitter — served straight from your own VPS. It's a single stateless container with no database and nothing to configure, reached over the app's assigned domain like any other web app. Results reflect the path between the browser and this server, which makes it a genuinely useful check of your own host's connectivity.",
    highlights: [
      "Single container, no database, nothing to configure",
      "Measures download, upload, ping, and jitter in the browser",
      "Reached over the app's own HTTPS domain"
    ],
    image: "openspeedtest/latest:latest",
    containerPort: 3000,
    suggestedName: "speedtest",
    env: [],
    // Deliberately no volumes: the image is stateless and stores nothing
    // worth persisting, so adding one would only create an empty volume.
    resources: {
      minCpu: 1,
      minMemoryMb: 256,
      minDiskGb: 1,
      recommendedCpu: 2,
      recommendedMemoryMb: 512,
      recommendedDiskGb: 2
    },
    warning:
      "A speed test saturates your link by design. Running one measures — and briefly consumes — the same bandwidth your other apps share."
  },
  {
    id: "rust-dedicated",
    name: "Rust Dedicated Server (game)",
    category: "Apps",
    icon: "🔫",
    description:
      "Dedicated server for Rust, the survival game (not the programming language). Publishes UDP 28015 + RCON.",
    longDescription:
      "A dedicated server for Rust — the multiplayer survival game by Facepunch, not the Rust programming language. Rust speaks a raw UDP protocol, so players connect to your server's IP on UDP 28015 rather than through an HTTPS domain. RCON (remote console) is published separately for administration and is protected by a generated password. The game files, world data, and configuration all persist on a volume, so a redeploy doesn't wipe your map.",
    highlights: [
      "The survival GAME by Facepunch — not the Rust programming language",
      "Players connect at your-server-ip:28015 (UDP)",
      "Server name, description, world size, seed, and max players are configurable",
      "RCON password generated automatically; world and game files persist on a volume"
    ],
    image: "didstopia/rust-server:latest",
    containerPort: 28015,
    suggestedName: "rust-server",
    internalOnly: true,
    env: [
      { key: "RUST_SERVER_NAME", value: "My Rust Server" },
      { key: "RUST_SERVER_DESCRIPTION", value: "Powered by Deployment Platform" },
      { key: "RUST_SERVER_MAXPLAYERS", value: "50" },
      { key: "RUST_SERVER_WORLDSIZE", value: "3000" },
      { key: "RUST_SERVER_SEED", value: "12345" },
      { key: "RUST_SERVER_PORT", value: "28015" },
      { key: "RUST_RCON_PORT", value: "28016" },
      { key: "RUST_RCON_WEB", value: "1" },
      { key: "RUST_RCON_PASSWORD", generate: "password", generateLength: 24, secret: true }
    ],
    volumes: ["/steamcmd/rust"],
    publishedPorts: [
      // Game traffic (UDP), the Steam query port, and RCON.
      { hostPort: 28015, containerPort: 28015, protocol: "udp" },
      { hostPort: 28015, containerPort: 28015, protocol: "tcp" },
      { hostPort: 28016, containerPort: 28016, protocol: "tcp" },
      { hostPort: 28017, containerPort: 28017, protocol: "udp" }
    ],
    resources: {
      minCpu: 2,
      minMemoryMb: 8192,
      minDiskGb: 20,
      recommendedCpu: 4,
      recommendedMemoryMb: 16384,
      recommendedDiskGb: 50
    },
    warning:
      "Rust is genuinely heavy: expect 8 GB RAM minimum (16 GB for a busy server) and ~20 GB of disk, and the first boot downloads many gigabytes of game files before the server accepts players. A larger world size raises memory use sharply."
  },
  {
    id: "quipora-bot",
    name: "Quipora Bot",
    category: "Apps",
    icon: "🤖",
    description: "Server-admin bot for Quipora IRC: auto-joins channels, moderates, and logs.",
    longDescription:
      "Quipora Bot is a persistent admin bot for a Quipora IRC server. It connects as an IRC operator, auto-joins every channel on the server (registered or not, checked periodically so brand-new channels get joined too), posts a configurable welcome message when someone joins, answers chat commands (!help, !rules, plus your own custom commands), does basic word-filter moderation, and logs every join/part/message to this app's own Console/Logs tab. Deploy a Quipora IRC app first, then create an IRC operator account for the bot from that app's Settings → Operators tab, and fill in its username/password below along with the IRC server's container name (e.g. app-quipora-irc).",
    highlights: [
      "Auto-joins every channel, including new ones, via periodic polling",
      "Configurable welcome message, chat commands, and word-filter moderation",
      "All activity logged to this app's own Console/Logs tab — no separate log storage"
    ],
    image: "ghcr.io/mnikevin202/quipora-bot:latest",
    containerPort: 3000,
    suggestedName: "quipora-bot",
    internalOnly: true,
    requiresTemplateId: "quipora-irc",
    env: [
      { key: "IRC_HOST", value: "app-quipora-irc" },
      { key: "IRC_PORT", value: "6697" },
      { key: "IRC_BOT_NICK", value: "QuiporaBot" },
      { key: "IRC_OPER_USER", value: "" },
      { key: "IRC_OPER_PASS", value: "", secret: true },
      { key: "JOIN_POLL_INTERVAL_SECONDS", value: "30" },
      { key: "WELCOME_MESSAGE_TEMPLATE", value: "Welcome to the channel, {nick}! Type !rules to see the server rules." },
      { key: "COMMAND_PREFIX", value: "!" },
      { key: "RULES_TEXT", value: "" },
      { key: "BOT_COMMANDS", value: "{}" },
      { key: "BANNED_WORDS", value: "" },
      { key: "MODERATION_ACTION", value: "warn" }
    ],
    volumes: ["/data"]
  },

  // ---- Apps requiring a companion database (create the DB app first) ----
  {
    id: "firefly-iii",
    name: "Firefly III",
    category: "Apps",
    icon: "💰",
    description: "Full-featured personal finance manager. Requires a database.",
    longDescription:
      "Firefly III is a self-hosted personal finance manager for tracking budgets, transactions, and accounts in detail. It needs a MySQL or MariaDB database: create a MariaDB app first, then fill in the generated password below (the defaults assume a MariaDB app named \"mariadb\" with database \"app\").",
    highlights: [
      "Detailed budgets, transactions, and reports",
      "Import via CSV or bank integrations",
      "Requires a separate MySQL/MariaDB app"
    ],
    image: "fireflyiii/core:latest",
    containerPort: 8080,
    suggestedName: "firefly-iii",
    requiresTemplateId: "mariadb",
    env: [
      { key: "APP_KEY", generate: "password", generateLength: 32, secret: true },
      { key: "DB_CONNECTION", value: "mysql" },
      { key: "DB_HOST", value: "app-mariadb" },
      { key: "DB_PORT", value: "3306" },
      { key: "DB_DATABASE", value: "app" },
      { key: "DB_USERNAME", value: "root" },
      { key: "DB_PASSWORD", value: "", secret: true }
    ],
    volumes: ["/var/www/html/storage/upload"]
  },
  {
    id: "wikijs",
    name: "Wiki.js",
    category: "Apps",
    icon: "📚",
    description: "Modern wiki/docs platform. Requires a database.",
    longDescription:
      "Wiki.js is a polished, modern wiki and documentation platform. It needs a PostgreSQL database: create a PostgreSQL app first, then fill in the generated password below (the defaults assume a PostgreSQL app named \"postgres\" with database \"app\").",
    highlights: [
      "Clean editor with Markdown and rich-text modes",
      "Page history, permissions, and search built in",
      "Requires a separate PostgreSQL app"
    ],
    image: "ghcr.io/requarks/wiki:2",
    containerPort: 3000,
    suggestedName: "wikijs",
    requiresTemplateId: "postgres",
    env: [
      { key: "DB_TYPE", value: "postgres" },
      { key: "DB_HOST", value: "app-postgres" },
      { key: "DB_PORT", value: "5432" },
      { key: "DB_USER", value: "postgres" },
      { key: "DB_PASS", value: "", secret: true },
      { key: "DB_NAME", value: "app" }
    ]
  },
  {
    id: "bookstack",
    name: "BookStack",
    category: "Apps",
    icon: "📗",
    description: "Polished wiki/documentation platform. Requires a database.",
    longDescription:
      "BookStack organizes documentation into books, chapters, and pages with a clean editor. It needs a MySQL or MariaDB database: create a MariaDB app first, then fill in the generated password below (the defaults assume a MariaDB app named \"mariadb\" with database \"app\").",
    highlights: [
      "Books/chapters/pages structure with full search",
      "WYSIWYG and Markdown editors",
      "Requires a separate MySQL/MariaDB app"
    ],
    image: "lscr.io/linuxserver/bookstack:latest",
    containerPort: 80,
    suggestedName: "bookstack",
    requiresTemplateId: "mariadb",
    env: [
      { key: "PUID", value: "1000" },
      { key: "PGID", value: "1000" },
      { key: "TZ", value: "Etc/UTC" },
      { key: "APP_KEY", generate: "password", generateLength: 32, secret: true },
      { key: "DB_HOST", value: "app-mariadb" },
      { key: "DB_PORT", value: "3306" },
      { key: "DB_DATABASE", value: "app" },
      { key: "DB_USERNAME", value: "root" },
      { key: "DB_PASSWORD", value: "", secret: true }
    ],
    volumes: ["/config"]
  },
  {
    id: "yourls",
    name: "YOURLS",
    category: "Tools",
    icon: "✂️",
    description: "Self-hosted URL shortener with click stats. Requires a database.",
    longDescription:
      "YOURLS (Your Own URL Shortener) is a classic, lightweight link shortener with click analytics and a plugin system. It needs a MySQL or MariaDB database: create a MariaDB app first, then fill in the generated password below (the defaults assume a MariaDB app named \"mariadb\" with database \"app\").",
    highlights: [
      "Short links with click statistics",
      "Plugin ecosystem for extra features",
      "Requires a separate MySQL/MariaDB app"
    ],
    image: "yourls:latest",
    containerPort: 80,
    suggestedName: "yourls",
    requiresTemplateId: "mariadb",
    env: [
      { key: "YOURLS_DB_HOST", value: "app-mariadb" },
      { key: "YOURLS_DB_USER", value: "root" },
      { key: "YOURLS_DB_PASS", value: "", secret: true },
      { key: "YOURLS_DB_NAME", value: "app" },
      { key: "YOURLS_USER", value: "admin" },
      { key: "YOURLS_PASS", generate: "password", secret: true }
    ],
    volumes: ["/var/www/html"]
  },
  {
    id: "umami",
    name: "Umami",
    category: "Tools",
    icon: "📶",
    description: "Privacy-focused, lightweight web analytics. Requires a database.",
    longDescription:
      "Umami is a simple, fast, privacy-focused alternative to Google Analytics. It needs a PostgreSQL database: create a PostgreSQL app first, then edit DATABASE_URL below to use its generated password (the placeholder assumes a PostgreSQL app named \"postgres\" with database \"app\").",
    highlights: [
      "Lightweight, privacy-respecting analytics",
      "No cookies, GDPR-friendly by default",
      "Requires a separate PostgreSQL app"
    ],
    image: "ghcr.io/umami-software/umami:postgresql-latest",
    containerPort: 3000,
    suggestedName: "umami",
    requiresTemplateId: "postgres",
    env: [
      {
        key: "DATABASE_URL",
        value: "postgresql://postgres:REPLACE_WITH_POSTGRES_PASSWORD@app-postgres:5432/app",
        secret: true
      },
      { key: "DATABASE_TYPE", value: "postgresql" },
      { key: "APP_SECRET", generate: "password", generateLength: 32, secret: true }
    ]
  },

  // ---- Personal finance ----
  {
    id: "actual-budget",
    name: "Actual Budget",
    category: "Apps",
    icon: "💵",
    description: "Local-first personal budgeting app.",
    longDescription:
      "Actual Budget is a fast, local-first budgeting app based on envelope budgeting. It ships with its own embedded database — no external database needed.",
    highlights: [
      "Envelope-style budgeting",
      "Fast, local-first sync engine",
      "No external database required"
    ],
    image: "actualbudget/actual-server:latest",
    containerPort: 5006,
    suggestedName: "actual-budget",
    env: [],
    volumes: ["/data"]
  },

  // ---- Productivity / docs ----
  {
    id: "ghost",
    name: "Ghost",
    category: "Apps",
    icon: "👻",
    description: "Polished blogging platform, a popular WordPress alternative.",
    longDescription:
      "Ghost is a modern, fast publishing platform focused on blogging and newsletters. It uses its own embedded database by default — no external database needed. After install, set the site URL from Ghost's own Settings once you have your domain.",
    highlights: [
      "Clean, fast writing and publishing experience",
      "Built-in newsletter and membership support",
      "No external database required"
    ],
    image: "ghost:5-alpine",
    containerPort: 2368,
    suggestedName: "ghost",
    env: [],
    volumes: ["/var/lib/ghost/content"]
  },
  {
    id: "linkding",
    name: "Linkding",
    category: "Tools",
    icon: "🔖",
    description: "Clean, fast self-hosted bookmark manager.",
    longDescription:
      "Linkding is a minimal, fast bookmark manager with tagging, full-text search, and a browser extension. Sign in with the admin account below.",
    highlights: [
      "Fast tagging and full-text search",
      "Browser extension for one-click saving",
      "Simple, no-clutter interface"
    ],
    image: "sissbruecker/linkding:latest",
    containerPort: 9090,
    suggestedName: "linkding",
    env: [
      { key: "LD_SUPERUSER_NAME", value: "admin" },
      { key: "LD_SUPERUSER_PASSWORD", generate: "password", secret: true }
    ],
    volumes: ["/etc/linkding/data"]
  },
  {
    id: "excalidraw",
    name: "Excalidraw",
    category: "Tools",
    icon: "✏️",
    description: "Collaborative whiteboard and diagramming tool.",
    longDescription:
      "Excalidraw is a virtual whiteboard for sketching diagrams with a hand-drawn feel. Self-hosting gives you the same editor under your own domain — no configuration required.",
    highlights: [
      "Hand-drawn-style diagrams and sketches",
      "Real-time collaboration",
      "Zero configuration"
    ],
    image: "excalidraw/excalidraw:latest",
    containerPort: 80,
    suggestedName: "excalidraw",
    env: []
  },
  {
    id: "stirling-pdf",
    name: "Stirling-PDF",
    category: "Tools",
    icon: "📄",
    description: "Swiss-army-knife PDF tool: merge, split, OCR, convert.",
    longDescription:
      "Stirling-PDF is a locally hosted, feature-packed PDF toolkit — merge, split, compress, OCR, convert, and dozens of other operations, all from a browser.",
    highlights: [
      "Merge, split, compress, and convert PDFs",
      "OCR and dozens of other PDF tools",
      "Nothing is uploaded to a third party"
    ],
    image: "stirlingtools/stirling-pdf:latest",
    containerPort: 8080,
    suggestedName: "stirling-pdf",
    env: [],
    volumes: ["/configs", "/logs"]
  },

  // ---- Dashboards / monitoring ----
  {
    id: "homepage",
    name: "Homepage",
    category: "Tools",
    icon: "🏠",
    description: "Popular self-hosted start page / app dashboard.",
    longDescription:
      "Homepage is a fast, highly customizable start page for your self-hosted services, with widgets and service integrations. HOMEPAGE_ALLOWED_HOSTS starts wide open (\"*\") so it's reachable immediately — tighten it to your actual domain from the app's env vars once you have one.",
    highlights: [
      "Customizable service dashboard",
      "Live widgets for many self-hosted apps",
      "Configured via simple YAML files"
    ],
    image: "ghcr.io/gethomepage/homepage:latest",
    containerPort: 3000,
    suggestedName: "homepage",
    env: [{ key: "HOMEPAGE_ALLOWED_HOSTS", value: "*" }],
    volumes: ["/app/config"]
  },
  {
    id: "changedetection",
    name: "Changedetection.io",
    category: "Tools",
    icon: "🕵️",
    description: "Watches web pages and alerts you when they change.",
    longDescription:
      "Changedetection.io monitors web pages for changes — price drops, restock alerts, content updates — and notifies you when something changes.",
    highlights: [
      "Track price drops, restocks, and page changes",
      "Notifications via email, Discord, webhooks, and more",
      "Visual diff of what changed"
    ],
    image: "ghcr.io/dgtlmoon/changedetection.io:latest",
    containerPort: 5000,
    suggestedName: "changedetection",
    env: [],
    volumes: ["/datastore"]
  },

  // ---- Dev / infra ----
  {
    id: "libretranslate",
    name: "LibreTranslate",
    category: "Tools",
    icon: "🔤",
    description: "Self-hosted translation API and UI.",
    longDescription:
      "LibreTranslate is a free and open-source machine translation API and web UI, running entirely on your own server with no calls to a third-party translation service.",
    highlights: [
      "Translation API + web UI, self-hosted",
      "No calls to a third-party translation service",
      "Language models download on first run"
    ],
    image: "libretranslate/libretranslate:latest",
    containerPort: 5000,
    suggestedName: "libretranslate",
    env: [],
    volumes: ["/home/libretranslate/.local"]
  },
  {
    id: "ntfy",
    name: "ntfy",
    category: "Tools",
    icon: "🔔",
    description: "Push notifications to your phone/desktop via simple HTTP calls.",
    longDescription:
      "ntfy lets any script, cron job, or app send you a push notification with one HTTP request — no accounts or API keys required by default. Subscribe to a topic in the app or browser to receive alerts.",
    highlights: [
      "Push notifications via a single curl/HTTP call",
      "Apps for iOS, Android, and desktop browsers",
      "Great for scripts, cron jobs, and CI alerts"
    ],
    image: "binwiederhier/ntfy:latest",
    containerPort: 80,
    suggestedName: "ntfy",
    env: [],
    // Only the message cache is mounted. ntfy's config directory lives under
    // the reserved /etc tree, but nothing needs to be persisted there —
    // every setting has an NTFY_* environment variable, which is how this
    // platform configures apps anyway.
    volumes: ["/var/cache/ntfy"]
  },
  {
    id: "healthchecks",
    name: "Healthchecks",
    category: "Tools",
    icon: "🩺",
    description: "Dead-man's-switch monitoring for cron jobs and scheduled tasks.",
    longDescription:
      "Healthchecks flips the usual monitoring model: your cron job or scheduled task pings it on success, and Healthchecks alerts you the moment a ping doesn't arrive on time — catching silent failures uptime checks miss.",
    highlights: [
      "Alerts when a scheduled job stops running",
      "Simple HTTP ping from any cron job or script",
      "Uses its own SQLite database — no external DB needed"
    ],
    image: "healthchecks/healthchecks:latest",
    containerPort: 8000,
    suggestedName: "healthchecks",
    env: [
      { key: "DB", value: "sqlite" },
      { key: "DB_NAME", value: "/data/hc.sqlite" },
      { key: "SECRET_KEY", generate: "password", generateLength: 32, secret: true },
      { key: "ALLOWED_HOSTS", value: "*" }
    ],
    volumes: ["/data"]
  },
  {
    id: "speedtest-tracker",
    name: "Speedtest Tracker",
    category: "Tools",
    icon: "⚡",
    description: "Tracks your internet speed over time on a graph.",
    longDescription:
      "Speedtest Tracker periodically runs an internet speed test and graphs the results over time, so you can spot slowdowns and hold your ISP to their advertised speed. Sign in with the admin email and password below — they seed the account on the very first boot, so set them before installing.",
    highlights: [
      "Scheduled speed tests, graphed over time",
      "Great for catching ISP slowdowns",
      "Uses its own SQLite database — no external DB needed",
      "Runs automatically every 6 hours by default (SPEEDTEST_SCHEDULE)",
      "Admin login is seeded on first boot from the values below"
    ],
    image: "lscr.io/linuxserver/speedtest-tracker:latest",
    containerPort: 80,
    suggestedName: "speedtest-tracker",
    env: [
      { key: "PUID", value: "1000" },
      { key: "PGID", value: "1000" },
      { key: "TZ", value: "Etc/UTC" },
      { key: "APP_KEY", generate: "password", generateLength: 32, secret: true },
      { key: "DB_CONNECTION", value: "sqlite" },
      /*
       * Without a schedule the app records nothing at all — it only tests
       * when told to. Every 6 hours is frequent enough to spot a degraded
       * connection without saturating the link (a test consumes real
       * bandwidth). Edit or clear it before installing to suit.
       */
      { key: "SPEEDTEST_SCHEDULE", value: "0 */6 * * *" },
      /*
       * These three seed the admin account, and ONLY on the first boot — the
       * app writes the user row into /config/database.sqlite and afterwards
       * ignores them entirely. Setting them here means a fresh install gets
       * the operator's own credentials from the start; adding them to an
       * already-running app does nothing, because the user row already
       * exists (the volume outlives the container). Anyone who hits that has
       * to either sign in with whatever was seeded first, or wipe /config so
       * the seeder runs again.
       */
      { key: "ADMIN_EMAIL", value: "admin@example.com" },
      { key: "ADMIN_NAME", value: "Admin" },
      { key: "ADMIN_PASSWORD", generate: "password", generateLength: 20, secret: true }
    ],
    volumes: ["/config"]
  },

  // ---- Media ----
  {
    id: "audiobookshelf",
    name: "Audiobookshelf",
    category: "Apps",
    icon: "🎧",
    description: "Audiobook and podcast server with progress sync.",
    longDescription:
      "Audiobookshelf is a self-hosted audiobook and podcast server. It tracks listening progress and syncs across devices, with mobile apps for iOS and Android.",
    highlights: [
      "Audiobooks and podcasts in one server",
      "Progress sync across devices",
      "Mobile apps for iOS and Android"
    ],
    image: "advplyr/audiobookshelf:latest",
    containerPort: 80,
    suggestedName: "audiobookshelf",
    env: [],
    volumes: ["/audiobooks", "/podcasts", "/metadata", "/config"]
  },
  {
    id: "kavita",
    name: "Kavita",
    category: "Apps",
    icon: "📖",
    description: "Manga, comic, and ebook reader server.",
    longDescription:
      "Kavita is a fast, feature-rich reading server for manga, comics, and ebooks, with a clean web reader and mobile-friendly UI.",
    highlights: [
      "Manga, comics, and ebooks in one library",
      "Clean, fast web reader",
      "Big, active community"
    ],
    image: "jvmilazz0/kavita:latest",
    containerPort: 5000,
    suggestedName: "kavita",
    env: [],
    volumes: ["/kavita/config", "/manga"]
  },
  {
    id: "calibre-web",
    name: "Calibre-Web",
    category: "Apps",
    icon: "📕",
    description: "Web UI for browsing and managing an ebook library.",
    longDescription:
      "Calibre-Web is a web app for browsing, reading, and managing an ebook collection, and pairs well with an existing Calibre library.",
    highlights: [
      "Browse, read, and manage ebooks from a browser",
      "Pairs with an existing Calibre library",
      "OPDS feed for e-reader apps"
    ],
    image: "lscr.io/linuxserver/calibre-web:latest",
    containerPort: 8083,
    suggestedName: "calibre-web",
    env: [
      { key: "PUID", value: "1000" },
      { key: "PGID", value: "1000" },
      { key: "TZ", value: "Etc/UTC" }
    ],
    volumes: ["/config", "/books"]
  },
  {
    id: "jellyseerr",
    name: "Jellyseerr",
    category: "Apps",
    icon: "🍿",
    description: "Request manager for Jellyfin — users request, you approve.",
    longDescription:
      "Jellyseerr lets your Jellyfin users browse and request movies/shows, which you can then approve from a queue. Pairs naturally with the Jellyfin template already in this catalog.",
    highlights: [
      "Users submit requests; you approve them",
      "Pairs with Jellyfin",
      "Discovery browsing for movies and shows"
    ],
    image: "fallenbagel/jellyseerr:latest",
    containerPort: 5055,
    suggestedName: "jellyseerr",
    env: [{ key: "TZ", value: "Etc/UTC" }],
    volumes: ["/app/config"]
  },

  // ---- Notes / docs / wiki ----
  {
    id: "memos",
    name: "Memos",
    category: "Tools",
    icon: "🗒️",
    description: "Lightweight, fast note-taking, very popular on GitHub.",
    longDescription:
      "Memos is a lightweight, privacy-first note-taking app for quickly capturing ideas. It keeps its own embedded database — no external database needed.",
    highlights: [
      "Fast, lightweight note capture",
      "Privacy-first, self-hosted",
      "No external database required"
    ],
    image: "ghcr.io/usememos/memos:latest",
    containerPort: 5230,
    suggestedName: "memos",
    env: [],
    volumes: ["/var/opt/memos"]
  },
  {
    id: "trilium",
    name: "Trilium Notes",
    category: "Tools",
    icon: "🌳",
    description: "Powerful hierarchical notes app.",
    longDescription:
      "Trilium Notes (via the actively maintained TriliumNext fork) is a hierarchical notes app for building a large personal knowledge base, with rich formatting, note relationships, and scripting.",
    highlights: [
      "Hierarchical notes for a large knowledge base",
      "Rich formatting and note relationships",
      "Actively maintained TriliumNext fork"
    ],
    image: "triliumnext/notes:latest",
    containerPort: 8080,
    suggestedName: "trilium",
    env: [],
    volumes: ["/home/node/trilium-data"]
  },

  // ---- Home / life admin ----
  {
    id: "mealie",
    name: "Mealie",
    category: "Apps",
    icon: "🍲",
    description: "Recipe manager with meal planning.",
    longDescription:
      "Mealie is a self-hosted recipe manager and meal planner — import recipes from a URL, organize them, and build a weekly meal plan and shopping list.",
    highlights: [
      "Import recipes straight from a URL",
      "Meal planning and shopping lists",
      "No external database required"
    ],
    image: "ghcr.io/mealie-recipes/mealie:latest",
    containerPort: 9000,
    suggestedName: "mealie",
    env: [],
    volumes: ["/app/data"]
  },
  {
    id: "homebox",
    name: "Homebox",
    category: "Apps",
    icon: "📦",
    description: "Home inventory and organization tracker.",
    longDescription:
      "Homebox tracks the stuff in your home — items, locations, labels, warranties, and maintenance schedules — in a simple, lightweight web app.",
    highlights: [
      "Track items, locations, and labels",
      "Warranty and maintenance reminders",
      "Lightweight — no external database required"
    ],
    image: "ghcr.io/sysadminsmedia/homebox:latest",
    containerPort: 7745,
    suggestedName: "homebox",
    env: [],
    volumes: ["/data"]
  },
  {
    id: "wallabag",
    name: "Wallabag",
    category: "Apps",
    icon: "🦘",
    description: "\"Read it later\" article saver, a Pocket alternative.",
    longDescription:
      "Wallabag saves articles and web pages to read later, in a clean, ad-free reading view, with tagging and full-text search. Runs in its built-in SQLite mode — no external database needed.",
    highlights: [
      "Clean, ad-free reading view",
      "Tagging and full-text search",
      "SQLite mode — no external database required"
    ],
    image: "wallabag/wallabag:latest",
    containerPort: 80,
    suggestedName: "wallabag",
    env: [{ key: "SYMFONY__ENV__DATABASE_DRIVER", value: "pdo_sqlite" }],
    volumes: ["/var/www/wallabag/data"]
  }
];
