/**
 * Minimal semantic version parsing/comparison for the platform's
 * self-update system. Deliberately narrow: `MAJOR.MINOR.PATCH` only, no
 * pre-release or build-metadata suffixes — every version this platform
 * produces (root package.json, release tags, manifest entries) is
 * required to be a plain triple, so there is nothing else to parse. A
 * broader semver implementation would accept version strings this system
 * should be refusing instead.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/** True for a strict `MAJOR.MINOR.PATCH` string — the only shape this platform accepts. */
export function isValidSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

/** Throws on anything that isn't a strict `MAJOR.MINOR.PATCH` string. */
export function parseSemVer(value: string): SemVer {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Not a valid MAJOR.MINOR.PATCH version: ${JSON.stringify(value)}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

/** -1 if a<b, 0 if equal, 1 if a>b. Throws if either string is not valid semver. */
export function compareSemVer(a: string, b: string): -1 | 0 | 1 {
  const left = parseSemVer(a);
  const right = parseSemVer(b);

  if (left.major !== right.major) {
    return left.major < right.major ? -1 : 1;
  }
  if (left.minor !== right.minor) {
    return left.minor < right.minor ? -1 : 1;
  }
  if (left.patch !== right.patch) {
    return left.patch < right.patch ? -1 : 1;
  }
  return 0;
}

export function isNewerSemVer(candidate: string, current: string): boolean {
  return compareSemVer(candidate, current) > 0;
}

export function isOlderSemVer(candidate: string, current: string): boolean {
  return compareSemVer(candidate, current) < 0;
}

/**
 * True only when `candidate` differs from `current` by patch version alone
 * (same major, same minor). Used by the "automatic patch/security updates"
 * update policy to decide whether a release may be applied without
 * operator confirmation.
 */
export function isPatchOnlyUpgrade(current: string, candidate: string): boolean {
  const from = parseSemVer(current);
  const to = parseSemVer(candidate);
  return from.major === to.major && from.minor === to.minor && to.patch > from.patch;
}
