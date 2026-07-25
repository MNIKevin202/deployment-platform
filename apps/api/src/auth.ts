import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import {
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import { z } from "zod";

const SESSION_COOKIE = "deployment_platform_session";
const SESSION_DURATION_SECONDS = 60 * 60 * 8;

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(500)
});

interface SessionData {
  username: string;
  expiresAt: number;
}

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parsePasswordHash(value: string): {
  salt: Buffer;
  expectedHash: Buffer;
} {
  const [saltHex, hashHex, ...extraParts] = value.split(":");

  if (!saltHex || !hashHex || extraParts.length > 0) {
    throw new Error(
      "ADMIN_PASSWORD_HASH must use the format salt:hash"
    );
  }

  const salt = Buffer.from(saltHex, "hex");
  const expectedHash = Buffer.from(hashHex, "hex");

  if (
    salt.length === 0 ||
    expectedHash.length === 0 ||
    salt.toString("hex") !== saltHex.toLowerCase() ||
    expectedHash.toString("hex") !== hashHex.toLowerCase()
  ) {
    throw new Error("ADMIN_PASSWORD_HASH contains invalid hexadecimal data");
  }

  return {
    salt,
    expectedHash
  };
}

function verifyPassword(
  password: string,
  passwordHash: string
): boolean {
  const { salt, expectedHash } = parsePasswordHash(passwordHash);

  const suppliedHash = scryptSync(
    password,
    salt,
    expectedHash.length
  );

  if (suppliedHash.length !== expectedHash.length) {
    return false;
  }

  return timingSafeEqual(suppliedHash, expectedHash);
}

function encodeSession(session: SessionData): string {
  return Buffer.from(
    JSON.stringify(session),
    "utf8"
  ).toString("base64url");
}

function decodeSession(value: string): SessionData | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as Partial<SessionData>;

    if (
      typeof parsed.username !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }

    return {
      username: parsed.username,
      expiresAt: parsed.expiresAt
    };
  } catch {
    return null;
  }
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: "/"
  });
}

export async function registerAuthentication(
  app: FastifyInstance
): Promise<void> {
  const adminUsername =
    getRequiredEnvironmentVariable("ADMIN_USERNAME");

  const adminPasswordHash =
    getRequiredEnvironmentVariable("ADMIN_PASSWORD_HASH");

  const sessionSecret =
    getRequiredEnvironmentVariable("SESSION_SECRET");

  const cookieSecure =
    process.env.COOKIE_SECURE?.toLowerCase() === "true";

  parsePasswordHash(adminPasswordHash);

  await app.register(cookie, {
    secret: sessionSecret,
    hook: "onRequest"
  });

  await app.register(rateLimit, {
    global: false
  });

  function readSession(
    request: FastifyRequest
  ): SessionData | null {
    const signedCookie = request.cookies[SESSION_COOKIE];

    if (!signedCookie) {
      return null;
    }

    const unsigned = request.unsignCookie(signedCookie);

    if (!unsigned.valid || !unsigned.value) {
      return null;
    }

    const session = decodeSession(unsigned.value);

    if (!session) {
      return null;
    }

    if (session.expiresAt <= Date.now()) {
      return null;
    }

    if (session.username !== adminUsername) {
      return null;
    }

    return session;
  }

  app.post(
    "/auth/login",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute"
        }
      }
    },
    async (request, reply) => {
      const parsedBody = loginSchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: "Username and password are required"
        });
      }

      const usernameMatches =
        parsedBody.data.username === adminUsername;

      const passwordMatches = verifyPassword(
        parsedBody.data.password,
        adminPasswordHash
      );

      if (!usernameMatches || !passwordMatches) {
        return reply.code(401).send({
          success: false,
          message: "Invalid username or password"
        });
      }

      const session: SessionData = {
        username: adminUsername,
        expiresAt:
          Date.now() + SESSION_DURATION_SECONDS * 1000
      };

      reply.setCookie(
        SESSION_COOKIE,
        encodeSession(session),
        {
          path: "/",
          httpOnly: true,
          sameSite: "strict",
          secure: cookieSecure,
          signed: true,
          maxAge: SESSION_DURATION_SECONDS
        }
      );

      return {
        success: true,
        username: adminUsername,
        expiresAt: session.expiresAt
      };
    }
  );

  app.get("/auth/session", async (request) => {
    const session = readSession(request);

    if (!session) {
      return {
        authenticated: false
      };
    }

    return {
      authenticated: true,
      username: session.username,
      expiresAt: session.expiresAt
    };
  });

  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0];

    const publicPaths = new Set([
      "/",
      "/health",
      "/auth/login",
      "/auth/session"
    ]);

    if (publicPaths.has(pathname)) {
      return;
    }

    const session = readSession(request);

    if (!session) {
      clearSessionCookie(reply);

      return reply.code(401).send({
        success: false,
        message: "Authentication required"
      });
    }
  });

  app.post("/auth/logout", async (_request, reply) => {
    clearSessionCookie(reply);

    return {
      success: true,
      message: "Logged out"
    };
  });
}
