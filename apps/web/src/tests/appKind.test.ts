import { describe, expect, test } from "vitest";
import { appKind, imageRepoName, inferAppCategory, isDatabaseImage, isIrcBotImage } from "../lib/appKind";

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

describe("inferAppCategory", () => {
  test("recognizes well-known datastores as Database", () => {
    expect(inferAppCategory("postgres:16-alpine").label).toBe("Database");
    expect(inferAppCategory("redis:7").label).toBe("Database");
  });

  test("recognizes ollama as AI / LLM", () => {
    expect(inferAppCategory("ollama/ollama:0.32.5").label).toBe("AI / LLM");
  });

  test("recognizes open-webui as Web UI", () => {
    expect(inferAppCategory("ghcr.io/open-webui/open-webui:0.11.0").label).toBe("Web UI");
  });

  test("recognizes the Quipora Bot template specifically as Discord Bot", () => {
    expect(inferAppCategory("ghcr.io/mikevin202/quipora-bot:latest").label).toBe("Discord Bot");
  });

  test("recognizes a generic *-bot image as Bot, not specifically Discord", () => {
    expect(inferAppCategory("myorg/telegram-bot:latest").label).toBe("Bot");
  });

  test("recognizes ergo as IRC Server", () => {
    expect(inferAppCategory("ergo:latest").label).toBe("IRC Server");
  });

  test("recognizes known CMS images", () => {
    expect(inferAppCategory("joomla:latest").label).toBe("CMS");
    expect(inferAppCategory("wordpress:6").label).toBe("CMS");
  });

  test("recognizes plain web-server images as Website", () => {
    expect(inferAppCategory("nginx:alpine").label).toBe("Website");
    expect(inferAppCategory("caddy:2").label).toBe("Website");
  });

  test("falls back to a generic Service for anything unrecognized", () => {
    expect(inferAppCategory("deployment-app-9:c1de769df417").label).toBe("Service");
    expect(inferAppCategory("ghcr.io/acme/api-server:sha-abc").label).toBe("Service");
  });
});
