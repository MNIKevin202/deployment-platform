import { readFileSync } from "node:fs";
import { createAppDatabase } from "./database.js";
import { createGithubClient } from "./services/github-client.js";
import { saveGithubCredential } from "./services/github-credential-service.js";

const token = readFileSync(0, "utf8").trim();
if (!token) {
  console.error("GitHub token input was empty.");
  process.exit(1);
}

const database = createAppDatabase(process.env.DATABASE_PATH ?? "/data/deployment-platform.sqlite");
try {
  const result = await saveGithubCredential({
    appDatabase: database,
    githubClient: createGithubClient(),
    logger: { info: () => undefined, error: () => undefined }
  }, token);
  if (!result.success) {
    console.error(result.message || "GitHub credential could not be saved.");
    process.exit(1);
  }
  console.log("GitHub connected as " + (result.info?.username || "the authenticated account") + ".");
} finally {
  database.close();
}
