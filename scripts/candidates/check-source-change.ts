import { resolve } from 'node:path';
import { sourceState } from './source-state.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

const state = await sourceState(resolve(argument('--run-dir')), resolve(argument('--baseline-dir')));
process.stdout.write(`${JSON.stringify(state)}\n`);
