import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function cleanTitle(value) {
  return String(value ?? '')
    .replace(/\s*[-|–—]\s*DeepSeek\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleFromDocumentTitle(value) {
  const title = cleanTitle(value);
  return title || 'DeepSeek conversation';
}

export function defaultOutputName(title) {
  const safe = cleanTitle(title)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 120);
  return `${safe || 'DeepSeek conversation'}.pdf`;
}

export function defaultProfileDir() {
  if (process.env.DEEPSEEK2PDF_PROFILE) {
    return path.resolve(expandHome(process.env.DEEPSEEK2PDF_PROFILE));
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'deepseek2pdf', 'chromium-profile');
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'deepseek2pdf', 'chromium-profile');
  }
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'deepseek2pdf',
    'chromium-profile',
  );
}

export function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function findChromium() {
  const candidates = [
    process.env.DEEPSEEK2PDF_CHROME,
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    process.env.PROGRAMFILES
      ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    process.env['PROGRAMFILES(X86)']
      ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

export function formatDate(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isDeepSeekUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase() === 'chat.deepseek.com';
  } catch {
    return false;
  }
}
