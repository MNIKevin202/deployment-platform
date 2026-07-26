import { z } from "zod";

/**
 * Loose but conservative shape check — GitHub tokens (classic and
 * fine-grained) are alphanumeric with underscores, typically prefixed
 * (e.g. "github_pat_", "ghp_"). This never needs to be exact: GitHub
 * itself is the authority on whether a token is valid, this only rejects
 * obviously-wrong input (empty, absurdly long, containing whitespace or
 * control characters) before it's ever sent anywhere.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_]+$/;

export const githubTokenSchema = z.object({
  token: z
    .string()
    .min(10, "Token is too short")
    .max(512, "Token is too long")
    .regex(TOKEN_PATTERN, "Token contains unexpected characters")
});

export type GithubTokenInput = z.infer<typeof githubTokenSchema>;
