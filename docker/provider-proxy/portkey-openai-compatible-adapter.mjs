import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const config = JSON.parse(fs.readFileSync('/tmp/provider-route.json', 'utf8'));
const upstream = new URL(config.upstream_url);
if (upstream.protocol !== 'https:' || !upstream.hostname || upstream.username || upstream.password) {
  throw new Error('Portkey upstream must be credential-free HTTPS');
}

/**
 * Relays OpenCode's OpenAI-compatible requests without exposing the Portkey token
 * to the candidate container. Deliberately does not set an x-portkey-config or
 * x-portkey-provider header: Portkey receives the model requested by OpenCode.
 */
const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(403, { 'content-length': '0' }).end();
    return;
  }
  const headers = { ...request.headers };
  delete headers.authorization;
  delete headers.connection;
  delete headers.host;
  headers['x-portkey-api-key'] = config.api_key;
  const requestChunks = [];
  request.on('data', (chunk) => requestChunks.push(chunk));
  request.once('end', () => {
    let body = Buffer.concat(requestChunks);
    try {
      const payload = JSON.parse(body.toString('utf8'));
      // OpenCode's compatible provider still emits the legacy OpenAI field.
      // Portkey's newer Anthropic models require the current equivalent.
      if (payload.max_tokens !== undefined && payload.max_completion_tokens === undefined) {
        payload.max_completion_tokens = payload.max_tokens;
        delete payload.max_tokens;
        body = Buffer.from(JSON.stringify(payload));
      }
    } catch {
      // Let Portkey return its normal API error for malformed JSON.
    }
    delete headers['transfer-encoding'];
    headers['content-length'] = String(body.length);
    const outgoing = https.request(`${upstream.origin}${upstream.pathname.replace(/\/$/, '')}/chat/completions${upstream.search}`, { method: 'POST', headers }, (incoming) => {
    const responseChunks = [];
    incoming.on('data', (chunk) => responseChunks.push(chunk));
    incoming.once('end', () => {
      let requestedModel = null;
      try {
        requestedModel = JSON.parse(Buffer.concat(requestChunks).toString('utf8')).model ?? null;
      } catch {
        // Keep evidence useful even if an upstream client sent malformed JSON.
      }
      const body = Buffer.concat(responseChunks).toString('utf8');
      const returnedModel = /"model"\s*:\s*"([^"\\]+)"/.exec(body)?.[1] ?? null;
      let errorSummary = null;
      if ((incoming.statusCode ?? 502) >= 400) {
        try {
          const parsed = JSON.parse(body);
          errorSummary = String(parsed.error?.message ?? parsed.message ?? '').replace(/[\r\n]+/g, ' ').slice(0, 500) || null;
        } catch {
          errorSummary = body.replace(/[\r\n]+/g, ' ').slice(0, 500) || null;
        }
      }
      fs.writeFileSync('/tmp/portkey-direct-evidence.json', JSON.stringify({
        requested_model: requestedModel,
        returned_model: returnedModel,
        response_status: incoming.statusCode ?? 502,
        route_headers_sent: false,
        error_summary: errorSummary,
      }), { mode: 0o600 });
    });
    const responseHeaders = { ...incoming.headers };
    delete responseHeaders.connection;
    response.writeHead(incoming.statusCode ?? 502, responseHeaders);
    incoming.pipe(response);
    });
    outgoing.once('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-length': '0' });
      response.end();
    });
    outgoing.end(body);
  });
});

server.listen(8082, '127.0.0.1');
