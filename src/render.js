import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchHeadless } from './browser.js';
import { extractConversationInPage } from './extract.js';
import { buildDocumentHtml, pdfFooterTemplate, pdfHeaderTemplate } from './html.js';

/**
 * Saved DeepSeek pages include the whole app. We only need the DOM, so strip
 * scripts, stylesheets and other active/network content before parsing.
 */
export function stripActiveContent(html) {
  const stripped = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');

  // The extraction page never needs scripts. A strict CSP also disables
  // inline event handlers (onerror, onclick, ...) in untrusted saved pages.
  const csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: file:; style-src 'unsafe-inline'; font-src data: file:;\">";
  if (/<head\b[^>]*>/i.test(stripped)) {
    return stripped.replace(/<head\b[^>]*>/i, (match) => `${match}${csp}`);
  }
  return `${csp}${stripped}`;
}

export async function extractFromHtmlFile(htmlPath, {
  keepCitations = false,
  includeImages = true,
  timeout = 60000,
} = {}) {
  const absolutePath = path.resolve(htmlPath);
  const html = fs.readFileSync(absolutePath, 'utf8');
  const cleaned = stripActiveContent(html);

  const browser = await launchHeadless({ timeout });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      locale: 'en-US',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
        route.continue().catch(() => {});
      } else {
        route.abort().catch(() => {});
      }
    });

    await page.setContent(cleaned, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForSelector('.ds-message', { timeout: 5000 }).catch(() => {});

    const extracted = await page.evaluate(extractConversationInPage, {
      items: null,
      keepCitations,
      includeImages,
      baseUrl: pathToFileURL(absolutePath).href,
    });

    return {
      ...extracted,
      sourceUrl: null,
      sourceLabel: 'Saved DeepSeek page',
    };
  } finally {
    await browser.close();
  }
}

export async function renderPdf(html, outputPath, {
  title,
  pageSize = 'Letter',
  headerFooter = true,
  timeout = 60000,
  debugHtmlPath = null,
} = {}) {
  const absoluteOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });

  if (debugHtmlPath) {
    fs.mkdirSync(path.dirname(path.resolve(debugHtmlPath)), { recursive: true });
    fs.writeFileSync(path.resolve(debugHtmlPath), html, 'utf8');
  }

  const browser = await launchHeadless({ timeout });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1600 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      colorScheme: 'light',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html, { waitUntil: 'load', timeout });
    await page.waitForFunction(() => window.__deepseek2pdf_ready === true, { timeout });
    const renderError = await page.evaluate(() => window.__deepseek2pdf_error || null);
    const mathErrors = await page.evaluate(() => window.__deepseek2pdf_math_errors || 0);

    const margins = headerFooter
      ? { top: '0.82in', bottom: '0.72in', left: '0.8in', right: '0.8in' }
      : { top: '0.55in', bottom: '0.55in', left: '0.8in', right: '0.8in' };

    const options = {
      path: absoluteOutput,
      format: pageSize,
      printBackground: true,
      displayHeaderFooter: headerFooter,
      headerTemplate: headerFooter ? pdfHeaderTemplate(title) : '<div></div>',
      footerTemplate: headerFooter ? pdfFooterTemplate() : '<div></div>',
      margin: margins,
      preferCSSPageSize: false,
      tagged: true,
      outline: true,
    };

    try {
      await page.pdf(options);
    } catch {
      // Older Chromium builds may not support tagged PDF or outlines.
      delete options.tagged;
      delete options.outline;
      await page.pdf(options);
    }

    const stat = fs.statSync(absoluteOutput);
    if (!stat.size) throw new Error('The PDF was created but is empty.');

    return { path: absoluteOutput, renderError, mathErrors };
  } finally {
    await browser.close();
  }
}

export function makeDocument(extracted, options = {}) {
  return buildDocumentHtml({
    title: options.title || extracted.title,
    messages: extracted.messages,
    sourceUrl: extracted.sourceUrl || null,
    sourceLabel: extracted.sourceLabel || null,
    generatedAt: options.generatedAt || new Date(),
  });
}
