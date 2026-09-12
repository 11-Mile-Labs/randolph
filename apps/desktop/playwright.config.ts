import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default defineConfig({ testDir: './test', testMatch: '**/*.spec.ts', workers: 1, timeout: 30_000, outputDir: join(tmpdir(), 'randolph-desktop-test-results'), reporter: 'list' });
