# DeepSeek2PDF

Turn a [chat.deepseek.com](https://chat.deepseek.com) conversation into a clean,
readable PDF:

- **Thinking sections, search panels, and UI controls are omitted.** Only the
  assistant's final answer is printed.
- **Math is rendered properly.** Existing KaTeX markup is preserved, and raw
  `\( ... \)`, `\[ ... \]`, `$$ ... $$`, and bare LaTeX environments are
  rendered with KaTeX. Markdown-mangled subscripts/superscripts in raw TeX are
  repaired.
- **Works offline from saved pages** as well as **live from a chat URL**.
  This is a standalone CLI, not a browser extension.

The output is a letter/A4 document with a title block, the user prompt, the
response, tables, code blocks, links, and page numbers.

## Requirements

- Node.js 20+
- Chromium, Google Chrome, or Microsoft Edge
  - Set `CHROME_PATH` if the browser is not in a standard location.
- No browser download is required; `playwright-core` drives the browser you
  already have.

## Install

```bash
cd DeepSeek2PDF
npm install
npm link          # optional: puts `deepseek2pdf` on your PATH
```

Without `npm link`, use `node bin/deepseek2pdf.js` in place of
`deepseek2pdf`.

## Quick start: saved page (no login)

1. Open the chat on chat.deepseek.com.
2. Save the page with **File → Save Page As** (HTML). Scroll through the whole
   conversation first so the virtualized list has rendered every message.
3. Run:

```bash
deepseek2pdf "Example Reading List - DeepSeek.html"
```

The PDF is written next to your current directory, named after the chat title.
Use `-o` to choose a path:

```bash
deepseek2pdf "Example Reading List - DeepSeek.html" \
  -o "Example Reading List.pdf"
```

Saved pages work offline: scripts, stylesheets, and external resources are
discarded before the conversation is extracted.

## Quick start: live chat URL

The first run needs a browser login. This saves a dedicated Chromium profile so
the tool does not touch your normal browser profile:

```bash
deepseek2pdf login
```

A browser window opens. Log in to DeepSeek, and the window closes once login is
detected. Then:

```bash
deepseek2pdf "https://chat.deepseek.com/a/chat/s/..." -o chat.pdf
```

By default live mode opens a visible browser (handy for Cloudflare challenges
and expired sessions). After logging in, you can hide it:

```bash
deepseek2pdf "https://chat.deepseek.com/a/chat/s/..." --headless
```

If the session expires, run `deepseek2pdf login` again. The profile is stored at
`~/.cache/deepseek2pdf/chromium-profile` on Linux, or the equivalent cache
directory on macOS/Windows. Override it with `--profile`.

## What is included

The tool extracts `.ds-assistant-message-main-content`, the same node DeepSeek
uses for the final answer. The reasoning/thinking panel
(`.ds-think-content`), search result cards, “Thought for N seconds”, citation
badges, and toolbar icons sit outside that node and are not printed.

By default, inline citation badges are removed. Use `--keep-citations` to keep
them as small clickable superscripts.

## Math handling

DeepSeek normally emits KaTeX, which is preserved and styled. Some saved chats
contain raw TeX instead. The renderer:

1. Reconstructs TeX split across inline HTML (DeepSeek's Markdown renderer
   sometimes turns `_` or `*` inside math into `<em>` elements).
2. Renders inline and display math with KaTeX.
3. Leaves code blocks untouched, so `\(x^2\)` inside code stays code.
4. Scales unusually wide display equations down to fit the page.

KaTeX CSS, JavaScript, and fonts are vendored in `assets/katex/`, so offline
PDFs do not need a network connection.

## Options

```
-o, --output <path>       Output PDF path (default: chat title)
    --keep-citations      Keep inline citation numbers as clickable superscripts
    --no-images           Omit images from answers
    --a4                  Use A4 instead of US Letter
    --no-header-footer    Omit the running header and page numbers
    --title <text>        Override the chat title
    --profile <dir>       Browser profile directory
    --headless            Run live-browser mode without a visible window
    --headed              Force a visible browser window
    --timeout <seconds>   Browser/load timeout (default: 60)
    --max-scroll-steps N  Maximum virtual-list scroll steps (default: 400)
    --debug               Save the intermediate print HTML next to the PDF
-q, --quiet               Suppress progress messages
-h, --help                Show help
-v, --version             Show version
```

## How it works

1. **Extract** the message nodes from a saved page or from a live browser
   session (Playwright + the locally installed Chromium).
2. **Clean** the answer HTML: remove thinking/search chrome, citation badges,
   scripts, event handlers, app classes, and DeepSeek's dark-theme inline
   styles.
3. **Build** a self-contained print document with a reading-oriented stylesheet
   and inlined KaTeX assets.
4. **Render** raw LaTeX, fit wide display math, wait for fonts/images, and print
   to PDF with Chromium.
5. **Add** a running header, page numbers, and PDF metadata/title.

## Limitations

- DeepSeek can change its DOM class names. Extraction is based on the current
  `.ds-message` / `.ds-assistant-message-main-content` structure (the same
  structure present in saved pages).
- Live mode is subject to DeepSeek's login and bot-protection behavior. If
  headless mode is blocked, use the visible browser (default) once to establish
  the profile.
- Saved pages only contain the messages that were rendered when the page was
  saved. Scroll through the conversation before saving.
- Images in offline saved pages are omitted if their local `_files` assets are
  missing. Live mode embeds images as data URLs when possible.
- Attachments uploaded by the user (separate file/image cards rather than text
  in the prompt) are not included. Inline images in the assistant's answer are
  included.

## Development

```bash
npm test
```

Tests cover argument parsing, title/output naming, saved-page extraction,
thinking/search removal, and citation conversion. The extraction test is
skipped automatically if no Chromium installation is found.

## Layout

```
bin/deepseek2pdf.js       CLI entry point
src/cli.js                argument parsing and orchestration
src/extract.js            in-browser DOM extraction and cleanup
src/live.js               persistent-profile login, scrolling, live extraction
src/math-runtime.js       raw-TeX repair and KaTeX rendering
src/html.js               print document/template builder
src/render.js             offline extraction and Chromium PDF printing
src/browser.js            Chromium discovery/launch helpers
assets/print.css          reading-oriented print styles
assets/katex/             vendored KaTeX CSS, JS, and WOFF2 fonts
test/fixtures/sample.html synthetic DeepSeek page used by tests
```
