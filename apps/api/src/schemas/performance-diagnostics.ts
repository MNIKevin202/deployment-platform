import { z } from "zod";
import { MAX_SUBMITTED_RESOURCES } from "../services/performance-diagnostics-service.js";

// A "safe finite non-negative number, or null when the browser
// legitimately couldn't measure it" — the shared shape for every
// browser-submitted timing field. NaN/Infinity/negative values are
// rejected outright rather than silently coerced, since a browser
// bug or a tampered request must never be able to smuggle a bogus
// number into stored diagnostics or the diagnosis logic.
const timingMsSchema = z
  .number()
  .finite()
  .min(0)
  .max(10 * 60 * 1000) // 10 minutes — generous upper bound, still bounded
  .nullable();

const byteCountSchema = z.number().finite().min(0).max(1024 * 1024 * 1024).nullable();

export const browserNavigationTimingSchema = z.object({
  dnsMs: timingMsSchema,
  tcpMs: timingMsSchema,
  tlsMs: timingMsSchema,
  requestStartMs: timingMsSchema,
  ttfbMs: timingMsSchema,
  downloadMs: timingMsSchema,
  domInteractiveMs: timingMsSchema,
  domContentLoadedMs: timingMsSchema,
  pageLoadMs: timingMsSchema,
  totalNavigationMs: timingMsSchema,
  transferBytes: byteCountSchema,
  encodedBodyBytes: byteCountSchema,
  decodedBodyBytes: byteCountSchema,
  available: z.boolean()
});

export const browserResourceEntrySchema = z.object({
  // Full URL as the browser saw it — sanitized (query string/hash
  // stripped, host+path only retained) server-side by
  // sanitizeResourceEntry before anything is persisted or returned.
  url: z.string().min(1).max(2048),
  initiatorType: z.string().max(50),
  startMs: z.number().finite().min(0).max(10 * 60 * 1000),
  durationMs: z.number().finite().min(0).max(10 * 60 * 1000),
  transferBytes: byteCountSchema,
  statusOk: z.boolean()
});

export const submitBrowserDiagnosticsSchema = z
  .object({
    diagnosticId: z.number().int().positive(),
    navigation: browserNavigationTimingSchema,
    resources: z.array(browserResourceEntrySchema).max(MAX_SUBMITTED_RESOURCES)
  })
  .strict();

export type SubmitBrowserDiagnosticsInput = z.infer<typeof submitBrowserDiagnosticsSchema>;
