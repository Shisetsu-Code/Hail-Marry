import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));
const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
]);

/** Local static fixture server. `url` is the origin; append /game.html?mode=dom as needed. */
export async function startFixtureServer({ port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be an integer from 0 to 65535');
  const root = await realpath(fixtureRoot);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Method not allowed');
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname.includes('\0') || pathname.includes('\\')) throw new Error('Invalid path');
    } catch {
      response.writeHead(400);
      response.end('Invalid path');
      return;
    }
    if (pathname === '/') pathname = '/game.html';
    try {
      const filename = await realpath(path.resolve(root, '.' + pathname));
      const relative = path.relative(root, filename);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      const info = await stat(filename);
      if (!info.isFile()) throw new Error('Not a file');
      const body = await readFile(filename);
      response.writeHead(200, {
        'Content-Type': types.get(path.extname(filename)) || 'application/octet-stream',
        'Content-Length': body.length,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  let closing;
  return {
    url,
    gameUrl: `${url}/game.html`,
    close() {
      if (!closing) {
        closing = new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const portArg = process.argv.slice(2).find(arg => arg.startsWith('--port='));
  const fixture = await startFixtureServer({ port: portArg ? Number(portArg.slice(7)) : 4178 });
  console.log(`Fixture: ${fixture.gameUrl}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await fixture.close();
    process.exit(0);
  });
}
