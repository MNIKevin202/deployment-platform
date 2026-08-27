import { createAppDatabase } from "./database.js";
import { getGithubConnectionInfo } from "./services/github-credential-service.js";

const database = createAppDatabase(process.env.DATABASE_PATH ?? "/data/deployment-platform.sqlite");
try {
  const info = getGithubConnectionInfo({ appDatabase: database });
  console.log(JSON.stringify({ connected: info.connected, username: info.username, lastValidatedAt: info.lastValidatedAt, credentialStatus: info.credentialStatus }));
} finally {
  database.close();
}
