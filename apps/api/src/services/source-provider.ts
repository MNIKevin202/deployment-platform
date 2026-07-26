/**
 * Normalized, provider-agnostic types for source-repository integration.
 * Every concrete provider client (GitHub today; Forgejo/Gitea/generic Git
 * later) implements `SourceProviderClient` and translates its own API
 * shapes into these — nothing above this layer (routes, services, the
 * frontend) ever sees a raw provider payload.
 */
export type SourceProvider = "github";

export interface SourceAccount {
  username: string;
  htmlUrl: string;
}

export interface SourceRepository {
  /** The provider's own stable repository identifier, as a string. */
  id: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  description: string | null;
  defaultBranch: string;
  htmlUrl: string;
  pushedAt: string | null;
  updatedAt: string | null;
}

export interface SourceBranch {
  name: string;
  commitSha: string;
  protected: boolean;
}

export interface SourceCommit {
  sha: string;
  message: string;
  authorName: string | null;
  authorDate: string | null;
  htmlUrl: string;
}

export interface SourceClientPage<T> {
  items: T[];
  hasMore: boolean;
}

export interface ListPageOptions {
  page?: number;
  perPage?: number;
}

/**
 * GitHub's `/user/repos` listing endpoint has no repository-name search
 * parameter — there is deliberately no `search` field here. Filtering by
 * name is a client-side concern over whatever page(s) have already been
 * loaded; see RepositoriesPage.tsx / SourcePanel.tsx.
 */
export type ListRepositoriesOptions = ListPageOptions;

/**
 * Coarse, closed classification of every failure a provider client can
 * raise — routes map this to an HTTP status and an operator-friendly
 * message; nothing about the underlying provider's raw error ever needs
 * to leak past this boundary.
 */
export type SourceClientErrorKind =
  | "invalid-token"
  | "insufficient-permissions"
  | "rate-limited"
  | "not-found"
  | "network-timeout"
  | "malformed-response"
  | "service-error";

export class SourceClientError extends Error {
  readonly kind: SourceClientErrorKind;

  constructor(kind: SourceClientErrorKind, message: string) {
    super(message);
    this.name = "SourceClientError";
    this.kind = kind;
  }
}

/** Sanitized, safe-to-log detail about one provider API call. */
export interface SourceClientLogEvent {
  provider: SourceProvider;
  endpointCategory: string;
  status: number | null;
  durationMs: number;
  errorClassification: SourceClientErrorKind | null;
}

export interface SourceClientLogger {
  log(event: SourceClientLogEvent): void;
}

/**
 * The narrow surface every source provider must implement. Deliberately
 * small — this phase only ever needs to browse and validate, never clone,
 * build, or write anything back to the provider.
 */
export interface SourceProviderClient {
  readonly provider: SourceProvider;

  validateCredential(token: string): Promise<SourceAccount>;

  listRepositories(
    token: string,
    options?: ListRepositoriesOptions
  ): Promise<SourceClientPage<SourceRepository>>;

  getRepository(token: string, owner: string, repo: string): Promise<SourceRepository>;

  listBranches(
    token: string,
    owner: string,
    repo: string,
    options?: ListPageOptions
  ): Promise<SourceClientPage<SourceBranch>>;

  listCommits(
    token: string,
    owner: string,
    repo: string,
    branch: string,
    options?: ListPageOptions
  ): Promise<SourceClientPage<SourceCommit>>;

  /** Resolves a branch name to its current commit SHA. */
  resolveBranchCommit(token: string, owner: string, repo: string, branch: string): Promise<string>;

  /** Checks whether `path` exists at `ref` — never returns file content. */
  pathExists(token: string, owner: string, repo: string, ref: string, path: string): Promise<boolean>;
}
