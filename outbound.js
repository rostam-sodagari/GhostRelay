#!/usr/bin/env node
/**
 * outbound.js — exit server tunnel worker
 *
 * Keeps POOL_SIZE WebSocket connections open to the relay.
 * Each worker: connect relay → connect xray exit server VMess inbound → raw pipe → reconnect.
 *
 * Traffic path:
 *   xray client (VLESS+WS) → relay (shared hosting) → outbound.js → xray exit server (VMess TCP) → internet
 *
 * Usage: node outbound.js [env-file]   (defaults to .env.outbound)
 */

'use strict';

const WebSocket = require('ws');
const net       = require('net');
const fs        = require('fs');
const path      = require('path');

// ── config ────────────────────────────────────────────────────────────────────

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const eq = t.indexOf('=');
    const k  = t.slice(0, eq).trim();
    const v  = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnv(process.argv[2] || path.join(__dirname, '.env.outbound'));

const RELAY_HOST    = process.env.RELAY_HOST    || 'localhost';
const RELAY_PORT    = parseInt(process.env.RELAY_PORT    || '3000', 10);
const RELAY_PATH    = process.env.RELAY_PATH    || '/';
const TARGET_HOST   = process.env.TARGET_HOST   || '127.0.0.1';
const TARGET_PORT   = parseInt(process.env.TARGET_PORT   || '10800', 10);
const RECONNECT_MS  = parseInt(process.env.RECONNECT_SEC || '5',  10) * 1000;
const POOL_SIZE     = parseInt(process.env.POOL_SIZE     || '8',  10);
const TLS           = process.env.RELAY_TLS === '1';

const RELAY_URL = `${TLS ? 'wss' : 'ws'}://${RELAY_HOST}:${RELAY_PORT}${RELAY_PATH}`;

const WS_OPTS = {
  perMessageDeflate: false,
  maxPayload:        16 * 1024 * 1024,
  handshakeTimeout:  10_000,
};

function log(...a) { console.log(new Date().toISOString(), ...a); }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

// ── worker ────────────────────────────────────────────────────────────────────

async function worker(id) {
  while (true) {
    let ws, tcp;
    try {
      ws = await new Promise((resolve, reject) => {
        const w = new WebSocket(RELAY_URL, WS_OPTS);
        w.once('open',  () => resolve(w));
        w.once('error', reject);
      });

      tcp = await new Promise((resolve, reject) => {
        const s = net.createConnection({ host: TARGET_HOST, port: TARGET_PORT }, () => resolve(s));
        s.once('error', reject);
      });
      tcp.setNoDelay(true);

      log(`[out:${id}] ready`);

      await new Promise((resolve) => {
        let done = false;
        function finish() {
          if (done) return; done = true;
          try { ws.terminate(); } catch (_) {}
          try { tcp.destroy(); }  catch (_) {}
          resolve();
        }

        ws.on('message', (data) => {
          if (!tcp.writable) return finish();
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          tcp.write(buf);
          // Apply backpressure: pause WS if TCP send buffer is filling up
          if (tcp.writableLength > 256 * 1024) {
            ws.pause();
            tcp.once('drain', () => ws.resume());
          }
        });

        tcp.on('data', (data) => {
          if (ws.readyState !== WebSocket.OPEN) return finish();
          ws.send(data);
          // Apply backpressure: pause TCP if WS send buffer is filling up
          if (ws.bufferedAmount > 256 * 1024) {
            tcp.pause();
            setImmediate(function check() {
              if (ws.bufferedAmount > 128 * 1024) setImmediate(check);
              else tcp.resume();
            });
          }
        });

        ws.once('close',  finish);
        ws.once('error',  finish);
        tcp.once('close', finish);
        tcp.once('error', finish);
      });

      log(`[out:${id}] done — reconnecting`);

    } catch (err) {
      log(`[out:${id}] error: ${err.message}`);
      try { ws?.terminate(); }  catch (_) {}
      try { tcp?.destroy(); }   catch (_) {}
      await sleep(RECONNECT_MS);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

log(`[outbound] ${POOL_SIZE} workers → ${RELAY_URL} → ${TARGET_HOST}:${TARGET_PORT}`);
for (let i = 0; i < POOL_SIZE; i++) worker(i);
