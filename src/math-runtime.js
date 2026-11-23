/**
 * Runs in the print page after KaTeX has loaded.
 *
 * DeepSeek normally renders math to KaTeX. Occasionally (older responses,
 * pasted content, or the Markdown renderer treating "_" as emphasis) the page
 * contains raw \( ... \) / \[ ... \] TeX instead. This runtime repairs the
 * Markdown-mangled subscripts at the DOM level and renders the raw TeX.
 */
export function mathRuntime() {
  const PLACEHOLDER = '\uFFFC';

  function isKatex(node) {
    return Boolean(node && node.closest && node.closest('.katex'));
  }

  function looksLikeMath(text) {
    const value = String(text || '').trim();
    if (!value || value.length > 300) return false;
    if (/[\n\r]/.test(value)) return false;
    if (/^[\d,.\s]+$/.test(value)) return false;
    if (/\s{3,}/.test(value)) return false;
    // A dollar span must not swallow a real \( ... \) / \[ ... \] expression.
    if (/\\[()[\]]/.test(value)) return false;
    // Reject currency-like prose such as "$5 + tax is $10". Commands such
    // as \text{for all} are allowed to contain ordinary words.
    const hasTextCommand = /\\(text|textrm|mathrm|operatorname|mathcal|mathbb|mathbf)\b/.test(value);
    const withoutCommands = value.replace(/\\[A-Za-z]+/g, '');
    if (!hasTextCommand && /(^|[^A-Za-z])[A-Za-z]{3,}([^A-Za-z]|$)/.test(withoutCommands)) return false;
    if (/^[A-Za-z]{1,2}$/.test(value)) return true;
    if (/[\\^_=<>≤≥≠≈+\-*/]/.test(value)) return true;
    if (/[α-ωΑ-Ω]/.test(value)) return true;
    return false;
  }

  function findMath(flat, last = false) {
    const patterns = [
      { re: /(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g, display: false },
      { re: /(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g, display: true },
      { re: /\$\$([\s\S]*?)\$\$/g, display: true },
      {
        re: /(?<![\\$])\$(?!\$)([^$\n]+?)(?<!\\)\$(?!\$)/g,
        display: false,
        filter: looksLikeMath,
      },
      {
        re: /\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?|cases|matrix|pmatrix|bmatrix|vmatrix|array)\}([\s\S]*?)\\end\{\1\}/g,
        display: true,
        whole: true,
      },
    ];

    const matches = [];
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(flat)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (pattern.filter && !pattern.filter(match[1])) continue;
        const tex = pattern.whole ? match[0] : match[1];
        if (!tex || !tex.trim() || tex.length > 20000) continue;
        matches.push({ start, end, tex, display: pattern.display });
      }
    }
    if (matches.length === 0) return null;

    // Keep only outermost matches. A \[ ... \] block may contain a bare
    // \begin{align} ... \end{align} environment, and $$ ... $$ may contain
    // dollar signs; rendering the inner match first would corrupt the outer
    // expression.
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    const outer = [];
    for (const match of matches) {
      if (outer.some((candidate) => match.start < candidate.end)) continue;
      outer.push(match);
    }
    return last ? outer[outer.length - 1] : outer[0];
  }

  function flatten(block) {
    const segments = [];
    let flat = '';
    let markerId = 0;

    function addText(text, node) {
      if (!text) return;
      const start = flat.length;
      flat += text;
      segments.push({ kind: 'text', start, end: flat.length, node, text });
    }

    function addMarker(text, kind, element) {
      const start = flat.length;
      flat += text;
      segments.push({ kind, start, end: flat.length, element, markerId: markerId++ });
    }

    function addPlaceholder(element, kind = 'placeholder') {
      const start = flat.length;
      flat += PLACEHOLDER;
      segments.push({ kind, start, end: flat.length, element, markerId: markerId++ });
    }

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        addText(node.nodeValue || '', node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'template') return;
      if (isKatex(node)) {
        addPlaceholder(node);
        return;
      }
      if (tag === 'br') {
        addPlaceholder(node, 'break');
        return;
      }
      if (tag === 'code') {
        // Inline code is literal; never treat \(...\) inside it as math.
        addPlaceholder(node);
        return;
      }
      if (tag === 'em' || tag === 'i') {
        // DeepSeek's Markdown renderer turns subscripts ("_") and superscript
        // stars ("*") inside raw TeX into <em> elements. Restore the character
        // that was consumed: after a caret the missing character is almost
        // always "*", otherwise it is a subscript "_". Using the same marker
        // for both ends keeps the emphasis pair balanced.
        const before = flat.replace(/\s+$/, '').slice(-1);
        const marker = before === '^' || before === '\\' ? '*' : '_';
        addMarker(marker, 'marker-open', node);
        for (const child of [...node.childNodes]) walk(child);
        addMarker(marker, 'marker-close', node);
        return;
      }
      if (tag === 'strong' || tag === 'b') {
        addMarker('**', 'marker-open', node);
        for (const child of [...node.childNodes]) walk(child);
        addMarker('**', 'marker-close', node);
        return;
      }
      if (tag === 'img' || tag === 'svg' || tag === 'math' || tag === 'hr') {
        addPlaceholder(node);
        return;
      }
      for (const child of [...node.childNodes]) walk(child);
    }

    for (const child of [...block.childNodes]) walk(child);
    return { flat, segments };
  }

  function childIndex(node) {
    return Array.prototype.indexOf.call(node.parentNode.childNodes, node);
  }

  function boundaryAt(segments, position, preferEnd, block) {
    // Prefer a real text node so Range can split it cleanly.
    for (const segment of segments) {
      if (segment.kind !== 'text') continue;
      if (position > segment.start && position < segment.end) {
        return { node: segment.node, offset: position - segment.start };
      }
      if (position === segment.start && !preferEnd) {
        return { node: segment.node, offset: 0 };
      }
      if (position === segment.end && preferEnd) {
        return { node: segment.node, offset: segment.end - segment.start };
      }
    }

    // Element boundaries (Markdown emphasis markers, <br>, existing KaTeX).
    for (const segment of segments) {
      if (position < segment.start || position > segment.end) continue;
      if (segment.kind === 'marker-open') {
        return { node: segment.element.parentNode, offset: childIndex(segment.element) };
      }
      if (segment.kind === 'marker-close') {
        return { node: segment.element.parentNode, offset: childIndex(segment.element) + 1 };
      }
      if (segment.kind === 'break' || segment.kind === 'placeholder') {
        const index = childIndex(segment.element);
        return {
          node: segment.element.parentNode,
          offset: position === segment.start ? index : index + 1,
        };
      }
    }

    return { node: block, offset: block.childNodes.length };
  }

  function unwrapMathAncestors(node) {
    let parent = node.parentNode;
    while (parent && parent.nodeType === Node.ELEMENT_NODE
      && /^(em|i|strong|b)$/i.test(parent.tagName)) {
      const hasNonMath = [...parent.childNodes].some((child) => {
        if (child === node) return false;
        if (child.nodeType === Node.TEXT_NODE) return Boolean(child.nodeValue.trim());
        if (child.nodeType === Node.ELEMENT_NODE) {
          return !(child.classList.contains('math-rendered')
            || child.classList.contains('katex')
            || child.classList.contains('katex-display'));
        }
        return false;
      });
      if (hasNonMath) break;
      const grandparent = parent.parentNode;
      grandparent.insertBefore(node, parent);
      parent.remove();
      parent = grandparent;
    }
  }

  function renderInBlock(block) {
    let previousLength = Infinity;
    for (let guard = 0; guard < 200; guard += 1) {
      const { flat, segments } = flatten(block);
      if (flat.length >= previousLength) break;
      previousLength = flat.length;

      // Work right-to-left: rendering a later region can split the <em>
      // elements that represent missing "_" / "*" characters, so earlier
      // regions must still see the original emphasis structure.
      const match = findMath(flat, true);
      if (!match) break;

      const start = boundaryAt(segments, match.start, false, block);
      const end = boundaryAt(segments, match.end, true, block);
      if (!start || !end) break;

      let range;
      try {
        range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
      } catch {
        break;
      }
      if (range.collapsed) break;

      let rendered;
      try {
        rendered = document.createElement('span');
        rendered.className = 'math-rendered';
        rendered.innerHTML = window.katex.renderToString(match.tex.trim(), {
          displayMode: match.display,
          throwOnError: false,
          strict: 'ignore',
          trust: false,
          output: 'htmlAndMathml',
        });
      } catch {
        break;
      }

      try {
        range.deleteContents();
        range.insertNode(rendered);
        unwrapMathAncestors(rendered);
      } catch {
        break;
      }
    }
  }

  function renderRawMath(root) {
    const blockSelector = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption, caption, dd, dt, div';
    const blocks = [...root.querySelectorAll(blockSelector)].filter((element) => {
      if (isKatex(element)) return false;
      if (element.closest('pre, code')) return false;
      if (element.querySelector(blockSelector + ', ul, ol, table, pre')) return false;
      const text = element.textContent || '';
      return /\\\(|\\\[|\$\$|\\begin\{/.test(text)
        || /(?<![\\$])\$(?!\$)[^$\n]+?\$/.test(text);
    });

    for (const block of blocks) {
      renderInBlock(block);
    }
  }

  function mathContentWidth(element) {
    // `.katex-display` and `.katex-html` are often exactly as wide as the
    // page, and align environments put their equation number at the far
    // right. Measuring those elements would incorrectly shrink every
    // equation. The `.base` spans contain the actual equation body.
    const bases = [...element.querySelectorAll('.katex-html > .base')];
    if (bases.length === 0) return element.scrollWidth;
    let left = Infinity;
    let right = -Infinity;
    for (const base of bases) {
      const rect = base.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
    if (!Number.isFinite(left) || !Number.isFinite(right)) return element.scrollWidth;
    return right - left;
  }

  function fitWideMath() {
    const displays = [...document.querySelectorAll('.katex-display')];
    for (const element of displays) element.style.fontSize = '';
    // Force layout before measuring.
    void document.body.offsetWidth;

    for (const element of displays) {
      const parent = element.parentElement;
      const width = parent ? parent.getBoundingClientRect().width : document.documentElement.clientWidth;
      if (!width) continue;
      let size = 1;
      let contentWidth = mathContentWidth(element);
      while (contentWidth > width + 2 && size > 0.5) {
        size -= 0.05;
        element.style.fontSize = `${size.toFixed(2)}em`;
        contentWidth = mathContentWidth(element);
      }
    }
  }

  async function waitForImages() {
    const images = [...document.images];
    if (images.length === 0) return;
    await Promise.race([
      Promise.all(images.map((image) => {
        if (image.complete) return null;
        return new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        });
      })),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    for (const image of images) {
      if (!image.getAttribute('src') || (image.complete && image.naturalWidth === 0)) {
        image.remove();
      }
    }
  }

  async function main() {
    try {
      renderRawMath(document.body);
      await document.fonts.ready;
      await waitForImages();
      fitWideMath();
      // Images/fonts can change line breaking slightly; fit once more.
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      fitWideMath();
    } catch (error) {
      window.__deepseek2pdf_error = String((error && error.stack) || error);
    } finally {
      window.__deepseek2pdf_math_errors = document.querySelectorAll('.katex-error').length;
      window.__deepseek2pdf_ready = true;
    }
  }

  main();
}
