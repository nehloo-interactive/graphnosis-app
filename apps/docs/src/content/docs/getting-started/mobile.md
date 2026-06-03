---
title: Connect from Your Phone
description: Reach your cortex from any device's browser — open the full Graphnosis app over your local network or Tailscale, scan a QR to unlock, and connect Claude for iOS/Android over MCP.
sidebar:
  order: 4
---

Your cortex lives on your computer. Your phone — or any other device with a browser — can still reach it. When Graphnosis is running and unlocked, it can serve the **full app UI** over the network, so you open your cortex in mobile Safari or Chrome and get the same atlas, recall, and capture you have on the desktop. The cortex itself never leaves the server; it stays encrypted on disk and only the screens you look at travel over the wire.

There are two ways to reach your cortex remotely, and you can use both at once:

1. **Browser access (personal server)** — the app UI in any browser, on port `3456`. This is the new "open my cortex from my phone" path.
2. **MCP access** — wire a mobile AI client (Claude for iOS/Android) into your cortex over MCP, on port `3457`. This is the "let my phone's AI recall from my memory" path.

The desktop app is unchanged and remains the primary way to use Graphnosis. Browser access is an opt-in addition, not a replacement.

## How browser access works

When you enable browser access, the sidecar starts a second HTTP server:

- **Port `3456`** serves the full web UI plus a small JSON-RPC + event API that the UI talks to. This is separate from the MCP server on **port `3457`**.
- You authenticate once with an **access token**. The server exchanges it for a short-lived browser session (24 hours), and the browser uses that session for everything after.
- The cortex stays encrypted on the server. The browser is just a remote screen — there's no copy of your memory on the phone.

