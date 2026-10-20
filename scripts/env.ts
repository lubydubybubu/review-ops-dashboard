import { existsSync, readFileSync } from 'node:fs';

/** Load .env.local / .env for CLI scripts (Next.js does this itself for the app). */
export function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

/** First set variable among `names`; `NAME_FILE` (a mounted secret) is read in place of `NAME`. */
export function requireEnv(...names: string[]): string {
  for (const name of names) {
    const file = process.env[`${name}_FILE`];
    if (file) return readFileSync(file, 'utf8').trim();
    const value = process.env[name];
    if (value) return value;
  }
  console.error(`missing environment variable: ${names.join(' or ')}`);
  process.exit(1);
}
