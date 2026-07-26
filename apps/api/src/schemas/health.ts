import { z } from "zod";

/**
 * Health checks only ever target the managed app's own container, by name,
 * over the internal Docker network — this path is appended to a hostname
 * and port the server resolves itself (see health-check-service.ts). It is
 * never used to build a URL to an arbitrary host, so these checks exist as
 * defense-in-depth against a path string that "looks like" it's trying to
 * redirect somewhere else, not because the path could actually reach one.
 */
const HEALTH_PATH_ALLOWED_CHARS = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;
const SCHEME_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const MAX_PATH_LENGTH = 512;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

export const healthCheckPathSchema = z
  .string()
  .min(1, "Path is required")
  .max(MAX_PATH_LENGTH, "Path is too long")
  .refine((path) => path.startsWith("/"), "Path must begin with /")
  .refine((path) => !hasControlCharacters(path), "Path must not contain control characters")
  .refine((path) => !path.includes("#"), "Path must not contain a fragment")
  .refine((path) => !path.startsWith("//"), 'Path must not begin with "//"')
  .refine((path) => !SCHEME_PATTERN.test(path), "Path must not contain a scheme or hostname")
  .refine((path) => !path.includes(".."), 'Path must not contain ".."')
  .refine(
    (path) => HEALTH_PATH_ALLOWED_CHARS.test(path),
    "Path contains characters that are not allowed"
  );

export const HEALTH_EXPECTED_STATUS_MIN = 100;
export const HEALTH_EXPECTED_STATUS_MAX = 599;

export const healthExpectedStatusSchema = z
  .number()
  .int()
  .min(HEALTH_EXPECTED_STATUS_MIN)
  .max(HEALTH_EXPECTED_STATUS_MAX);

export const HEALTH_INTERVAL_MIN_SECONDS = 10;
export const HEALTH_INTERVAL_MAX_SECONDS = 3600;

export const healthIntervalSchema = z
  .number()
  .int()
  .min(HEALTH_INTERVAL_MIN_SECONDS)
  .max(HEALTH_INTERVAL_MAX_SECONDS);

export const HEALTH_TIMEOUT_MIN_SECONDS = 1;
export const HEALTH_TIMEOUT_MAX_SECONDS = 60;

export const healthTimeoutSchema = z
  .number()
  .int()
  .min(HEALTH_TIMEOUT_MIN_SECONDS)
  .max(HEALTH_TIMEOUT_MAX_SECONDS);

export const HEALTH_THRESHOLD_MIN = 1;
export const HEALTH_THRESHOLD_MAX = 10;

export const healthThresholdSchema = z
  .number()
  .int()
  .min(HEALTH_THRESHOLD_MIN)
  .max(HEALTH_THRESHOLD_MAX);

export const healthCheckConfigSchema = z
  .object({
    enabled: z.boolean(),
    path: healthCheckPathSchema,
    expectedStatus: healthExpectedStatusSchema,
    intervalSeconds: healthIntervalSchema,
    timeoutSeconds: healthTimeoutSchema,
    failureThreshold: healthThresholdSchema,
    successThreshold: healthThresholdSchema
  })
  .refine((data) => data.timeoutSeconds <= data.intervalSeconds, {
    message: "Timeout must be less than or equal to the interval",
    path: ["timeoutSeconds"]
  });

export type HealthCheckConfigInput = z.infer<typeof healthCheckConfigSchema>;

export const HEALTH_CHECK_DEFAULTS: HealthCheckConfigInput = {
  enabled: false,
  path: "/health",
  expectedStatus: 200,
  intervalSeconds: 30,
  timeoutSeconds: 5,
  failureThreshold: 3,
  successThreshold: 2
};
