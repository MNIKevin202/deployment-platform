import { describe, expect, test } from "vitest";
import { appKind, imageRepoName, isDatabaseImage, isIrcBotImage } from "../lib/appKind";

describe("imageRepoName — reduce an image reference to its bare repo name", () => {
  test.each([
    ["postgres:16-alpine", "postgres"],
    ["library/postgres", "postgres"],
    ["bitnami/postgresql:16", "postgresql"],
    ["docker.io/library/redis:7", "redis"],
    ["registry:5000/team/mysql:8", "mysql"],
    ["deployment-app-9:c1de769df417", "deployment-app-9"],
    ["nginx:alpine", "nginx"],
    ["Redis:7", "redis"], // lowercased
    ["postgres@sha256:abc123", "postgres"] // digest stripped
  ])("%s -> %s", (image, expected) => {
    expect(imageRepoName(image)).toBe(expected);
  });
});

describe("isIrcBotImage", () => {
  test.each(["ghcr.io/mnikevin202/quipora-bot:latest", "quipora-bot", "QUIPORA-BOT:v2"])(
    "%s -> true",
    (image) => {
      expect(isIrcBotImage(image)).toBe(true);
    }
  );

  test.each(["ghcr.io/ergochat/ergo:latest", "postgres:16"])("%s -> false", (image) => {
    expect(isIrcBotImage(image)).toBe(false);
  });
});

describe("isDatabaseImage / appKind", () => {
  test.each([
    "postgres:16-alpine",
    "bitnami/postgresql:16",
    "mysql:8",
    "mariadb",
    "mongo:7",
    "bitnami/mongodb",
    "redis:7-alpine",
    "valkey/valkey",
    "clickhouse/clickhouse-server:latest",
    "scylladb/scylla",
    "neo4j:5",
    "docker.io/library/elasticsearch:8"
  ])("classifies %s as a database", (image) => {
    expect(isDatabaseImage(image)).toBe(true);
    expect(appKind(image)).toBe("database");
  });

  test.each([
    "nginx:alpine",
    "deployment-app-9:c1de769df417",
    "node:24-bookworm-slim",
    "python:3.12",
    "caddy:2",
    "myorg/telegram-bot:latest",
    "ghcr.io/acme/api-server:sha-abc"
  ])("classifies %s as a service", (image) => {
    expect(isDatabaseImage(image)).toBe(false);
    expect(appKind(image)).toBe("service");
  });
});
