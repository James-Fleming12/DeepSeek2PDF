import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { findChromium } from './util.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function chromeExecutable() {
  const value = findChromium();
  if (!value) {
    throw new Error(
      'Could not find Chromium or Google Chrome. Install Chromium, or set CHROME_PATH to the browser executable.',
    );
  }
  return value;
}

export function chromiumArgs() {
  const args = ['--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  const extra = process.env.DEEPSEEK2PDF_CHROME_ARGS;
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));
  return args;
}

export async function launchHeadless({ timeout = 60000 } = {}) {
  return chromium.launch({
    executablePath: chromeExecutable(),
    headless: true,
    args: chromiumArgs(),
    timeout,
  });
}

export async function launchPersistent(profileDir, { headless }) {
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromeExecutable(),
    headless,
    args: chromiumArgs(),
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch {
      // Best-effort anti-automation hint only.
    }
  });
  return context;
}
