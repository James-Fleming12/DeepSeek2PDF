import fs from 'node:fs';
import path from 'node:path';
import {
  defaultOutputName,
  defaultProfileDir,
  expandHome,
  isDeepSeekUrl,
  isHttpUrl,
  plural,
} from './util.js';
import { extractFromHtmlFile, makeDocument, renderPdf } from './render.js';
import { extractFromUrl, login } from './live.js';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

export function parseArgs(argv) {
  const options = {
    command: null,
    input: null,
    output: null,
    title: null,
    profile: null,
    headless: null,
    keepCitations: false,
    includeImages: true,
    pageSize: 'Letter',
    headerFooter: true,
    timeout: 60000,
    loginTimeout: 10 * 60 * 1000,
    maxSteps: 400,
    debug: false,
    quiet: false,
    help: false,
    version: false,
  };

  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--') {
      if (args.length && !options.input) options.input = args.shift();
      if (args.length) throw new Error(`Unexpected argument: ${args.shift()}`);
      break;
    }

    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-v' || arg === '--version') options.version = true;
    else if (arg === 'login') options.command = 'login';
    else if (arg === '-o' || arg === '--output') options.output = requireValue(args, arg);
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
    else if (arg === '--title') options.title = requireValue(args, arg);
    else if (arg.startsWith('--title=')) options.title = arg.slice('--title='.length);
    else if (arg === '--profile') options.profile = requireValue(args, arg);
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length);
    else if (arg === '--headless') options.headless = true;
    else if (arg === '--headed') options.headless = false;
    else if (arg === '--keep-citations') options.keepCitations = true;
    else if (arg === '--no-images') options.includeImages = false;
    else if (arg === '--a4') options.pageSize = 'A4';
    else if (arg === '--letter') options.pageSize = 'Letter';
    else if (arg === '--no-header-footer') options.headerFooter = false;
    else if (arg === '--timeout') options.timeout = seconds(requireValue(args, arg));
    else if (arg.startsWith('--timeout=')) options.timeout = seconds(arg.slice('--timeout='.length));
    else if (arg === '--max-scroll-steps') options.maxSteps = positiveInt(requireValue(args, arg));
    else if (arg.startsWith('--max-scroll-steps=')) options.maxSteps = positiveInt(arg.slice('--max-scroll-steps='.length));
    else if (arg === '--debug') options.debug = true;
    else if (arg === '--quiet' || arg === '-q') options.quiet = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!options.input) options.input = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  return options;
}

function requireValue(args, flag) {
  const value = args.shift();
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
  return value;
}

function seconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error('--timeout must be a positive number of seconds.');
  return Math.round(number * 1000);
}

function positiveInt(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error('--max-scroll-steps must be a positive integer.');
  return number;
}

export function helpText() {
  return `deepseek2pdf ${packageJson.version}

Turn a DeepSeek chat into a clean, readable PDF. Thinking/search panels are
excluded, and both rendered KaTeX and raw LaTeX math are handled.

USAGE
  deepseek2pdf <chat-url> [options]
  deepseek2pdf <saved-page.html> [options]
  deepseek2pdf login

EXAMPLES
  deepseek2pdf "https://chat.deepseek.com/a/chat/s/..." -o chat.pdf
  deepseek2pdf "Example Reading List - DeepSeek.html"
  deepseek2pdf login
  deepseek2pdf chat.html --keep-citations --a4

INPUT
  chat-url       A live chat.deepseek.com URL. Uses a persistent browser profile;
                 log in once with \`deepseek2pdf login\`.
  saved-page     A page saved from chat.deepseek.com (File > Save Page As).
                 No login or network access is needed.

OPTIONS
  -o, --output <path>       Output PDF path (default: chat title)
      --keep-citations      Keep inline citation numbers as clickable superscripts
      --no-images           Omit images from answers
      --a4                  Use A4 instead of US Letter
      --no-header-footer    Omit the running header and page numbers
      --title <text>        Override the chat title
      --profile <dir>       Browser profile directory (default: ${defaultProfileDir()})
      --headless            Run live-browser mode without a visible window
      --headed              Force a visible browser window
      --timeout <seconds>   Browser/load timeout (default: 60)
      --max-scroll-steps N  Maximum virtual-list scroll steps (default: 400)
      --debug               Save the intermediate print HTML next to the PDF
  -q, --quiet               Suppress progress messages
  -h, --help                Show this help
  -v, --version             Show the version
`;
}

