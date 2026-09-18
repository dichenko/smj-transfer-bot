import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 1_000_000;

function secretsMatch(received, expected) {
  const receivedBuffer = Buffer.from(received ?? '');
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error('Webhook body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Webhook body is not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

export function startWebhookServer({ port, secret, onUpdate, log }) {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200).end('ok');
      return;
    }

    if (request.method !== 'POST' || request.url !== '/max/webhook') {
      response.writeHead(404).end();
      return;
    }

    if (!secretsMatch(request.headers['x-max-bot-api-secret'], secret)) {
      log('warn', 'Rejected MAX webhook with an invalid secret');
      response.writeHead(401).end();
      return;
    }

    try {
      const update = await readJson(request);
      response.writeHead(200).end();
      await onUpdate(update);
    } catch (error) {
      log('error', 'Could not process MAX webhook', { error: error.message });
      if (!response.headersSent) response.writeHead(400).end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      log('info', 'MAX webhook server is listening', { port });
      resolve(server);
    });
  });
}
