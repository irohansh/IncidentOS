import 'dotenv/config';
import { runIncident } from '../orchestrator';
import { sampleAlert } from './fixtures/sample-alert';

async function main() {
  console.log('='.repeat(60));
  console.log('IncidentOS — Test Run');
  console.log('='.repeat(60));
  console.log(`Alert: ${sampleAlert.incident_id} — ${sampleAlert.title}`);
  console.log('');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }

  try {
    const result = await runIncident(sampleAlert);
    console.log('\n' + '='.repeat(60));
    console.log('Pipeline complete');
    console.log('='.repeat(60));
    console.log('\nTimeline:');
    result.timeline.forEach(e => {
      console.log(`  [${e.timestamp}] [${e.actor}] ${e.event}`);
    });
    if (result.postmortem) {
      console.log('\nPostmortem title:', result.postmortem.title);
      console.log('Action items:', result.postmortem.action_items.length);
    }
    console.log('\nFull result written to stdout as JSON:');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Test run failed:', err);
    process.exit(1);
  }
}

main();
