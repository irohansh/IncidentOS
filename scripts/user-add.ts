#!/usr/bin/env ts-node
/**
 * Usage: npm run user:add -- <username>
 * Prompts for a password, prints: username:<bcrypt-hash>
 * Paste the output into DASHBOARD_USERS in .env
 */
import * as readline from 'readline';
import bcrypt from 'bcryptjs';

const username = process.argv[2];
if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
  console.error('Usage: npm run user:add -- <username>');
  console.error('Username must be 1-64 chars: a-z A-Z 0-9 _ -');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
rl.question('Password: ', async (password) => {
  rl.close();
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  process.stdout.write(`${username}:${hash}\n`);
  console.error(`\nPaste into DASHBOARD_USERS in .env`);
});
