# ghostrelay

A WebSocket relay that tunnels traffic through shared hosting — connects restricted-network clients to the free internet via a Node.js relay and xray VLESS.

> **Disclaimer:** This project is intended for research and educational purposes only. It demonstrates WebSocket-based TCP tunneling techniques over shared hosting infrastructure. Users are responsible for ensuring their use complies with all applicable laws and the terms of service of any platforms involved. The authors assume no liability for misuse.

---

WebSocket relay tunnel. Your device connects directly to a shared hosting relay, which pipes traffic to an exit server that connects to the internet on your behalf.

```
your device (xray/Hiddify) ──VLESS+WS──► relay (shared hosting) ──WS──► outbound.js (exit server) ──TCP──► xray (exit server) ──► internet
```

No restricted network needed. The relay on shared hosting is the only middleman.

---

## Files

| File | Machine | Purpose |
|------|---------|---------|
| `relay.js` | shared hosting | WebSocket relay — bridges client and exit worker connections |
| `index.js` | shared hosting | Entry point — run via hosting Node.js panel |
| `outbound.js` | exit server | Persistent worker pool — connects relay to xray exit server |
| `xray-exit.json` | exit server | xray config — VLESS TCP inbound → freedom outbound |
| `xray-client.json` | your device | xray config — SOCKS5/HTTP proxy → VLESS+WS → relay |
| `.env.relay` | shared hosting | Config for relay.js |
| `.env.outbound` | exit server | Config for outbound.js |

> `xray-restricted.json` is kept as a reference for a restricted-network setup but is not required.

---

## Setup

### Clone the repository

```bash
git clone https://github.com/rostam-sodagari/ghostrelay.git
cd ghostrelay
```

### Prerequisites

- shared hosting with Node.js support (cPanel, Plesk, DirectAdmin, etc.)
- exit server with Node.js installed
- xray-core installed on the exit server
- xray / Hiddify / v2rayNG on your device

### 1. Shared hosting (relay)

Upload the project to your Node.js app directory via File Manager or Git.

```bash
npm install
```

Start via the **"Run JS Script"** button in the hosting Node.js panel.

> Do not use Passenger — it strips WebSocket upgrade headers.

The relay reads `.env.relay`:

```
PORT=3000
WS_PATH=/vmess
TUNNEL_SECRET=your-secret-key
PING_MS=20000
```

### 2. Exit server

Copy `outbound.js`, `.env.outbound`, and `xray-exit.json` to the exit server.

```bash
npm install ws
```

Start xray:

```bash
xray -c xray-exit.json
```

Start the outbound worker pool:

```bash
# with pm2 (recommended — auto-restarts on crash)
npm install -g pm2
pm2 start outbound.js -- .env.outbound
pm2 save
pm2 startup

# or with nohup
nohup node outbound.js .env.outbound > outbound.log 2>&1 &
echo $! > outbound.pid
```

The outbound reads `.env.outbound`:

```
RELAY_HOST=your.relay-domain.com
RELAY_PORT=3000
RELAY_PATH=/vmess?side=exit&secret=your-secret-key
TARGET_HOST=127.0.0.1
TARGET_PORT=10800
RECONNECT_SEC=2
POOL_SIZE=16
```

### 3. Your device (client)

#### Option A — xray config file

Use `xray-client.json` directly:

```bash
xray -c xray-client.json
```

Exposes SOCKS5 on `127.0.0.1:1080` and HTTP proxy on `127.0.0.1:8080`.

#### Option B — Hiddify / v2rayNG / Shadowrocket

Import this VLESS link:

```
vless://your-uuid-here@your.relay-domain.com:3000?encryption=none&type=ws&path=/vmess?side=client&secret=your-secret-key#tunnel-relay
```

Or enter manually:

| Field | Value |
|-------|-------|
| Protocol | VLESS |
| Address | `your.relay-domain.com` |
| Port | `3000` |
| UUID | `your-uuid-here` |
| Encryption | `none` |
| Transport | WebSocket |
| WS Path | `/vmess?side=client&secret=your-secret-key` |
| TLS | off |

---

## How it works

1. Your device sends traffic through xray as VLESS over WebSocket to `your.relay-domain.com:3000`
2. The relay on shared hosting pairs the connection with a waiting exit worker from the pre-connected pool
3. The exit worker forwards raw bytes to xray exit server on `127.0.0.1:10800`
4. xray exit server decrypts VLESS, resolves the destination using `1.1.1.1`/`8.8.8.8`, and connects to the internet

### Performance optimizations

- **VLESS instead of VMess** — no per-chunk AES encryption overhead
- **Mux** — 8 concurrent streams share one WebSocket connection
- **TCP Fast Open + TCP No Delay** — reduces handshake RTT, disables Nagle buffering
- **Pool of 16 pre-connected exit workers** — connections pair instantly, no setup delay
- **Backpressure** in outbound.js — pauses the faster side when the slower side's buffer fills
- **DNS on exit server** — domains resolved by Cloudflare/Google DNS on exit server, not locally

---

## Configuration reference

### `.env.relay`

| Key | Default | Description |
|-----|---------|-------------|
| `PORT` | `3000` | Port relay listens on |
| `WS_PATH` | `/vmess` | WebSocket path prefix |
| `TUNNEL_SECRET` | — | Shared secret — passed as `?secret=` query param |
| `PING_MS` | `20000` | Keepalive ping interval in ms |

### `.env.outbound`

| Key | Default | Description |
|-----|---------|-------------|
| `RELAY_HOST` | — | relay hostname |
| `RELAY_PORT` | `3000` | relay port |
| `RELAY_PATH` | `/` | WS path including `?side=exit&secret=...` |
| `TARGET_HOST` | `127.0.0.1` | xray exit server inbound host |
| `TARGET_PORT` | `10800` | xray exit server inbound port |
| `POOL_SIZE` | `8` | Number of pre-connected workers |
| `RECONNECT_SEC` | `2` | Seconds before reconnecting after a session ends |
| `RELAY_TLS` | `0` | Set to `1` to use `wss://` |

---

## Changing the secret

Update in three places consistently:

1. `.env.relay` → `TUNNEL_SECRET`
2. `.env.outbound` → `RELAY_PATH` (`?secret=...`)
3. `xray-client.json` → `wsSettings.path` (`?secret=...`)

The UUID `your-uuid-here` is the VLESS user ID shared between the client and `xray-exit.json`. Generate a new one with `xray uuid` if needed, and update it in both `xray-client.json` and `xray-exit.json`.

---

## Troubleshooting

**Stuck on connecting / port 3000 blocked**
ISPs in restricted regions block non-standard ports. Put Cloudflare in front of `your.relay-domain.com` (proxied, orange cloud) and connect on port 443 with TLS enabled. Cloudflare will forward to your host on port 80 via Apache reverse proxy.

**`no exit worker available` on relay**
All pool workers are busy or `outbound.js` is not running. Increase `POOL_SIZE` in `.env.outbound` or restart outbound.js.

**Connection drops after ~20s idle**
The host is terminating idle WebSocket connections. Decrease `PING_MS` in `.env.relay` to `15000`.

**`not SOCKS5 ver=N` errors on outbound**
`TARGET_HOST:TARGET_PORT` is not pointing at a running xray exit server instance. Check `xray -c xray-exit.json` is running on the exit server.

---

## License

[MIT](LICENSE)
