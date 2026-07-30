/**
 * Classifies a managed app as a "service" (website, bot, worker, API) or a
 * "database", purely from its Docker image name.
 *
 * The platform stores no explicit app type — a database is just an app running
 * a well-known datastore image (usually internal-only). This is the single
 * source of truth the panel uses to split the Databases section from Apps.
 * To recognise another datastore image, add its repository name to
 * DATABASE_IMAGE_NAMES below.
 */

export type AppKind = "service" | "database";

/** Well-known datastore image repository names (registry/namespace and tag stripped). */
export const DATABASE_IMAGE_NAMES: ReadonlySet<string> = new Set([
  // relational
  "postgres",
  "postgresql",
  "postgis",
  "mysql",
  "mariadb",
  "percona",
  "cockroachdb",
  "cockroach",
  // document
  "mongo",
  "mongodb",
  "couchdb",
  "couchbase",
  "rethinkdb",
  // key-value / cache
  "redis",
  "valkey",
  "keydb",
  "memcached",
  // wide-column
  "cassandra",
  "scylladb",
  "scylla",
  // analytics / time-series
  "clickhouse",
  "clickhouse-server",
  "influxdb",
  "timescaledb",
  // graph
  "neo4j",
  // search
  "elasticsearch",
  "opensearch"
]);

/**
 * Reduces a Docker image reference to its bare repository name, lowercased —
 * stripping any digest, tag, and registry/namespace path.
 *
 *   postgres:16-alpine          -> "postgres"
 *   library/postgres            -> "postgres"
 *   bitnami/postgresql:16       -> "postgresql"
 *   docker.io/library/redis:7   -> "redis"
 *   registry:5000/team/mysql:8  -> "mysql"
 *   deployment-app-9:c1de769…   -> "deployment-app-9"
 */
export function imageRepoName(image: string): string {
  let ref = image.trim();

  // Drop a "@sha256:…" digest.
  const at = ref.indexOf("@");
  if (at >= 0) {
    ref = ref.slice(0, at);
  }

  // The repository name is the final path segment; a registry host may contain
  // a ":" for its port, but that lives before the last "/", so it is safely
  // excluded by taking the last segment first.
  const lastSlash = ref.lastIndexOf("/");
  let name = lastSlash >= 0 ? ref.slice(lastSlash + 1) : ref;

  // Any remaining ":" in the last segment is the tag separator.
  const colon = name.indexOf(":");
  if (colon >= 0) {
    name = name.slice(0, colon);
  }

  return name.toLowerCase();
}

/** Whether an image is a well-known datastore. */
export function isDatabaseImage(image: string): boolean {
  return DATABASE_IMAGE_NAMES.has(imageRepoName(image));
}

/** The kind a managed app should be grouped under, from its image. */
export function appKind(image: string): AppKind {
  return isDatabaseImage(image) ? "database" : "service";
}
