#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((error) => {
  console.error(`deepseek2pdf: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});

