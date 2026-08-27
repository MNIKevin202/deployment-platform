const { redactSecrets } = require("./core");

const GITHUB_API = "https://api.github.com";

async function testGithubToken(input, request = (url, options) => fetch(url, options)) {
  const token = String(input.githubToken || "").trim();
  if (!token) return { success: false, message: "Enter a GitHub fine-grained personal access token." };
  async function githubRequest(pathname) {
    const response = await request(GITHUB_API + pathname, {
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "DeploymentPlatform-Mac-Installer/1.0" }
    });
    if (response.status === 401) throw new Error("Token is invalid or expired.");
    if (response.status === 403) throw new Error("Token is valid, but GitHub denied this capability or rate limit was reached.");
    if (response.status === 404) throw new Error("The selected repository is outside the token's repository scope.");
    if (!response.ok) throw new Error("GitHub could not complete the requested check.");
    return response.json();
  }
  try {
    const account = await githubRequest("/user");
    const repositories = await githubRequest("/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
    if (!Array.isArray(repositories) || repositories.length === 0) return { success: false, message: "Connected as " + account.login + ", but no repositories are accessible." };
    const requested = String(input.githubRepository || "").trim();
    const candidate = requested.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)\.git$/i) || requested.match(/^([^/]+)\/([^/]+)$/);
    const repo = candidate ? repositories.find((item) => item.full_name.toLowerCase() === (candidate[1] + "/" + candidate[2]).toLowerCase()) : repositories[0];
    if (candidate && !repo) return { success: false, message: "The selected repository is outside the token's repository scope." };
    const target = repo || repositories[0];
    await githubRequest("/repos/" + encodeURIComponent(target.owner.login) + "/" + encodeURIComponent(target.name));
    await githubRequest("/repos/" + encodeURIComponent(target.owner.login) + "/" + encodeURIComponent(target.name) + "/git/ref/heads/" + encodeURIComponent(target.default_branch));
    await githubRequest("/repos/" + encodeURIComponent(target.owner.login) + "/" + encodeURIComponent(target.name) + "/contents/?ref=" + encodeURIComponent(target.default_branch));
    return { success: true, account: account.login, repositoryCount: repositories.length, privateAccess: repositories.some((item) => item.private), contentsAccess: true, repositories: repositories.slice(0, 100).map((item) => ({ fullName: item.full_name, private: item.private, defaultBranch: item.default_branch })) };
  } catch (error) {
    return { success: false, message: redactSecrets(error.message || "GitHub connection failed.", [token]) };
  }
}

module.exports = { testGithubToken };
