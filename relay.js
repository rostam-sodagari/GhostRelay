const WebSocket = require('ws');
const http      = require('http');

const LISTEN_PORT = parseInt(process.env.PORT      || '3000', 10);
const SECRET      = process.env.TUNNEL_SECRET      || '';
const PING_MS     = parseInt(process.env.PING_MS   || '20000', 10);

const WS_PATH = process.env.WS_PATH || '/vmess';

function log(...a) { console.log(new Date().toISOString(), ...a); }

const upstreamPool = [];
const queue        = [];

// Ping every PING_MS; terminate if no pong within PONG_WAIT.
// Returns a cleanup function.
function keepalive(ws) {
  let alive = true;
  ws.on('pong', () => { alive = true; });

  const t = setInterval(() => {
    if (!alive) {
      clearInterval(t);
      ws.terminate();
      return;
    }
    alive = false;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(t);
  }, PING_MS);

  ws.on('close', () => clearInterval(t));
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (SECRET) {
    const token = url.searchParams.get('secret') || req.headers['x-tunnel-secret'];
    if (token !== SECRET) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  const side = url.searchParams.get('side');

  wss.handleUpgrade(req, socket, head, (ws) => {
    keepalive(ws);

    if (side === 'exit') {
      // Drain stale client queue first
      while (queue.length > 0) {
        const clientWs = queue.shift();
        if (clientWs.readyState === WebSocket.OPEN) {
          log(`[relay] exit paired with queued client (pool: ${upstreamPool.length})`);
          bridge(clientWs, ws);
          return;
        }
      }

      upstreamPool.push(ws);
      log(`[relay] exit ready (pool: ${upstreamPool.length})`);

      ws.on('close', () => {
        const i = upstreamPool.indexOf(ws);
        if (i !== -1) upstreamPool.splice(i, 1);
        log(`[relay] exit gone (pool: ${upstreamPool.length})`);
      });
      ws.on('error', (e) => log('[relay] exit error:', e.message));

    } else {
      // Drain stale exit pool entries
      let euWs = null;
      while (upstreamPool.length > 0) {
        const candidate = upstreamPool.shift();
        if (candidate.readyState === WebSocket.OPEN) { euWs = candidate; break; }
      }

      if (euWs) {
        log(`[relay] client paired (pool: ${upstreamPool.length})`);
        bridge(ws, euWs);
      } else {
        log('[relay] no exit worker available — queuing client');
        queue.push(ws);
        ws.on('close', () => {
          const i = queue.indexOf(ws);
          if (i !== -1) queue.splice(i, 1);
        });
        // Drop queued client connections that wait too long
        setTimeout(() => {
          const i = queue.indexOf(ws);
          if (i !== -1) {
            queue.splice(i, 1);
            if (ws.readyState === WebSocket.OPEN) ws.close(1013, 'no worker');
            log('[relay] client queue timeout — dropped');
          }
        }, 15000);
      }
    }
  });
});

function bridge(clientWs, euWs) {
  clientWs.on('message', (data, isBinary) => {
    if (euWs.readyState === WebSocket.OPEN) euWs.send(data, { binary: isBinary });
  });
  euWs.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
  });

  clientWs.on('close', () => { euWs.terminate(); });
  euWs.on('close',   () => { clientWs.terminate(); });
  clientWs.on('error', () => { euWs.terminate(); });
  euWs.on('error',   () => { clientWs.terminate(); });
}

server.listen(LISTEN_PORT, () => {
  log(`[relay] port ${LISTEN_PORT}  path ${WS_PATH}  ping ${PING_MS}ms`);
});
