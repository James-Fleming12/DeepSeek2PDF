/**
 * This function is serialized and run inside Chromium with Playwright.
 * It must be completely self-contained: no imports or references to Node
 * variables are available in the page context.
 */
export async function extractConversationInPage({
  items = null,
  keepCitations = false,
  includeImages = true,
  baseUrl = null,
} = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const root = items ? document.createElement('div') : document;
  if (items) {
    root.innerHTML = items.map((item) => item.html).join('');
  }

  const warnings = [];
  const resolvedBase = baseUrl || document.baseURI || 'about:blank';

  function absoluteUrl(value, { allowMailto = false } = {}) {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    if (raw.startsWith('data:image/')) return raw;
    try {
      const url = new URL(raw, resolvedBase);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
      if (url.protocol === 'file:' && !items) return url.href;
      if (allowMailto && url.protocol === 'mailto:') return url.href;
    } catch {
      // Ignore malformed links.
    }
    return null;
  }

  async function inlineImages(container) {
    if (!includeImages) return;
    const images = [...container.querySelectorAll('img')].slice(0, 30);
    for (const img of images) {
      let src = img.getAttribute('src') || '';
      if (!src) {
        img.remove();
        continue;
      }
      if (src.startsWith('data:image/')) continue;
      const absolute = absoluteUrl(src);
      if (!absolute) {
        img.remove();
        continue;
      }
      try {
        const response = await fetch(absolute, { credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob.type.startsWith('image/') || blob.size > 8 * 1024 * 1024) {
          throw new Error('Unsupported or oversized image');
        }
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error || new Error('Could not read image'));
          reader.readAsDataURL(blob);
        });
        img.setAttribute('src', dataUrl);
        img.removeAttribute('srcset');
      } catch {
        img.remove();
      }
    }
  }

  function removeNode(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function cleanCitations(container) {
    for (const citation of [...container.querySelectorAll('[data-citation-group]')]) {
      if (!keepCitations) {
        removeNode(citation);
        continue;
      }
      const link = citation.querySelector('a[href]');
      const href = link ? absoluteUrl(link.getAttribute('href')) : null;
      let number = link ? link.getAttribute('aria-label') || '' : '';
      if (!number) {
        const match = (citation.textContent || '').match(/\d+/);
        number = match ? match[0] : '';
      }
      const sup = document.createElement('sup');
      sup.className = 'cite';
      if (href) {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.textContent = number ? `[${number}]` : '[source]';
        sup.appendChild(anchor);
      } else {
        sup.textContent = number ? `[${number}]` : '';
      }
      if (sup.textContent) citation.replaceWith(sup);
      else removeNode(citation);
    }
    for (const citation of [...container.querySelectorAll('.ds-markdown-cite')]) {
      const parent = citation.closest('[data-citation-group]');
      if (!parent) removeNode(citation);
    }
  }

  function isKaTeX(node) {
    return Boolean(node && node.closest && node.closest('.katex'));
  }

  function cleanAttributes(container) {
    const all = [container, ...container.querySelectorAll('*')];
    for (const element of all) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) continue;

      if (isKaTeX(element)) {
        for (const attr of [...element.attributes]) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on')) element.removeAttribute(attr.name);
          if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) {
            element.removeAttribute(attr.name);
          }
        }
        continue;
      }

      const tag = element.tagName.toLowerCase();
      const kept = new Map();
      for (const attr of [...element.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) continue;
        if (name === 'href' || name === 'src' || name === 'alt' || name === 'title') {
          kept.set(name, attr.value);
        } else if ((name === 'colspan' || name === 'rowspan' || name === 'start') && /^\d+$/.test(attr.value)) {
          kept.set(name, attr.value);
        } else if (name === 'class' && (tag === 'code' || tag === 'pre')) {
          const languageClass = attr.value
            .split(/\s+/)
            .filter((value) => /^language-[\w+#.-]+$/.test(value))
            .join(' ');
          if (languageClass) kept.set('class', languageClass);
        } else if (name === 'class' && tag === 'sup' && /\bcite\b/.test(attr.value)) {
          kept.set('class', 'cite');
        }
      }

      for (const attr of [...element.attributes]) element.removeAttribute(attr.name);

      if (kept.has('href')) {
        const href = absoluteUrl(kept.get('href'), { allowMailto: true });
        if (href) element.setAttribute('href', href);
      }
      if (kept.has('src')) {
        const src = absoluteUrl(kept.get('src'));
        if (src) element.setAttribute('src', src);
        else element.removeAttribute('src');
      }
      for (const name of ['alt', 'title', 'colspan', 'rowspan', 'start', 'class']) {
        if (kept.has(name)) element.setAttribute(name, kept.get(name));
      }

      if (tag === 'a' && !element.getAttribute('href')) {
        element.replaceWith(...element.childNodes);
      }
      if (tag === 'img' && !element.getAttribute('src')) {
        removeNode(element);
      }
    }
  }

  function unwrapEmptySpans(container) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const span of [...container.querySelectorAll('span')]) {
        if (isKaTeX(span)) continue;
        if (span.attributes.length === 0) {
          if (span.parentNode) {
            span.replaceWith(...span.childNodes);
            changed = true;
          }
        }
      }
    }
  }

  function removeEmptyBlocks(container) {
    for (const element of [...container.querySelectorAll('p, div, span, li')]) {
      if (isKaTeX(element)) continue;
      if (element.textContent.trim()) continue;
      if (element.querySelector('img, br, hr, svg, .katex, math, ul, ol, table, pre, blockquote')) continue;
      removeNode(element);
    }
  }

  function cleanNode(source, { user = false } = {}) {
    const clone = source.cloneNode(true);

    // Reasoning, search UI, toolbars and other non-answer chrome. The answer
    // itself lives in .ds-assistant-message-main-content, so this is mostly
    // defensive: it also handles saved pages where panels were nested.
    const removeSelectors = [
      '.ds-think-content',
      '[class*="think-content"]',
      '.ds-scroll-area__gutters',
      '.ds-button',
      'button',
      '[role="button"]',
      '.ds-icon',
      '.site_logo_back',
      '.site_logo_img',
      '.site_logo_loading',
      '.ds-collapsible-text-toggle-button',
      'script',
      'style',
      'link',
      'noscript',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'textarea',
      'select',
      'canvas',
      'video',
      'audio',
      'source',
      'track',
      'template',
    ];
    for (const selector of removeSelectors) {
      for (const node of [...clone.querySelectorAll(selector)]) removeNode(node);
    }

    // Icons are SVG, but KaTeX uses inline SVG for stretchy delimiters.
    for (const svg of [...clone.querySelectorAll('svg')]) {
      if (!isKaTeX(svg)) removeNode(svg);
    }

    // Remove "Thought for N seconds" style labels if they ever leak into the
    // answer node.
    for (const element of [...clone.querySelectorAll('*')]) {
      if (element.children.length !== 0) continue;
      const text = (element.textContent || '').trim();
      if (!text) continue;
      if (/^Thought for .{0,40}seconds?$/i.test(text)) {
        removeNode(element);
      } else if (/^(Found|Read)\s+\d+\s+(web pages?|pages?)$/i.test(text)) {
        removeNode(element);
      }
    }

    cleanCitations(clone);

    for (const element of [...clone.querySelectorAll('*')]) {
      if (element.hasAttribute('hidden')) removeNode(element);
      if (!isKaTeX(element) && element.style && element.style.display === 'none') {
        removeNode(element);
      }
    }

    if (!includeImages) {
      for (const img of [...clone.querySelectorAll('img')]) removeNode(img);
    }

    cleanAttributes(clone);
    unwrapEmptySpans(clone);
    removeEmptyBlocks(clone);

    // Remove comments, which otherwise make the extracted HTML noisier.
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    for (const comment of comments) removeNode(comment);

    if (user) {
      const text = (clone.textContent || '').trim();
      if (!text && !clone.querySelector('img, pre, code, table')) return '';
    }

    return clone.innerHTML;
  }

  const messages = [];
  let messageNodes = [...root.querySelectorAll('.ds-message')];

  if (messageNodes.length === 0) {
    // Fallback for exports that dropped the outer message wrapper.
    messageNodes = [...root.querySelectorAll('[data-virtual-list-item-key]')];
    if (messageNodes.length === 0) {
      messageNodes = [...root.querySelectorAll('.ds-assistant-message-main-content')];
    }
  }

  for (const node of messageNodes) {
    const main = node.querySelector('.ds-assistant-message-main-content')
      || (node.matches && node.matches('.ds-assistant-message-main-content') ? node : null);

    if (main) {
      await inlineImages(main);
      const html = cleanNode(main);
      if (!(html || '').trim()) continue;
      messages.push({ role: 'assistant', html });
      continue;
    }

    let body = node.querySelector('.ds-collapsible-text');
    if (!body) body = node.querySelector('.fbb737a4');
    if (!body) continue;

    let content = body;
    if (body.firstElementChild && body.firstElementChild.tagName === 'DIV'
      && !body.firstElementChild.classList.contains('ds-collapsible-text-toggle-button')) {
      content = body.firstElementChild;
    }

    await inlineImages(content);
    const html = cleanNode(content, { user: true });
    if (!(html || '').trim()) continue;
    messages.push({ role: 'user', html });
  }

  if (messages.length === 0) {
    warnings.push(
      'No DeepSeek messages were found. Save the chat page with your browser (File > Save Page As) and pass the .html file, or use a live chat.deepseek.com URL.',
    );
  } else if (!messages.some((message) => message.role === 'assistant')) {
    warnings.push('No assistant response was found in this page.');
  }

  const numericKeys = [...root.querySelectorAll('[data-virtual-list-item-key]')]
    .map((element) => Number(element.getAttribute('data-virtual-list-item-key')))
    .filter((value) => Number.isInteger(value));
  if (numericKeys.length > 1) {
    const unique = new Set(numericKeys);
    if ((Math.max(...numericKeys) - Math.min(...numericKeys) + 1) !== unique.size) {
      warnings.push(
        'This page appears to contain only part of a virtualized chat. Scroll through the whole conversation before saving the page, or use the live URL mode.',
      );
    }
  }

  const assistantBodies = [...root.querySelectorAll('.ds-assistant-message-main-content')];
  if (assistantBodies.length !== messages.filter((message) => message.role === 'assistant').length) {
    warnings.push('Some assistant responses were empty or could not be parsed and were skipped.');
  }

  let title = '';
  try {
    title = (document.title || '').replace(/\s*[-|–—]\s*DeepSeek\s*$/i, '').trim();
    if (/^DeepSeek( Chat)?$/i.test(title)) title = '';
  } catch {
    title = '';
  }
  if (!title) {
    const firstPrompt = messages.find((message) => message.role === 'user');
    if (firstPrompt) {
      const text = document.createElement('div');
      text.innerHTML = firstPrompt.html;
      title = (text.textContent || '').trim().slice(0, 90);
    }
  }

  // Give the live app a moment to finish any lazy text rendering.
  await sleep(50);

  return {
    title: title || 'DeepSeek conversation',
    messages,
    warnings,
  };
}
