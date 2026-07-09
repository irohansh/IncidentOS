import { WebClient } from '@slack/web-api';
import { Octokit } from '@octokit/rest';
import type { CommsOutput, RecentDeploy } from '../types/incident';

const slack = process.env.SLACK_BOT_TOKEN
  ? new WebClient(process.env.SLACK_BOT_TOKEN)
  : null;

const octokit = process.env.GITHUB_TOKEN
  ? new Octokit({ auth: process.env.GITHUB_TOKEN })
  : null;

export async function sendSlackMessage(channel: string, text: string): Promise<void> {
  if (!slack) {
    console.log(`[mcpClient] Slack not configured — would send to ${channel}: ${text.slice(0, 80)}`);
    return;
  }
  await slack.chat.postMessage({ channel, text, mrkdwn: true });
}

// Posts the internal comms draft to the incident Slack channel immediately
export async function postCommsToSlack(incidentId: string, comms: CommsOutput): Promise<void> {
  const channel = process.env.SLACK_INCIDENT_CHANNEL_ID;
  if (!channel) return;

  const internalDraft = comms.drafts.find(d => d.audience === 'internal');
  if (!internalDraft) return;

  const header = `*Incident ${incidentId} — Auto-generated comms drafts ready*\n\n`;
  await sendSlackMessage(channel, header + internalDraft.body);

  // Also post a thread summary of other drafts
  const others = comms.drafts.filter(d => d.audience !== 'internal');
  if (others.length > 0 && slack) {
    const summary = others
      .map(d => `*${d.audience.toUpperCase()} draft* (send after ${d.send_after_minutes}min):\n${d.body}`)
      .join('\n\n---\n\n');
    await sendSlackMessage(channel, summary);
  }
}

// Fetches recent commits from the GitHub repo for root cause correlation.
// Returns empty array if GitHub is not configured.
export async function fetchRecentDeploys(services: string[]): Promise<RecentDeploy[]> {
  const repo = process.env.GITHUB_REPO;
  if (!octokit || !repo) {
    console.log('[mcpClient] GitHub not configured — returning empty recent deploys');
    return [];
  }

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    console.error(`[mcpClient] GITHUB_REPO must be in "owner/repo" format, got: ${repo}`);
    return [];
  }

  try {
    const { data: commits } = await octokit.rest.repos.listCommits({
      owner,
      repo: repoName,
      per_page: 10,
    });

    // Fetch file-level detail in parallel to assess risk
    const deploys = await Promise.allSettled(
      commits.map(async (commit): Promise<RecentDeploy> => {
        let filesChanged: string[] = [];
        try {
          const { data: detail } = await octokit!.rest.repos.getCommit({
            owner,
            repo: repoName,
            ref: commit.sha,
          });
          filesChanged = (detail.files ?? []).map(f => f.filename);
        } catch {
          // skip per-commit detail on error
        }

        return {
          sha: commit.sha.slice(0, 7),
          message: commit.commit.message.split('\n')[0].slice(0, 120),
          author: commit.commit.author?.email ?? commit.commit.author?.name ?? 'unknown',
          deployed_at: commit.commit.author?.date ?? new Date().toISOString(),
          services_affected: detectServicesAffected(filesChanged, services),
          risk_assessment: assessCommitRisk(filesChanged),
        };
      })
    );

    return deploys
      .filter((r): r is PromiseFulfilledResult<RecentDeploy> => r.status === 'fulfilled')
      .map(r => r.value);
  } catch (err) {
    console.error('[mcpClient] Failed to fetch recent deploys:', (err as Error).message);
    return [];
  }
}

function detectServicesAffected(files: string[], knownServices: string[]): string[] {
  if (files.length === 0 || knownServices.length === 0) return knownServices;
  const matched = knownServices.filter(svc => {
    const pattern = new RegExp(svc.replace(/-/g, '[-_]?'), 'i');
    return files.some(f => pattern.test(f));
  });
  return matched.length > 0 ? matched : knownServices;
}

function assessCommitRisk(files: string[]): 'low' | 'medium' | 'high' {
  if (
    files.some(f =>
      /migrations?\//i.test(f) || /schema\.(sql|ts|js)/i.test(f) || /\binfrastructure\//i.test(f)
    )
  ) {
    return 'high';
  }
  if (
    files.some(f =>
      /config\//i.test(f) || /\.env/i.test(f) || /helm\//i.test(f) || /k8s\//i.test(f) ||
      /terraform\//i.test(f) || /Dockerfile/i.test(f)
    )
  ) {
    return 'medium';
  }
  return 'low';
}

// Creates a GitHub issue for postmortem follow-up; returns the issue URL or empty string
export async function createGithubIssue(title: string, body: string): Promise<string> {
  const repo = process.env.GITHUB_REPO;
  if (!octokit || !repo) {
    console.log(`[mcpClient] GitHub not configured — would create issue: ${title}`);
    return '';
  }

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    console.error(`[mcpClient] GITHUB_REPO must be in "owner/repo" format, got: ${repo}`);
    return '';
  }

  try {
    const response = await octokit.rest.issues.create({
      owner,
      repo: repoName,
      title,
      body,
      labels: ['incident', 'postmortem'],
    });
    return response.data.html_url;
  } catch (err) {
    console.error(`[mcpClient] Failed to create GitHub issue: ${(err as Error).message}`);
    return '';
  }
}
