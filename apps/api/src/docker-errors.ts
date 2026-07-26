export function getErrorStatusCode(error: unknown): number | null {
  return typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
    ? error.statusCode
    : null;
}
