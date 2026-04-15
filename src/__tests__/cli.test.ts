import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, expect } from 'vitest';

const CLI = 'dist/main.js';
const CWD = '/Users/john/code/pi-dash';

function run(...args: string[]) {
  return spawnSync('node', [CLI, ...args], {
    cwd: CWD,
    encoding: 'utf-8',
    timeout: 10000,
  });
}

describe('CLI smoke tests', () => {
  test('--help exits 0', () => {
    const result = run('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pi-dash');
    expect(result.stdout).toContain('Usage');
  }, 15000);

  test('--json with empty session dir', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-dash-test-'));
    const result = run('--json', '--session-dir', tmpDir);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual([]);
  }, 15000);

  test('--list with empty session dir', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-dash-test-'));
    const result = run('--list', '--session-dir', tmpDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('STATUS');
  }, 15000);

  test('-h is same as --help', () => {
    const result = run('-h');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage');
  }, 15000);
});
