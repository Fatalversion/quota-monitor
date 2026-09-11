#!/usr/bin/env node
/**
 * A static file server for ui/, for design work in a normal browser.
 *
 * WHY THIS IS NEEDED AT ALL
 * -------------------------
 * ui/index.html is deliberately buildless, but it is also a real ES module
 * page: it does `import ... from './panel.js'` and `fetch('./fixture.json')`.
 * Both are subject to CORS, and a `file://` page has an opaque origin, so
 * double-clicking index.html gets you a blank widget and a console full of
 * CORS errors in Chrome, Edge and Firefox alike. That is a browser rule, not
 * something the page can opt out of.
 *
 * So: forty lines of node:http, no dependency, no bundler, no watch mode. Edit
 * a file, reload the tab.
 *
 *   node scripts/serve-ui.mjs [--port 4173]
 *
 * It binds to 127.0.0.1 and serves ui/ read-only. Nothing leaves the machine.
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { ROOT, die, info, step } from './lib/toolchain.mjs';

const UI_DIR = join(ROOT, 'ui');
const HOST = '127.0.0.1';

let port = 4173;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--port') {
    port = Number(argv[++i]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) die('--port needs a port number');
  } else {
    die(`Unknown option "${argv[i]}".\nUsage: node scripts/serve-ui.mjs [--port <n>]`);
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;

  // Path traversal check: resolve, then confirm the result is still inside ui/.
  const target = resolve(UI_DIR, `.${normalize(decodeURIComponent(requested))}`);
  if (target !== UI_DIR && !target.startsWith(UI_DIR + sep)) {
    res.writeHead(403).end('outside ui/');
    return;
  }

  let stats;
  try {
    stats = statSync(target);
  } catch {
    res.writeHead(404).end(`not found: ${requested}`);
    return;
  }
  if (!stats.isFile()) {
    res.writeHead(404).end(`not a file: ${requested}`);
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
    'content-length': stats.size,
    // Design work means reloading constantly; a cached panel.js is a trap.
    'cache-control': 'no-store',
  });
  createReadStream(target).pipe(res);
});

server.on('error', (error) => {
  die(
    error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Try: node scripts/serve-ui.mjs --port ${port + 1}`
      : String(error),
  );
});

server.listen(port, HOST, () => {
  step('Serving ui/ for design work');
  info(`strip + hover panel:  http://${HOST}:${port}/`);
  info(`tray popover mode:    http://${HOST}:${port}/?mode=panel`);
  info('data comes from ui/fixture.json (no Tauri, no providers, no network)');
  info('Ctrl+C to stop');
});
