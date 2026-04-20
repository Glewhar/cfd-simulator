const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.stl':  'model/stl',
  '.obj':  'text/plain',
};

// Permissive CORS so the STL samples load from any origin (e.g. dev preview
// frame, alternate ports). Also handles OPTIONS preflight.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, CORS_HEADERS); res.end('Not found'); return; }
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'text/plain' }, CORS_HEADERS));
    res.end(data);
  });
}).listen(PORT, () => console.log('Server running on http://localhost:' + PORT));
