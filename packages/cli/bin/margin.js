#!/usr/bin/env node
// Runs the TypeScript sources directly; there is no separate build step for the CLI.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
