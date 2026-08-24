import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateAddress(address) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:') && net.isIPv4(normalized.slice(7))) return isPrivateAddress(normalized.slice(7));
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe80:') || normalized.startsWith('fec') || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return true;
  if (!net.isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 0 || first === 10 || first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || first >= 224;
}

async function publicAddresses(hostname) {
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return [];
  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    return addresses
      .filter(({ address }) => !isPrivateAddress(address))
      .sort((left, right) => Number(right.family === 4) - Number(left.family === 4));
  } catch {
    return [];
  }
}

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

server.on('connect', async (request, client, head) => {
  const separator = request.url.lastIndexOf(':');
  const hostname = separator > 0 ? request.url.slice(0, separator).toLowerCase() : '';
  const port = Number(request.url.slice(separator + 1));
  if (port !== 443) {
    reject(client);
    return;
  }
  const [target] = await publicAddresses(hostname);
  if (!target) {
    reject(client);
    return;
  }
  const upstream = net.connect({ host: target.address, port, family: target.family });
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
