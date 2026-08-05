import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  containerPathSchema,
  createVolumeSchema,
  updateVolumeSchema,
  volumeNameSchema
} from "../schemas/storage.js";

describe("containerPathSchema", () => {
  test("accepts conservative absolute paths", () => {
    assert.equal(containerPathSchema.safeParse("/data").success, true);
    assert.equal(containerPathSchema.safeParse("/app/storage").success, true);
    assert.equal(containerPathSchema.safeParse("/config").success, true);
  });

  test("rejects relative paths", () => {
    assert.equal(containerPathSchema.safeParse("data").success, false);
    assert.equal(containerPathSchema.safeParse("./data").success, false);
  });

  test("rejects path traversal", () => {
    assert.equal(containerPathSchema.safeParse("/data/../etc").success, false);
    assert.equal(containerPathSchema.safeParse("/..").success, false);
  });

  test("rejects a trailing slash", () => {
    assert.equal(containerPathSchema.safeParse("/data/").success, false);
  });

  test("rejects dangerous system paths", () => {
    for (const path of [
      "/",
      "/etc",
      "/proc",
      "/sys",
      "/var/run",
      "/var/run/docker.sock"
    ]) {
      assert.equal(
        containerPathSchema.safeParse(path).success,
        false,
        `expected ${path} to be rejected`
      );
    }
  });

  test("rejects descendants of reserved system directories", () => {
    for (const path of [
      "/proc",
      "/proc/data",
      "/sys",
      "/sys/example",
      "/dev",
      "/dev/custom",
      "/run",
      "/run/example",
      "/var/run",
      "/var/run/example",
      "/var/run/docker.sock",
      "/etc",
      "/etc/example",
      "/boot",
      "/boot/grub",
      "/bin",
      "/bin/sh",
      "/sbin",
      "/sbin/init",
      "/usr",
      "/usr/local",
      "/lib",
      "/lib/systemd",
      "/lib64",
      "/lib64/ld-linux.so"
    ]) {
      assert.equal(
        containerPathSchema.safeParse(path).success,
        false,
        `expected ${path} to be rejected`
      );
    }
  });

  test("allows normal application paths that merely resemble reserved names", () => {
    for (const path of [
      "/data",
      "/config",
      "/app/storage",
      "/var/lib/myapp",
      "/var/data",
      "/var/www",
      "/running-app-data",
      "/etcetera",
      "/library"
    ]) {
      assert.equal(
        containerPathSchema.safeParse(path).success,
        true,
        `expected ${path} to be allowed`
      );
    }
  });

  test("rejects the exact reserved root but not its subdirectories, for /var", () => {
    assert.equal(containerPathSchema.safeParse("/var").success, false);
    assert.equal(containerPathSchema.safeParse("/var/lib/myapp").success, true);
  });

  test("allows /root, which several self-hosted images use for their own state", () => {
    // Not a system/kernel tree — it's the root user's home, and images like
    // RustDesk's server keep their generated keypair there. The panel still
    // refuses a hand-typed /root; only a curated template may declare it.
    assert.equal(containerPathSchema.safeParse("/root").success, true);
    assert.equal(containerPathSchema.safeParse("/root/.config").success, true);
  });

  test("rejects null bytes and shell-like characters", () => {
    assert.equal(containerPathSchema.safeParse("/data\0").success, false);
    assert.equal(containerPathSchema.safeParse("/data;rm -rf").success, false);
    assert.equal(containerPathSchema.safeParse("/data$(whoami)").success, false);
  });
});

describe("volumeNameSchema", () => {
  test("accepts conservative volume names", () => {
    assert.equal(volumeNameSchema.safeParse("sqlite-test-data").success, true);
    assert.equal(volumeNameSchema.safeParse("app_data_2").success, true);
  });

  test("rejects names starting with a digit or uppercase letter", () => {
    assert.equal(volumeNameSchema.safeParse("1data").success, false);
    assert.equal(volumeNameSchema.safeParse("Data").success, false);
  });

  test("rejects empty and overly long names", () => {
    assert.equal(volumeNameSchema.safeParse("").success, false);
    assert.equal(volumeNameSchema.safeParse("a".repeat(64)).success, false);
  });

  test("rejects whitespace and special characters", () => {
    assert.equal(volumeNameSchema.safeParse("my volume").success, false);
    assert.equal(volumeNameSchema.safeParse("my/volume").success, false);
  });
});

describe("createVolumeSchema", () => {
  test("defaults readOnly to false and allows an omitted volume name", () => {
    const result = createVolumeSchema.parse({ containerPath: "/data" });
    assert.equal(result.readOnly, false);
    assert.equal(result.volumeName, undefined);
  });

  test("accepts an explicit volume name and readOnly flag", () => {
    const result = createVolumeSchema.parse({
      containerPath: "/data",
      volumeName: "custom-name",
      readOnly: true
    });
    assert.equal(result.volumeName, "custom-name");
    assert.equal(result.readOnly, true);
  });

  test("rejects an invalid container path even with a valid volume name", () => {
    const result = createVolumeSchema.safeParse({
      containerPath: "/etc",
      volumeName: "custom-name"
    });
    assert.equal(result.success, false);
  });
});

describe("updateVolumeSchema", () => {
  test("requires at least one field", () => {
    assert.equal(updateVolumeSchema.safeParse({}).success, false);
  });

  test("accepts a partial update", () => {
    assert.equal(
      updateVolumeSchema.safeParse({ readOnly: true }).success,
      true
    );
    assert.equal(
      updateVolumeSchema.safeParse({ containerPath: "/data" }).success,
      true
    );
  });
});
