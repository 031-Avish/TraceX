// src/collectors/github-commits.js
// Fetches recent Git commits from the application repository.
// Used to correlate deployments with incident timing.

const { Octokit } = require("@octokit/rest");

class GitHubCommitsCollector {
  constructor() {
    this.owner = process.env.GITHUB_REPO_OWNER;
    this.repo = process.env.GITHUB_REPO_NAME;

    if (!process.env.GITHUB_TOKEN) {
      console.warn("  ⚠ GITHUB_TOKEN not set — commit fetching will be skipped");
      this.octokit = null;
    } else {
      this.octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    }
  }

  /**
   * Get the last N commits with their details.
   */
  async getRecentCommits(count = 10) {
    if (!this.octokit || !this.owner || !this.repo) {
      return {
        success: false,
        count: 0,
        commits: [],
        error: "GitHub not configured (missing GITHUB_TOKEN, GITHUB_REPO_OWNER, or GITHUB_REPO_NAME)",
      };
    }

    try {
      const { data } = await this.octokit.repos.listCommits({
        owner: this.owner,
        repo: this.repo,
        per_page: count,
      });

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
    if (!this.octokit) return { success: false, diff: null };

    try {
      const { data } = await this.octokit.repos.getCommit({
        owner: this.owner,
        repo: this.repo,
        ref: sha,
      });

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
}

module.exports = { GitHubCommitsCollector };
