import type { TemplateResourceGuidance } from "./appTemplates";

/**
 * Compares a template's stated sizing against what the host actually has.
 *
 * Deliberately advisory only: the result is never used to block an install.
 * An operator may know their workload is light, may be about to resize the
 * VPS, or may simply accept that it will be slow — so the platform's job is
 * to be honest about the trade-off, not to make the decision for them.
 */

export interface HostResourceAssessment {
  /** True when the host is below the template's stated minimum. */
  belowMinimum: boolean;
  /** True when it clears the minimum but not the recommendation. */
  belowRecommended: boolean;
  /** Human-readable shortfalls, e.g. "4 GB RAM (2.0 GB available)". */
  shortfalls: string[];
}

export function formatGb(mb: number): string {
  return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
}

export function assessHostForTemplate(
  resources: TemplateResourceGuidance | undefined,
  hostInfo: { cpuCount: number; memoryTotalBytes: number } | null | undefined
): HostResourceAssessment | null {
  if (!resources || !hostInfo) {
    return null;
  }

  const hostMemoryMb = hostInfo.memoryTotalBytes / (1024 * 1024);
  const hostCpu = hostInfo.cpuCount;
  const shortfalls: string[] = [];

  // A host reporting nonsense (0 CPUs, 0 bytes) is treated as "unknown"
  // rather than "catastrophically undersized" — a wrong scary warning is
  // worse than no warning.
  if (hostMemoryMb <= 0 || hostCpu <= 0) {
    return null;
  }

  let belowMinimum = false;

  if (hostMemoryMb < resources.minMemoryMb) {
    belowMinimum = true;
    shortfalls.push(
      `${formatGb(resources.minMemoryMb)} RAM (this server has ${formatGb(hostMemoryMb)})`
    );
  }

  if (hostCpu < resources.minCpu) {
    belowMinimum = true;
    shortfalls.push(
      `${resources.minCpu} vCPU (this server has ${hostCpu})`
    );
  }

  if (belowMinimum) {
    return { belowMinimum: true, belowRecommended: false, shortfalls };
  }

  const belowRecommended =
    hostMemoryMb < resources.recommendedMemoryMb || hostCpu < resources.recommendedCpu;

  if (belowRecommended) {
    if (hostMemoryMb < resources.recommendedMemoryMb) {
      shortfalls.push(
        `${formatGb(resources.recommendedMemoryMb)} RAM recommended (this server has ${formatGb(hostMemoryMb)})`
      );
    }
    if (hostCpu < resources.recommendedCpu) {
      shortfalls.push(
        `${resources.recommendedCpu} vCPU recommended (this server has ${hostCpu})`
      );
    }
  }

  return { belowMinimum: false, belowRecommended, shortfalls };
}
