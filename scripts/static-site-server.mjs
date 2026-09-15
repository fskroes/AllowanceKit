// Local-only HTTP server shared by browser QA commands. Mirrors static Vercel
// redirects, clean URLs and branded 404s without mounting production API handlers.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export async function serveStaticSite(directory, options = {}) {
  const root = path.resolve(directory);
  const configPath = path.join(root, 'vercel.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : options;
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.vtt': 'text/vtt', '.txt': 'text/plain', '.xml': 'application/xml' };
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname); }
    catch { res.writeHead(400); res.end(); return; }
    const redirect = config.redirects?.find(item => item.source === pathname);
    if (redirect) { res.writeHead(redirect.permanent ? 308 : 307, { Location: redirect.destination }); res.end(); return; }
    let file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || pathname.split('/').some(part => part.startsWith('.'))) {
      res.writeHead(404); res.end(); return;
    }
    if (config.cleanUrls && !path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
    let status = 200;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      file = path.join(root, '404.html'); status = 404;
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
    }
    const size = fs.statSync(file).size;
    const range = status === 200 && req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const headers = { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
      if (start > end) { res.writeHead(416); res.end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(status, { ...headers, 'Content-Length': size });
      fs.createReadStream(file).pipe(res);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
