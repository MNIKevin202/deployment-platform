import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  appSourceConfigSchema,
  branchNameSchema,
  buildContextSchema,
  dockerfilePathSchema,
  repositoryNameSchema,
  repositoryOwnerSchema
} from "../schemas/source.js";
import { githubTokenSchema } from "../schemas/github.js";

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    repositoryOwner: "octocat",
    repositoryName: "hello-world",
    branch: "main",
    deploymentMode: "dockerfile",
    dockerfilePath: "Dockerfile",
    buildContext: ".",
    autoDeploy: false,
    ...overrides
  };
}

describe("repositoryOwnerSchema / repositoryNameSchema", () => {
  test("accepts a valid owner and repo name", () => {
    assert.equal(repositoryOwnerSchema.safeParse("octocat").success, true);
    assert.equal(repositoryOwnerSchema.safeParse("my-org").success, true);
    assert.equal(repositoryNameSchema.safeParse("hello-world").success, true);
    assert.equal(repositoryNameSchema.safeParse("my.repo_name").success, true);
  });

  test("rejects a slash inside owner or repo", () => {
    assert.equal(repositoryOwnerSchema.safeParse("octocat/hello-world").success, false);
    assert.equal(repositoryNameSchema.safeParse("owner/repo").success, false);
  });

  test("rejects a full URL where owner/repo are expected", () => {
    assert.equal(repositoryOwnerSchema.safeParse("https://github.com/octocat").success, false);
    assert.equal(repositoryNameSchema.safeParse("https://github.com/octocat/hello-world").success, false);
  });

  test("rejects traversal-like values", () => {
    assert.equal(repositoryOwnerSchema.safeParse("..").success, false);
    assert.equal(repositoryNameSchema.safeParse("..").success, false);
  });

  test("rejects an owner starting or ending with a hyphen", () => {
    assert.equal(repositoryOwnerSchema.safeParse("-octocat").success, false);
    assert.equal(repositoryOwnerSchema.safeParse("octocat-").success, false);
  });

  test("rejects an overly long owner", () => {
    assert.equal(repositoryOwnerSchema.safeParse("a".repeat(40)).success, false);
  });
});

describe("branchNameSchema", () => {
  test("accepts common branch names", () => {
    assert.equal(branchNameSchema.safeParse("main").success, true);
    assert.equal(branchNameSchema.safeParse("feature/new-thing").success, true);
    assert.equal(branchNameSchema.safeParse("release-1.0.0").success, true);
  });

  test("rejects control characters", () => {
    assert.equal(branchNameSchema.safeParse("main\n").success, false);
    assert.equal(branchNameSchema.safeParse("main\0").success, false);
  });

  test("rejects a leading dash", () => {
    assert.equal(branchNameSchema.safeParse("-main").success, false);
  });

  test("rejects traversal-like values", () => {
    assert.equal(branchNameSchema.safeParse("../etc").success, false);
    assert.equal(branchNameSchema.safeParse("feature/../../etc").success, false);
  });

  test("rejects an excessively long branch name", () => {
    assert.equal(branchNameSchema.safeParse("a".repeat(300)).success, false);
  });

  test("rejects spaces", () => {
    assert.equal(branchNameSchema.safeParse("main branch").success, false);
  });
});

