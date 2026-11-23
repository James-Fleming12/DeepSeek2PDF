import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mathRuntime } from './math-runtime.js';
import { escapeHtml, formatDate, plural } from './util.js';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const assetsDir = path.join(rootDir, 'assets');
const katexDir = path.join(assetsDir, 'katex');

let cachedKatexCss = null;
let cachedKatexJs = null;
let cachedPrintCss = null;

function inlineKatexCss() {
  if (cachedKatexCss) return cachedKatexCss;
  let css = fs.readFileSync(path.join(katexDir, 'katex.min.css'), 'utf8');
  css = css.replace(/url\(fonts\/([^)]+\.woff2)\)/g, (match, file) => {
    const fontPath = path.join(katexDir, 'fonts', file);
    const data = fs.readFileSync(fontPath).toString('base64');
    return `url(data:font/woff2;base64,${data})`;
  });
  cachedKatexCss = css;
  return css;
}

function katexJs() {
  if (cachedKatexJs) return cachedKatexJs;
  cachedKatexJs = fs.readFileSync(path.join(katexDir, 'katex.min.js'), 'utf8')
    .replace(/<\/script/gi, '<\\/script');
  return cachedKatexJs;
}

function printCss() {
  if (cachedPrintCss) return cachedPrintCss;
  cachedPrintCss = fs.readFileSync(path.join(assetsDir, 'print.css'), 'utf8');
  return cachedPrintCss;
}

function buildTurns(messages) {
  const turns = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'user') {
      const next = messages[index + 1];
      const answer = next && next.role === 'assistant' ? next : null;
      turns.push({ prompt: message, answer });
      if (answer) index += 1;
    } else if (message.role === 'assistant') {
      turns.push({ prompt: null, answer: message });
    }
  }
  return turns;
}

function renderPrompt(prompt) {
  if (!prompt) return '';
  return `<div class="prompt">
  <div class="prompt-label">User prompt</div>
  <div class="prompt-body">${prompt.html}</div>
</div>`;
}

function renderAnswer(answer) {
  if (!answer) return '';
  return `<div class="answer">
  <div class="answer-label">Response</div>
  <div class="answer-body">${answer.html}</div>
</div>`;
}

export function buildDocumentHtml({
  title,
  messages,
  sourceUrl = null,
  sourceLabel = null,
  generatedAt = new Date(),
}) {
  const turns = buildTurns(messages);
  const safeTitle = escapeHtml(title || 'DeepSeek conversation');
  const meta = [
    escapeHtml(plural(turns.length, 'turn')),
    escapeHtml(formatDate(generatedAt)),
    'Thinking sections omitted',
  ];

  if (sourceUrl) {
    meta.push(`<a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</a>`);
  } else if (sourceLabel) {
    meta.push(escapeHtml(sourceLabel));
  }

  const turnsHtml = turns
    .map((turn) => `<section class="turn">
${renderPrompt(turn.prompt)}
${renderAnswer(turn.answer)}
</section>`)
    .join('\n');

  const runtime = mathRuntime.toString().replace(/<\/script/gi, '<\\/script');
  const css = `${inlineKatexCss()}\n${printCss()}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: file:; style-src 'unsafe-inline'; font-src data: file:; script-src 'unsafe-inline';">
<meta name="color-scheme" content="light only">
<meta name="author" content="DeepSeek">
<meta name="generator" content="deepseek2pdf">
<title>${safeTitle}</title>
<style>${css}</style>
</head>
<body>
<main class="doc">
<header class="doc-header">
  <div class="kicker">DeepSeek conversation</div>
  <h1>${safeTitle}</h1>
  <div class="meta">${meta.join('<span class="sep">·</span>')}</div>
</header>
${turnsHtml}
</main>
<script>${katexJs()}</script>
<script>
(() => {
  if (!window.katex) {
    window.__deepseek2pdf_error = 'KaTeX failed to load';
    window.__deepseek2pdf_ready = true;
    return;
  }
  (${runtime})();
})();
</script>
</body>
</html>`;
}

export function pdfHeaderTemplate(title) {
  return `<div style="width:100%; padding:0 0.8in; color:#8a93a0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; font-size:7.5pt; display:flex; justify-content:space-between; align-items:flex-end;">
  <span style="max-width:70%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(title)}</span>
  <span>DeepSeek</span>
</div>`;
}

export function pdfFooterTemplate() {
  return `<div style="width:100%; padding:0 0.8in; color:#8a93a0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; font-size:7.5pt; text-align:center;">
  <span class="pageNumber"></span> <span style="color:#c3c9d2;">/</span> <span class="totalPages"></span>
</div>`;
}
