import http from 'node:http';
import net from 'node:net';

const allowedHosts = new Set([
  'auth.openai.com',
  'chatgpt.com',
  'registry.npmjs.org',
]);

function reject(socket, status = '403 Forbidden') {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(204).end();
    return;
  }
  response.writeHead(403, { 'content-length': '0' }).end();
});

server.on('connect', (request, client, head) => {
  const separator = request.url.lastIndexOf(':');
  const hostname = separator > 0 ? request.url.slice(0, separator).toLowerCase() : '';
  const port = Number(request.url.slice(separator + 1));
  if (!allowedHosts.has(hostname) || port !== 443) {
    reject(client);
    return;
  }
  const upstream = net.connect({ host: hostname, port });
  upstream.once('connect', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.once('error', () => reject(client, '502 Bad Gateway'));
  client.once('error', () => upstream.destroy());
});

server.listen(8082, '0.0.0.0');
