import { WebClient } from '@slack/web-api';
import { Octokit } from '@octokit/rest';
import type { CommsOutput } from '../types/incident';

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
