import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.js';
import { cleanTitle, defaultOutputName, isDeepSeekUrl } from '../src/util.js';
import { stripActiveContent } from '../src/render.js';
import { extractFromHtmlFile } from '../src/render.js';
import { findChromium } from '../src/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('parseArgs handles defaults and common flags', () => {
  const options = parseArgs(['chat.html', '-o', 'out.pdf', '--a4', '--keep-citations', '--no-images']);
  assert.equal(options.input, 'chat.html');
  assert.equal(options.output, 'out.pdf');
  assert.equal(options.pageSize, 'A4');
  assert.equal(options.keepCitations, true);
  assert.equal(options.includeImages, false);
  assert.equal(options.headerFooter, true);
});

test('parseArgs handles live-browser flags and --flag=value forms', () => {
  const options = parseArgs([
    'https://chat.deepseek.com/a/chat/s/example',
    '--headless',
    '--profile=/tmp/profile',
    '--timeout=90',
    '--max-scroll-steps=12',
  ]);
  assert.equal(options.headless, true);
  assert.equal(options.profile, '/tmp/profile');
  assert.equal(options.timeout, 90000);
  assert.equal(options.maxSteps, 12);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
});

test('titles and output names are cleaned', () => {
  assert.equal(cleanTitle('Example Reading List - DeepSeek'), 'Example Reading List');
  assert.equal(cleanTitle('A | DeepSeek'), 'A');
  assert.equal(defaultOutputName('A/B: C?'), 'AB C.pdf');
});

test('DeepSeek URL detection', () => {
  assert.equal(isDeepSeekUrl('https://chat.deepseek.com/a/chat/s/abc'), true);
  assert.equal(isDeepSeekUrl('https://example.com/chat'), false);
});

test('stripActiveContent removes scripts and adds a CSP', () => {
  const output = stripActiveContent(
    '<html><head><title>x</title><script>alert(1)</script><link rel="stylesheet" href="x.css"></head><body onload="alert(1)"><div class="ds-message">hi</div></body></html>',
  );
  assert.doesNotMatch(output, /alert\(1\)/);
  assert.doesNotMatch(output, /<link/);
  assert.match(output, /Content-Security-Policy/);
  assert.match(output, /ds-message/);
});

test('offline extraction skips thinking and keeps answer structure', {
  skip: !findChromium() && 'Chromium is not installed',
}, async () => {
  const result = await extractFromHtmlFile(path.join(here, 'fixtures', 'sample.html'), {
    keepCitations: true,
    includeImages: false,
  });

  assert.equal(result.title, 'Fixture Chat');
  assert.equal(result.messages.length, 4);
  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);

  const assistant = result.messages[1].html;
  assert.doesNotMatch(assistant, /SECRET REASONING/);
  assert.doesNotMatch(assistant, /Found 67 web pages/);
  assert.doesNotMatch(assistant, /ds-think-content/);
  assert.doesNotMatch(assistant, /data-citation-group/);
  assert.match(assistant, /def square/);
  assert.match(assistant, /<table>/);
  assert.match(assistant, /<sup class="cite">/);

  const prompt = result.messages[0].html;
  assert.match(prompt, /Please explain/);
  assert.doesNotMatch(prompt, /Show more/);
});
