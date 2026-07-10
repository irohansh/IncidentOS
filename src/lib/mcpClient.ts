import { WebClient } from '@slack/web-api';
import { Octokit } from '@octokit/rest';
import type { CommsOutput, RecentDeploy } from '../types/incident';
import { logger } from './logger';

const slack = process.env.SLACK_BOT_TOKEN
  ? new WebClient(process.env.SLACK_BOT_TOKEN)
  : null;

const octokit = process.env.GITHUB_TOKEN
  ? new Octokit({ auth: process.env.GITHUB_TOKEN })
  : null;

export async function sendSlackMessage(channel: string, text: string): Promise<void> {
  if (!slack) {
    logger.info('Slack not configured — skipping message', { channel, preview: text.slice(0, 80) });
    return;
  }
  await slack.chat.postMessage({ channel, text, mrkdwn: true });
}

export async function postCommsToSlack(incidentId: string, comms: CommsOutput): Promise<void> {
  const channel = process.env.SLACK_INCIDENT_CHANNEL_ID;
  if (!channel) return;

  const internalDraft = comms.drafts.find((d) => d.audience === 'internal');
  if (!internalDraft) return;

  const header = `*Incident ${incidentId} — Auto-generated comms drafts ready*\n\n`;
  await sendSlackMessage(channel, header + internalDraft.body);

  const others = comms.drafts.filter((d) => d.audience !== 'internal');
  if (others.length > 0 && slack) {
    const summary = others
      .map((d) => `*${d.audience.toUpperCase()} draft* (send after ${d.send_after_minutes}min):\n${d.body}`)
      .join('\n\n---\n\n');
    await sendSlackMessage(channel, summary);
  }
}

export async function fetchRecentDeploys(services: string[]): Promise<RecentDeploy[]> {
  const repo = process.env.GITHUB_REPO;
  if (!octokit || !repo) {
    logger.info('GitHub not configured — returning empty recent deploys');
    return [];
  }

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    logger.error('GITHUB_REPO must be in "owner/repo" format', { GITHUB_REPO: repo });
    return [];
  }

  try {
    const { data: commits } = await octokit.rest.repos.listCommits({
      owner,
      repo: repoName,
      per_page: 10,
    });

    const deploys = await Promise.allSettled(
      commits.map(async (commit): Promise<RecentDeploy> => {
        let filesChanged: string[] = [];
        try {
          const { data: detail } = await octokit!.rest.repos.getCommit({
            owner,
            repo: repoName,
            ref: commit.sha,
          });
          filesChanged = (detail.files ?? []).map((f) => f.filename);
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
      .map((r) => r.value);
  } catch (err) {
    logger.error('Failed to fetch recent deploys', { error: (err as Error).message });
    return [];
  }
}

function detectServicesAffected(files: string[], knownServices: string[]): string[] {
  if (files.length === 0 || knownServices.length === 0) return knownServices;
  const matched = knownServices.filter((svc) => {
    const pattern = new RegExp(svc.replace(/-/g, '[-_]?'), 'i');
    return files.some((f) => pattern.test(f));
  });
  return matched.length > 0 ? matched : knownServices;
}

function assessCommitRisk(files: string[]): 'low' | 'medium' | 'high' {
  if (
    files.some((f) =>
      /migrations?\//i.test(f) || /schema\.(sql|ts|js)/i.test(f) || /\binfrastructure\//i.test(f)
    )
  ) {
    return 'high';
  }
  if (
    files.some((f) =>
      /config\//i.test(f) || /\.env/i.test(f) || /helm\//i.test(f) || /k8s\//i.test(f) ||
      /terraform\//i.test(f) || /Dockerfile/i.test(f)
    )
  ) {
    return 'medium';
  }
  return 'low';
}

export async function createGithubIssue(title: string, body: string): Promise<string> {
  const repo = process.env.GITHUB_REPO;
  if (!octokit || !repo) {
    logger.info('GitHub not configured — skipping issue creation', { title });
    return '';
  }

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    logger.error('GITHUB_REPO must be in "owner/repo" format', { GITHUB_REPO: repo });
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
    logger.error('Failed to create GitHub issue', { error: (err as Error).message });
    return '';
  }
}