describe("dockerfilePathSchema / buildContextSchema", () => {
  test("accepts safe repository-relative paths", () => {
    assert.equal(dockerfilePathSchema.safeParse("Dockerfile").success, true);
    assert.equal(dockerfilePathSchema.safeParse("docker/Dockerfile.prod").success, true);
    assert.equal(buildContextSchema.safeParse(".").success, true);
    assert.equal(buildContextSchema.safeParse("services/api").success, true);
  });

  test("rejects an absolute (leading-slash) Dockerfile path", () => {
    assert.equal(dockerfilePathSchema.safeParse("/Dockerfile").success, false);
  });

  test("rejects build-context traversal", () => {
    assert.equal(buildContextSchema.safeParse("../..").success, false);
    assert.equal(buildContextSchema.safeParse("services/../../etc").success, false);
  });

  test("rejects null bytes", () => {
    assert.equal(dockerfilePathSchema.safeParse("Dockerfile\0").success, false);
  });

  test("rejects a path that looks like a URL", () => {
    assert.equal(dockerfilePathSchema.safeParse("http://evil.example.com/Dockerfile").success, false);
  });

  test("rejects an overly long path", () => {
    assert.equal(dockerfilePathSchema.safeParse("a".repeat(300)).success, false);
  });

  test("rejects a query string suffix", () => {
    assert.equal(dockerfilePathSchema.safeParse("Dockerfile?raw=true").success, false);
  });

  test("rejects a fragment suffix", () => {
    assert.equal(dockerfilePathSchema.safeParse("Dockerfile#section").success, false);
  });

  test("rejects a backslash path separator", () => {
    assert.equal(dockerfilePathSchema.safeParse("directory\\Dockerfile").success, false);
  });

  test("rejects a repeated empty path segment", () => {
    assert.equal(dockerfilePathSchema.safeParse("services//Dockerfile").success, false);
  });

  test("rejects a trailing slash on a Dockerfile path", () => {
    assert.equal(dockerfilePathSchema.safeParse("services/Dockerfile/").success, false);
  });

  test('rejects a "." path segment in a Dockerfile path', () => {
    assert.equal(dockerfilePathSchema.safeParse("./Dockerfile").success, false);
    assert.equal(dockerfilePathSchema.safeParse("services/./Dockerfile").success, false);
  });

  test('rejects a ".." path segment in a Dockerfile path', () => {
    assert.equal(dockerfilePathSchema.safeParse("services/../Dockerfile").success, false);
  });

  test("rejects percent-encoded traversal and separators, case-insensitively", () => {
    assert.equal(dockerfilePathSchema.safeParse("services%2Fapi/Dockerfile").success, false);
    assert.equal(dockerfilePathSchema.safeParse("services%2fapi/Dockerfile").success, false);
    assert.equal(dockerfilePathSchema.safeParse("%2e%2e/Dockerfile").success, false);
    assert.equal(dockerfilePathSchema.safeParse("%2E%2E/Dockerfile").success, false);
    assert.equal(dockerfilePathSchema.safeParse("directory%5cDockerfile").success, false);
  });

  test("accepts ordinary safe filenames that merely contain dots", () => {
    assert.equal(dockerfilePathSchema.safeParse("Dockerfile.production").success, true);
    assert.equal(dockerfilePathSchema.safeParse("services/api/Dockerfile").success, true);
    assert.equal(dockerfilePathSchema.safeParse("Dockerfile..production").success, true);
  });

  test('build context "." remains valid, and is the only valid single-dot segment', () => {
    assert.equal(buildContextSchema.safeParse(".").success, true);
    assert.equal(buildContextSchema.safeParse("packages/web").success, true);
    assert.equal(buildContextSchema.safeParse("./services").success, false);
    assert.equal(buildContextSchema.safeParse("services/.").success, false);
  });

  test("build context rejects the same query/fragment/backslash/percent-encoding hazards", () => {
    assert.equal(buildContextSchema.safeParse("services?x=1").success, false);
    assert.equal(buildContextSchema.safeParse("services#frag").success, false);
    assert.equal(buildContextSchema.safeParse("services\\api").success, false);
    assert.equal(buildContextSchema.safeParse("%2e%2e/services").success, false);
  });
});

describe("appSourceConfigSchema", () => {
  test("accepts a valid dockerfile configuration", () => {
    const result = appSourceConfigSchema.safeParse(validConfig());
    assert.equal(result.success, true);
  });

  test("applies safe defaults for dockerfilePath, buildContext, and autoDeploy", () => {
    const result = appSourceConfigSchema.safeParse({
      repositoryOwner: "octocat",
      repositoryName: "hello-world",
      branch: "main",
      deploymentMode: "prebuilt-image"
    });

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.dockerfilePath, "Dockerfile");
      assert.equal(result.data.buildContext, ".");
      assert.equal(result.data.autoDeploy, false);
    }
  });

  test("rejects an invalid deployment mode", () => {
    const result = appSourceConfigSchema.safeParse(validConfig({ deploymentMode: "buildpacks" }));
    assert.equal(result.success, false);
  });

  test("rejects unknown fields", () => {
    const result = appSourceConfigSchema.safeParse(
      validConfig({ webhookSecret: "shh", autoBuildOnPush: true })
    );
    assert.equal(result.success, false);
  });

  test("rejects a slash-containing owner even inside the full config", () => {
    const result = appSourceConfigSchema.safeParse(validConfig({ repositoryOwner: "a/b" }));
    assert.equal(result.success, false);
  });

  test("rejects branch traversal inside the full config", () => {
    const result = appSourceConfigSchema.safeParse(validConfig({ branch: "../../etc" }));
    assert.equal(result.success, false);
  });
});

describe("githubTokenSchema", () => {
  test("accepts a plausible token shape", () => {
    const result = githubTokenSchema.safeParse({
      token: "github_pat_11ABCDEFG0123456789abcdefghijklmno"
    });
    assert.equal(result.success, true);
  });

  test("rejects an empty or too-short token", () => {
    assert.equal(githubTokenSchema.safeParse({ token: "" }).success, false);
    assert.equal(githubTokenSchema.safeParse({ token: "short" }).success, false);
  });

  test("rejects a token containing whitespace or unexpected characters", () => {
    assert.equal(githubTokenSchema.safeParse({ token: "abc def ghi jkl" }).success, false);
    assert.equal(githubTokenSchema.safeParse({ token: "abc<script>def</script>" }).success, false);
  });
});
