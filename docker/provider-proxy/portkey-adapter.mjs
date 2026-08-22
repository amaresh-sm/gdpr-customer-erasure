import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const config = JSON.parse(fs.readFileSync('/tmp/provider-route.json', 'utf8'));
const upstream = new URL(config.upstream_url);
if (upstream.protocol !== 'https:' || !upstream.hostname || upstream.username || upstream.password) {
  throw new Error('Portkey upstream must be credential-free HTTPS');
}

const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/responses') {
    response.writeHead(403, { 'content-length': '0' }).end();
    return;
  }
  const authorization = request.headers.authorization ?? '';
  if (!authorization.startsWith('Bearer ') || authorization.length <= 7) {
    response.writeHead(401, { 'content-length': '0' }).end();
    return;
  }
  const headers = { ...request.headers };
  delete headers.authorization;
  delete headers.connection;
  delete headers.host;
  headers['x-portkey-api-key'] = authorization.slice(7);
  headers[config.route_header] = config.route_value;
  const outgoing = https.request(upstream, { method: 'POST', headers }, (incoming) => {
    const responseHeaders = { ...incoming.headers };
    delete responseHeaders.connection;
    response.writeHead(incoming.statusCode ?? 502, responseHeaders);
    incoming.pipe(response);
  });
  outgoing.once('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'content-length': '0' });
    response.end();
  });
  request.pipe(outgoing);
});

server.listen(8082, '127.0.0.1');
