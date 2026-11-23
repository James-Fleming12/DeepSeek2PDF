import { extractConversationInPage } from './extract.js';
import { launchPersistent, sleep } from './browser.js';
import { defaultProfileDir } from './util.js';

async function firstPage(context) {
  return context.pages()[0] || context.newPage();
}

async function inspectPage(page) {
  try {
    return await page.evaluate(() => {
      const body = (document.body && document.body.innerText) || '';
      const loginButton = [...document.querySelectorAll('button, a, [role="button"]')].some((element) => {
        const text = (element.innerText || '').trim();
        if (!/^(log\s*in|sign\s*in|log\s*in\s*\/\s*sign\s*up|登录|登陆)$/i.test(text)) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return {
        url: location.href,
        title: document.title || '',
        messages: document.querySelectorAll('.ds-message').length,
        hasInput: Boolean(document.querySelector('textarea, [contenteditable="true"]')),
        loginButton,
        body: body.slice(0, 2000),
      };
    });
  } catch {
    return { url: page.url(), title: '', messages: 0, hasInput: false, loginButton: false, body: '' };
  }
}

function looksLikeLogin(state) {
  if (state.loginButton) return true;
  const url = (state.url || '').toLowerCase();
  if (/(sign[_-]?in|login|log-in)/.test(url)) return true;
  const body = (state.body || '').toLowerCase();
  return /(log in|sign in|登录|登陆)/.test(body) && state.messages === 0;
}

function looksLikeChallenge(state) {
  return /(just a moment|checking your browser|verify you are human|cloudflare)/i.test(state.body || '');
}

async function waitForChat(page, { timeout, headed, log, waitThroughLogin = false }) {
  const started = Date.now();
  let inputSince = null;
  let lastLog = 0;
  while (Date.now() - started < timeout) {
    const state = await inspectPage(page);
    if (state.messages > 0) return { status: 'chat', state };

    if (looksLikeLogin(state)) {
      if (!waitThroughLogin) return { status: 'login', state };
      if (Date.now() - lastLog > 10000) {
        log('Waiting for you to finish logging in...');
        lastLog = Date.now();
      }
    } else if (state.hasInput) {
      if (inputSince === null) inputSince = Date.now();
      // The input can appear a moment before the message list. Give the app
      // time to render the conversation history.
      if (Date.now() - inputSince > 8000) return { status: 'empty-chat', state };
    } else {
      inputSince = null;
    }

    if (looksLikeChallenge(state)) {
      if (!headed) {
        return { status: 'challenge', state };
      }
      if (Date.now() - lastLog > 10000) {
        log('Waiting for the browser challenge to clear...');
        lastLog = Date.now();
      }
    }
    await sleep(1000);
  }
  return { status: 'timeout', state: await inspectPage(page) };
}

export async function login({ profileDir = defaultProfileDir(), timeout = 10 * 60 * 1000, log = console.error } = {}) {
  log(`Opening ${profileDir}`);
  const context = await launchPersistent(profileDir, { headless: false });
  try {
    const page = await firstPage(context);
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('Log in to DeepSeek in the opened browser window. This window will close automatically once you are logged in.');

    const result = await waitForChat(page, {
      timeout,
      headed: true,
      log,
      waitThroughLogin: true,
    });
    if (result.status !== 'chat' && result.status !== 'empty-chat') {
      throw new Error(
        `Login was not detected within ${Math.round(timeout / 1000)} seconds. Try again with a longer --timeout.`,
      );
    }
    await sleep(1500);
    log('Login saved. You can now render chats from chat.deepseek.com.');
  } finally {
    await context.close();
  }
}

/**
 * Runs in the page. Sets up window.__deepseek2pdfCollector and collects the
 * messages that are currently mounted in the virtual list.
 */
export function initCollectorInPage() {
  function hash(value) {
    let result = 0;
    for (let index = 0; index < value.length; index += 1) {
      result = ((result << 5) - result + value.charCodeAt(index)) | 0;
    }
    return String(result);
  }

  function findScroller() {
    const candidates = [];
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      if (element.scrollHeight <= element.clientHeight + 20) continue;
      if (!element.querySelector('.ds-message, [data-virtual-list-item-key]')) continue;
      candidates.push(element);
    }
    candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
    if (candidates[0]) return candidates[0];
    const documentScroller = document.scrollingElement;
    if (documentScroller && documentScroller.scrollHeight > documentScroller.clientHeight + 20) {
      return documentScroller;
    }
    return null;
  }

  const items = new Map();
  let order = 0;

  function collect() {
    for (const element of document.querySelectorAll('[data-virtual-list-item-key]')) {
      // Ignore unrelated virtual lists (for example the sidebar's chat
      // history) that may also use data-virtual-list-item-key.
      if (!element.querySelector('.ds-message')) continue;
      const rawKey = element.getAttribute('data-virtual-list-item-key');
      if (rawKey === null) continue;
      const key = `k:${rawKey}`;
      const html = element.outerHTML;
      const previous = items.get(key);
      if (!previous) {
        const numeric = /^\d+$/.test(rawKey) ? Number(rawKey) : null;
        items.set(key, { key, order: order++, numeric, html });
      } else if (html.length > previous.html.length) {
        previous.html = html;
      }
    }

    for (const element of document.querySelectorAll('.ds-message')) {
      if (element.closest('[data-virtual-list-item-key]')) continue;
      const text = (element.textContent || '').trim().slice(0, 800);
      const key = `m:${hash(text || element.outerHTML.slice(0, 300))}`;
      const html = element.outerHTML;
      const previous = items.get(key);
      if (!previous) {
        items.set(key, { key, order: order++, numeric: null, html });
      } else if (html.length > previous.html.length) {
        previous.html = html;
      }
    }
  }

  const scroller = findScroller();
  window.__deepseek2pdfCollector = {
    items,
    collect,
    scroller,
    getState() {
      return {
        count: items.size,
        hasScroller: Boolean(scroller),
        scrollTop: scroller ? scroller.scrollTop : 0,
        scrollHeight: scroller ? scroller.scrollHeight : 0,
        clientHeight: scroller ? scroller.clientHeight : 0,
      };
    },
    getItems() {
      return [...items.values()]
        .sort((a, b) => {
          if (a.numeric !== null && b.numeric !== null) return a.numeric - b.numeric;
          return a.order - b.order;
        })
        .map(({ key, html, numeric }) => ({ key, html, numeric }));
    },
    scrollTo(position) {
      if (!scroller) {
        window.scrollTo(0, position);
        return;
      }
      scroller.scrollTop = position;
    },
  };
  collect();
  return window.__deepseek2pdfCollector.getState();
}

async function collectAllMessages(page, { maxSteps = 400, log = () => {} } = {}) {
  const initial = await page.evaluate(initCollectorInPage);
  if (!initial.hasScroller) {
    await sleep(500);
    await page.evaluate(() => window.__deepseek2pdfCollector.collect());
    const items = await page.evaluate(() => window.__deepseek2pdfCollector.getItems());
    return { items, warnings: items.length ? [] : ['No messages were found on the page.'] };
  }

  await page.evaluate(() => {
    window.__deepseek2pdfCollector.scrollTo(0);
    window.__deepseek2pdfCollector.collect();
  });
  await sleep(600);

  let lastCount = 0;
  let stable = 0;
  let steps = 0;
  let state = await page.evaluate(() => window.__deepseek2pdfCollector.getState());

  while (steps < maxSteps) {
    state = await page.evaluate(() => window.__deepseek2pdfCollector.getState());
    const stepSize = Math.max(300, Math.round((state.clientHeight || 700) * 0.8));
    const next = Math.min(state.scrollHeight, state.scrollTop + stepSize);
    await page.evaluate((position) => {
      window.__deepseek2pdfCollector.scrollTo(position);
    }, next);
    await sleep(380);

    // Some virtual lists listen to wheel events rather than scrollTop.
    const afterScroll = await page.evaluate(() => window.__deepseek2pdfCollector.getState());
    if (
      afterScroll.scrollTop <= state.scrollTop + 1
      && afterScroll.scrollTop + afterScroll.clientHeight < afterScroll.scrollHeight - 12
    ) {
      await page.mouse.move(640, 450);
      await page.mouse.wheel(0, stepSize);
      await sleep(380);
    }

    const count = await page.evaluate(() => {
      window.__deepseek2pdfCollector.collect();
      return window.__deepseek2pdfCollector.getState().count;
    });
    steps += 1;

    if (count === lastCount) stable += 1;
    else {
      stable = 0;
      lastCount = count;
    }

    state = await page.evaluate(() => window.__deepseek2pdfCollector.getState());
    const atBottom = state.scrollTop + state.clientHeight >= state.scrollHeight - 12;
    if (atBottom) {
      await sleep(700);
      const bottomCount = await page.evaluate(() => {
        window.__deepseek2pdfCollector.collect();
        return window.__deepseek2pdfCollector.getState().count;
      });
      if (bottomCount === lastCount) stable += 1;
      else {
        stable = 0;
        lastCount = bottomCount;
      }
      if (stable >= 2) break;
    }
    if (steps % 10 === 0) log(`Loaded ${count} messages...`);
  }

  let items = await page.evaluate(() => window.__deepseek2pdfCollector.getItems());
  const numericKeys = items.map((item) => item.numeric).filter((value) => value !== null);
  const gaps = numericKeys.length > 1
    ? (Math.max(...numericKeys) - Math.min(...numericKeys) + 1) !== new Set(numericKeys).size
    : false;

  if (gaps) {
    log('Some virtual-list messages were skipped; scanning upward to fill gaps...');
    for (let index = 0; index < maxSteps; index += 1) {
      const current = await page.evaluate(() => window.__deepseek2pdfCollector.getState());
      const next = Math.max(0, current.scrollTop - Math.max(300, Math.round(current.clientHeight * 0.8)));
      await page.evaluate((position) => {
        window.__deepseek2pdfCollector.scrollTo(position);
      }, next);
      await sleep(300);
      const after = await page.evaluate(() => window.__deepseek2pdfCollector.getState());
      if (after.scrollTop >= current.scrollTop - 1 && after.scrollTop > 0) {
        await page.mouse.move(640, 450);
        await page.mouse.wheel(0, -Math.max(300, Math.round(current.clientHeight * 0.8)));
        await sleep(300);
      }
      await page.evaluate(() => window.__deepseek2pdfCollector.collect());
      if (next === 0) break;
    }
    await page.evaluate(() => window.__deepseek2pdfCollector.collect());
    items = await page.evaluate(() => window.__deepseek2pdfCollector.getItems());
  }

  const warnings = [];
  if (items.length === 0) warnings.push('No messages were found on the page.');
  const finalNumeric = items.map((item) => item.numeric).filter((value) => value !== null);
  const finalGaps = finalNumeric.length > 1
    ? (Math.max(...finalNumeric) - Math.min(...finalNumeric) + 1) !== new Set(finalNumeric).size
    : false;
  if (finalGaps) {
    warnings.push(
      'The chat appears to use a virtualized message list, and a few messages may not have loaded. Scroll through the chat once and try again if content is missing.',
    );
  }

  return { items, warnings };
}

export async function extractFromUrl(url, {
  profileDir,
  headless = false,
  timeout = 60000,
  loginTimeout = 10 * 60 * 1000,
  keepCitations = false,
  includeImages = true,
  maxSteps = 400,
  log = console.error,
} = {}) {
  const context = await launchPersistent(profileDir || defaultProfileDir(), { headless });
  try {
    const page = await firstPage(context);
    page.setDefaultTimeout(Math.max(60000, timeout));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    let result = await waitForChat(page, { timeout: 30000, headed: !headless, log });

    if (result.status === 'login') {
      if (headless) {
        throw new Error(
          'The saved browser profile is not logged in. Run `deepseek2pdf login` (without --headless) first, or run this command without --headless.',
        );
      }
      log('You are not logged in. Please log in in the opened browser window; waiting...');
      result = await waitForChat(page, { timeout: loginTimeout, headed: true, log, waitThroughLogin: true });
      if (result.status === 'login' || result.status === 'timeout') {
        throw new Error('Login was not detected. Run `deepseek2pdf login` and try again.');
      }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      result = await waitForChat(page, { timeout, headed: true, log });
    }

    if (result.status === 'challenge') {
      throw new Error(
        'DeepSeek is showing a browser challenge. Re-run without --headless so it can be completed interactively.',
      );
    }
    if (result.status === 'timeout' || result.status === 'login') {
      const hint = headless
        ? ' If this is a private chat, run without --headless or run `deepseek2pdf login` first.'
        : '';
      throw new Error(`Timed out waiting for the DeepSeek chat to load.${hint}`);
    }
    if (result.status === 'empty-chat') {
      throw new Error('This chat has no messages yet (or its messages could not be found).');
    }

    // If the last answer is still being generated, wait for it to finish so
    // the PDF does not contain a partial response.
    const streamStarted = Date.now();
    let lastStreamLog = 0;
    while (Date.now() - streamStarted < timeout) {
      const streaming = await page.evaluate(() => /stop generating|停止生成/i.test(document.body?.innerText || ''));
      if (!streaming) break;
      if (Date.now() - lastStreamLog > 5000) {
        log('Waiting for the response to finish generating...');
        lastStreamLog = Date.now();
      }
      await sleep(1500);
    }

    log('Collecting messages...');
    const collection = await collectAllMessages(page, { maxSteps, log });
    log(`Extracting ${collection.items.length} message${collection.items.length === 1 ? '' : 's'}...`);

    const extracted = await page.evaluate(extractConversationInPage, {
      items: collection.items,
      keepCitations,
      includeImages,
      baseUrl: page.url(),
    });

    return {
      ...extracted,
      warnings: [...collection.warnings, ...extracted.warnings],
      sourceUrl: page.url(),
      sourceLabel: 'Live DeepSeek chat',
    };
  } finally {
    await context.close();
  }
}