function log(options, message) {
  if (!options.quiet) console.error(message);
}

function warn(message) {
  console.error(`warning: ${message}`);
}

function ensureInputExists(input) {
  const absolute = path.resolve(input);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Input file not found: ${absolute}`);
  }
  if (!fs.statSync(absolute).isFile()) {
    throw new Error(`Input is not a file: ${absolute}`);
  }
  return absolute;
}

function resolveOutputPath(options, title) {
  let output = options.output;
  if (!output) output = defaultOutputName(title);
  output = expandHome(output);
  let absolute = path.resolve(output);
  if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
    absolute = path.join(absolute, defaultOutputName(title));
  }
  if (!/\.pdf$/i.test(absolute)) absolute += '.pdf';
  return absolute;
}

function sanitizeFilename(value) {
  return value.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`deepseek2pdf: ${error.message}`);
    console.error('Run `deepseek2pdf --help` for usage.');
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(helpText());
    return;
  }
  if (options.version) {
    console.log(packageJson.version);
    return;
  }

  if (options.command === 'login') {
    const profileDir = options.profile ? path.resolve(expandHome(options.profile)) : defaultProfileDir();
    try {
      await login({
        profileDir,
        timeout: options.loginTimeout,
        log: (message) => log(options, message),
      });
    } catch (error) {
      console.error(`deepseek2pdf: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (!options.input) {
    console.log(helpText());
    process.exitCode = 1;
    return;
  }

  try {
    let extracted;
    let input = options.input;
    if (!isHttpUrl(input) && /^chat\.deepseek\.com(\/|$)/i.test(input)) {
      input = `https://${input}`;
    }
    const isUrl = isHttpUrl(input);

    if (isUrl) {
      if (!isDeepSeekUrl(input)) {
        throw new Error('Live mode only supports chat.deepseek.com URLs. For another page, save it and pass the .html file.');
      }
      const profileDir = options.profile ? path.resolve(expandHome(options.profile)) : defaultProfileDir();
      const headless = options.headless === true;
      if (options.headless === null) {
        log(options, 'Opening DeepSeek in a browser window (use --headless after logging in to hide it)...');
      }
      extracted = await extractFromUrl(input, {
        profileDir,
        headless,
        timeout: options.timeout,
        loginTimeout: options.loginTimeout,
        keepCitations: options.keepCitations,
        includeImages: options.includeImages,
        maxSteps: options.maxSteps,
        log: (message) => log(options, message),
      });
    } else {
      const htmlPath = ensureInputExists(options.input);
      log(options, `Reading ${htmlPath}`);
      extracted = await extractFromHtmlFile(htmlPath, {
        keepCitations: options.keepCitations,
        includeImages: options.includeImages,
        timeout: options.timeout,
      });
    }

    for (const warning of extracted.warnings || []) warn(warning);

    if (!extracted.messages || extracted.messages.length === 0) {
      throw new Error(
        'No messages could be extracted. If this is a saved page, save it again with File > Save Page As while the full chat is visible.',
      );
    }

    const title = options.title || extracted.title || 'DeepSeek conversation';
    const outputPath = resolveOutputPath(options, title);
    const debugHtmlPath = options.debug
      ? outputPath.replace(/\.pdf$/i, '.html')
      : null;

    log(
      options,
      `Rendering ${plural(extracted.messages.length, 'message')} from “${sanitizeFilename(title)}”...`,
    );

    const html = makeDocument(extracted, { title });
    const result = await renderPdf(html, outputPath, {
      title: sanitizeFilename(title),
      pageSize: options.pageSize,
      headerFooter: options.headerFooter,
      timeout: options.timeout,
      debugHtmlPath,
    });

    if (result.renderError) warn(`Math/layout runtime: ${result.renderError}`);
    if (result.mathErrors) {
      warn(`${plural(result.mathErrors, 'equation')} could not be rendered and is shown in red in the PDF.`);
    }
    if (debugHtmlPath) log(options, `Debug HTML: ${debugHtmlPath}`);

    const size = fs.statSync(result.path).size;
    console.log(`Wrote ${result.path} (${Math.round(size / 1024)} KB)`);
  } catch (error) {
    console.error(`deepseek2pdf: ${error.message}`);
    if (options.debug && error.stack) console.error(error.stack);
    process.exitCode = 1;
  }
}
