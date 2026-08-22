// src/collectors/github-commits.js
// Fetches recent Git commits from the application repository.
// Used to correlate deployments with incident timing.
//
// Talks to GitHub's REST API directly via fetch() rather than @octokit/rest —
// that package is ESM-only from v20+ and crashes require() in this CommonJS
// Lambda (ERR_REQUIRE_ESM) at module load, taking down every invocation
// regardless of whether GitHub is even configured for the incident. Only two
// simple endpoints are needed here, so a thin adapter avoids the dependency
// entirely instead of working around it.

const API_BASE = "https://api.github.com";

class GitHubCommitsCollector {
  /**
   * @param {object} [config] Per-tenant override. Falls back to env vars when
   * not provided — keeps the single-tenant demo path working unmodified.
   */
  constructor(config = {}) {
    this.owner = config.owner || process.env.GITHUB_REPO_OWNER;
    this.repo = config.repo || process.env.GITHUB_REPO_NAME;
    this.token = config.token || process.env.GITHUB_TOKEN;
    // Scopes get_recent_commits to just this service's own directory, when
    // multiple services share one repo — without this, an unrelated
    // service's recent commit can get pulled into an investigation it has
    // nothing to do with (confirmed live: happened investigating a
    // different service's alarm and misattributing it to another
    // service's actual, real, but unrelated bug).
    this.path = config.path || null;

    if (!this.token) {
      console.warn("  ⚠ No GitHub token configured — commit fetching will be skipped");
    }
  }

  /**
   * Get the last N commits with their details.
   */
  async getRecentCommits(count = 10) {
    if (!this.token || !this.owner || !this.repo) {
      return {
        success: false,
        count: 0,
        commits: [],
        error: "GitHub not configured (missing GITHUB_TOKEN, GITHUB_REPO_OWNER, or GITHUB_REPO_NAME)",
      };
    }

    try {
      const pathParam = this.path ? `&path=${encodeURIComponent(this.path)}` : "";
      const data = await this._request(`/repos/${this.owner}/${this.repo}/commits?per_page=${count}${pathParam}`);

      const commits = data.map((c) => ({
        sha: c.sha.substring(0, 7),
        fullSha: c.sha,
        message: c.commit.message.split("\n")[0], // first line only
        body: c.commit.message.split("\n").slice(1).join("\n").trim() || null,
        author: c.commit.author?.name || "unknown",
        date: c.commit.author?.date || null,
        filesChanged: c.files?.length || null,
        additions: c.stats?.additions || null,
        deletions: c.stats?.deletions || null,
      }));

      return { success: true, count: commits.length, commits };
    } catch (error) {
      if (error.status === 404) {
        return { success: false, count: 0, commits: [], error: `Repository not found: ${this.owner}/${this.repo}` };
      }
      return { success: false, count: 0, commits: [], error: error.message };
    }
  }

  /**
   * Get diff details for a specific commit (for deeper analysis).
   */
  async getCommitDiff(sha) {
    if (!this.token) return { success: false, diff: null };

    try {
      const data = await this._request(`/repos/${this.owner}/${this.repo}/commits/${encodeURIComponent(sha)}`);

      return {
        success: true,
        diff: {
          sha: data.sha.substring(0, 7),
          message: data.commit.message,
          files: (data.files || []).map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch?.substring(0, 500) || null, // truncate large patches
          })),
        },
      };
    } catch (error) {
      return { success: false, diff: null, error: error.message };
    }
  }

  async _request(path) {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const error = new Error(`GitHub ${response.status}: ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
}

module.exports = { GitHubCommitsCollector };
