import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../electron/websocket-server.js', import.meta.url), 'utf8');

// A child process makes an unhandled EventEmitter error fail normally, instead of
// letting a test runner's exception handler obscure the broken port fallback.
function runServerScenario(scenario) {
  return spawnSync(process.execPath, ['-e', `
    const http = require('node:http');
    const { once } = require('node:events');
    const { WebSocket } = require(${JSON.stringify(require.resolve('ws'))});
    const errors = [];
    const moduleUnderTest = { exports: {} };
    new Function('require', 'module', ${JSON.stringify(source)})(
      id => id === './utils/logger' ? { info(){}, warn(){}, error(...args){ errors.push(args); } } : require(id),
      moduleUnderTest,
    );
    const { startWebSocketServer, stopWebSocketServer } = moduleUnderTest.exports;
    (async () => { ${scenario} })().catch(err => { console.error(err); process.exit(1); });
  `], { encoding: 'utf8', timeout: 10000 });
}

describe('WebSocket startup', () => {
  it('falls back from an occupied HTTP port and preserves health, open and WebSocket status', () => {
    const result = runServerScenario(`
      const blocker = http.createServer();
      blocker.listen(0, '127.0.0.1');
      await once(blocker, 'listening');
      const base = blocker.address().port;
      let shown = 0;
      const server = await startWebSocketServer(base, {
        onShowWindow: () => shown++,
        onStatusRequest: () => ({ recording: false, sessionId: null }),
      });
      const port = server.address().port;
      if (port <= base || port > base + 10) throw Error('Fallback outside discovery range');
      if (server.address().address !== '127.0.0.1') throw Error('Binding changed');
      const health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
      if (!health.ok || health.app !== 'MeetScribe') throw Error('Health changed');
      await fetch('http://127.0.0.1:' + port + '/open');
      if (shown !== 1) throw Error('Open handler changed');
      const client = new WebSocket('ws://127.0.0.1:' + port, { origin: 'chrome-extension://test' });
      const [message] = await once(client, 'message');
      if (JSON.parse(message).type !== 'APP_STATUS') throw Error('Status changed');
      client.close();
      await once(client, 'close');
      stopWebSocketServer();
      blocker.close();
    `);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('rejects non-port-conflict startup errors instead of retrying', () => {
    const result = runServerScenario(`
      try {
        await startWebSocketServer(-1, {});
        throw Error('Expected an invalid-port rejection');
      } catch (err) {
        if (err.code !== 'ERR_SOCKET_BAD_PORT') throw err;
      }
    `);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('handles HTTP-forwarded and WebSocket server errors after listening', () => {
    const result = runServerScenario(`
      const server = await startWebSocketServer(0, {});
      server._server.emit('error', new Error('HTTP runtime failure'));
      server.emit('error', new Error('WebSocket runtime failure'));
      if (errors.length !== 2) throw Error('Expected both server errors to be logged');
      stopWebSocketServer();
    `);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