The same machine can run the desktop app and the browser server side by side. (On a headless Linux box with no desktop app at all, the browser server *is* the whole product — see [the self-host guide](#run-it-headless-on-a-server) below.)

## Before you start

Two things should be true:

1. **Graphnosis is running with the cortex unlocked.** Same rule as any AI client: the app must be running and your passphrase entered. A locked cortex serves the login screen but no memories.
2. **Your phone can reach the server.** Either:
   - Same Wi-Fi network (LAN), OR
   - Both devices on the same Tailscale network (recommended — works anywhere, not just home).

Tailscale is free for personal use, takes a few minutes to install on both devices, and removes "I'm at a café and can't reach my cortex" as a problem class. More on it below.

## Enable browser access

In Graphnosis, click the menu-bar icon, then **Settings → Mobile & Remote → Browser access** and turn it **on**.

The panel then shows everything you need to connect:

- A **QR code** — scan it with your phone's camera. The QR encodes the URL *and* the access token together, so one scan opens the app already authenticated — no typing.
- The **URL** (e.g. `http://100.64.0.3:3456/` over Tailscale, or `http://192.168.1.42:3456/` on your LAN) and the **access token**, both with a one-click copy button, for the manual path.

### From your phone

- **One-scan path:** open the camera, scan the QR, tap the link. The app loads and unlocks in one step.
- **Manual path:** open the URL in your phone's browser, then paste the access token when prompted. The server swaps it for a browser session and you're in.

Add the app to your home screen (Share → Add to Home Screen) and it behaves like an installed app on the next launch.

## Why Tailscale is recommended

Plain LAN access works at home, but the moment your phone leaves that Wi-Fi network the URL stops resolving. [Tailscale](https://tailscale.com/download) fixes that: it builds an encrypted overlay network (WireGuard) between your own devices, so your phone reaches the server by its stable `100.x.y.z` address whether you're on home Wi-Fi, on cellular, or on a café network — **without exposing any port to the public internet**. Traffic is end-to-end encrypted between your devices.

Install it once:

1. **On the server** — `curl -fsSL https://tailscale.com/install.sh | sh` (Linux/macOS) or the desktop installer, then `tailscale up`.
2. **On your phone** — install the Tailscale app from the App Store / Play Store and sign in with the **same account** so both devices land on the same tailnet.

With both devices on the tailnet, use the `100.x.y.z` URL the panel shows. The QR auto-detects Tailscale and prefers it.

### HTTPS for iOS — `tailscale serve`

Plain `http://100.x:3456` already rides WireGuard and is encrypted, but **iOS refuses plaintext HTTP to non-localhost hosts** (App Transport Security). To reach the server from an iPhone, front it with a real certificate using `tailscale serve`, which terminates a valid `*.ts.net` cert for you — no certificate setup on the server.

Once `tailscale serve` is running, the **QR auto-switches** to the `https://<host>.<tailnet>.ts.net/` address. The browser UI (`:3456`) and the MCP bridge (`:3457`) each need their own Serve mapping — one puts the UI on `443`, a second puts MCP on `8443`. The exact two commands live in the self-host guide at **`deploy/linux/README.md`** in the repository (section *Reach it from your phone over Tailscale → real-cert HTTPS*); that guide is the source of truth, so we don't duplicate the commands here.

## Security model

- **The access token gates entry.** Browser access binds nothing to a public address by itself — the token is what authorizes a device. Treat it like a password. A correct token is exchanged for a 24-hour browser session; a wrong token is rejected with `401 Unauthorized`.
- **Loopback vs all-interfaces.** The server can bind two ways:
  - **Loopback only (`127.0.0.1`)** — reachable *only* from the same machine. This is the safe default for a desktop where you'd reach it through a Tailscale/`tailscale serve` front rather than directly.
  - **All interfaces (`0.0.0.0`)** — reachable from any device that can route to this machine's IP. This is what LAN and direct-Tailscale-IP access need. The tradeoff: any device on the same network can *attempt* a connection — but without the token, every attempt is rejected. Use it on networks you trust (home Wi-Fi, your tailnet), not on shared/public Wi-Fi.
- **Revoke a leaked token.** In **Settings → Mobile & Remote**, click **Revoke & Regenerate**. The old token stops working immediately; any device still holding it gets `401` on its next request. Re-scan the new QR on the devices you trust.

## Without Tailscale

**LAN only (home or office Wi-Fi).** If your phone and the server are always on the same network, you don't need Tailscale at all — use the LAN URL the panel shows. The limit: it stops working the moment the phone leaves that network, and it's plain HTTP (fine for your own Wi-Fi, not for a shared WeWork/café network).

**Public access without Tailscale — Cloudflare Tunnel (advanced, optional).** If you specifically need to reach the server from anywhere and don't want Tailscale, Cloudflare's `cloudflared` punches an encrypted HTTPS tunnel from Cloudflare's edge to your machine — no port forwarding, free for personal use:

```sh
brew install cloudflared
cloudflared tunnel --url http://localhost:3456
```

`cloudflared` prints a public `https://….trycloudflare.com` URL; open it on your phone and paste the access token. The privacy tradeoff vs Tailscale: **Cloudflare terminates TLS, so it sees the unencrypted request before it reaches your machine.** Tailscale (peer-to-peer WireGuard) does not — its servers only relay metadata. If that distinction matters to you, prefer Tailscale. This path is for people who know they want it.

## Connect Claude for iOS / Android (MCP)

Browser access gives you the *app*. To give your phone's *AI client* recall from your cortex, add Graphnosis as an MCP server using the **MCP Server URL** and **bearer token** from the same **Settings → Mobile & Remote** panel. The MCP bridge runs on port `3457`.

### Claude for iOS

1. Open the Claude app
2. **Settings → MCP Servers → Add server**
3. **Name:** `Graphnosis` (or anything)
4. **Type:** `HTTP`
5. **URL:** paste the MCP Server URL from the panel (over `tailscale serve` this is the `https://…:8443/mcp` form iOS requires)
6. **Authorization header:** `Bearer <paste the token>`
7. Save

The server should show as connected within a few seconds. Start a new chat and your AI has the Graphnosis tools (`recall`, `remember`, `dig_deeper`, …) available.

### Claude for Android

Same flow — **Settings → MCP Servers → Add server** → fill in the URL and Bearer token.

To cut off a device, use **Revoke & Regenerate** in the same panel — it rotates the token, and every device holding the old one gets `401` on its next request.

## Run it headless on a server

You don't need a Mac or a desktop app at all. The sidecar runs standalone on a Linux box (or in Docker) and serves the same browser UI on `:3456` and MCP on `:3457`, reachable from your phone over Tailscale. The cortex stays encrypted on that machine.

Full instructions — build, systemd unit, Docker image, `tailscale serve` HTTPS, and tailnet ACLs to control who can reach the two ports — are in the self-host guide at **`deploy/linux/README.md`** in the repository. Run a personal server once and every device on your tailnet can open your cortex.

## Troubleshooting

**Phone can't load the URL / connection times out**
- Confirm Graphnosis is running and the cortex is unlocked.
- Check the bind setting: a `127.0.0.1` (loopback-only) server is not reachable from another device — switch to all-interfaces, or front it with `tailscale serve`.
- Verify reachability: open the URL in the phone's browser. A login/token prompt means the server is reachable and the issue (if any) is the token. A timeout means the IP isn't reachable (wrong interface, firewall, off-network).
- On Tailscale: confirm both devices show "Connected" in the Tailscale app.

**iPhone refuses to load `http://…`**
- iOS blocks plaintext HTTP to non-localhost hosts. Set up `tailscale serve` so the QR/URL switches to `https://…ts.net` — see the self-host guide.

**Loaded the app but it says the cortex is locked**
- Unlock it on the server (or via the browser login screen). Browser access serves the login screen but no memories until the cortex is unlocked.

**MCP client connects but tools return 401**
- The bearer token doesn't match. Re-open **Settings → Mobile & Remote** and re-copy the token.

---

## Related

[Connect Your AI](/getting-started/connect-ai/) — desktop client setup; the MCP wire format is the same as mobile.

[Memory Across AI Clients](/guides/memory-across-ai-clients/) — save on one device, recall on another, including the phone flow.

[What Leaves Your Device](/guides/network-activity/) — every connection the app makes, including the browser server and the mobile bridge.

[Keeping Your Cortex Safe](/guides/keeping-your-cortex-safe/) — token rotation, network isolation, and recovery.
