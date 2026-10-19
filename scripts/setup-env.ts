#!/usr/bin/env ts-node
/**
 * npm run setup:env
 * Copies .env.example → .env if missing, replaces __GENERATE__ with random values,
 * then lists variables still needing manual configuration.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const root = path.resolve(__dirname, '..');
const examplePath = path.join(root, '.env.example');
const envPath = path.join(root, '.env');

if (!fs.existsSync(examplePath)) {
  console.error('.env.example not found');
  process.exit(1);
}

if (!fs.existsSync(envPath)) {
  fs.copyFileSync(examplePath, envPath);
  console.log('Created .env from .env.example');
}

let content = fs.readFileSync(envPath, 'utf8');
let generated: string[] = [];

content = content.replace(/=__GENERATE__/g, () => {
  const val = crypto.randomBytes(32).toString('base64url');
  return `=${val}`;
});
fs.writeFileSync(envPath, content, 'utf8');

const lines = content.split('\n');
const needsManual: string[] = [];
for (const line of lines) {
  const trimmed = line.trim();
  if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
  const [name, ...rest] = trimmed.split('=');
  const val = rest.join('=');
  if (val === 'CHANGE_ME' || val === '') {
    needsManual.push(name.trim());
  }
}

if (needsManual.length > 0) {
  console.log('\nVariables that still need manual configuration:');
  needsManual.forEach((n) => console.log(`  ${n}`));
} else {
  console.log('\nAll variables configured.');
}
