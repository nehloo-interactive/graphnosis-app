---
title: Connect from Your Phone
description: Wire Claude for iOS, Claude for Android, or any HTTP MCP client into your cortex over your local network, Tailscale, or Cloudflare Tunnel.
sidebar:
  order: 4
---

Your cortex lives on your Mac. Your phone can still read from it — when Graphnosis is running and unlocked on the Mac, your mobile AI client connects over the network and gets the same `recall` / `remember` / `edit` / `forget` tools your desktop AI does. Same memory, same answers, different device.

This page walks through the 3-step in-app wizard. If you've already enabled mobile access once, the wizard skips straight to the "copy URL + token" step on subsequent opens — no toggle-fiddling for re-pairing a new device.

## Before you start

Two things should be true:

1. **Graphnosis is running on your Mac with the cortex unlocked.** Same rule as any AI client: the menu-bar icon must be visible and your passphrase entered.
2. **Your phone can reach your Mac.** Either:
   - Same Wi-Fi network (LAN), OR
   - Both devices on Tailscale (recommended — works anywhere, not just home)

Tailscale is free for personal use, takes ~5 minutes to install on both devices, and removes "I'm at a café and can't reach my cortex" as a problem class. If you don't have it, the wizard surfaces a download link in Step 2.

## Step-by-step: the mobile setup wizard

### Open the wizard

In Graphnosis, click the menu-bar icon, then **Settings → Mobile & Remote Access → "Set up mobile access…"**.

The wizard opens to one of two states:
- **First time:** Step 1 (enable + configure). Walk through all three steps.
- **Returning:** Step 3 (copy URL + token). The bridge is already on; just re-copy for a new device.

### Step 1 — Enable and choose your network interface

Three controls:

- **Enable HTTP bridge** toggle — turns the MCP-over-HTTP server on/off. Off is the default; the bridge only listens when you flip this on.
- **Port** field — defaults to `3457`. Change only if you have a port conflict.
- **Bind interface** — `loopback-only` (127.0.0.1) or `all-interfaces` (0.0.0.0). Critical security decision:

| Choice | What it does | When to use |
|---|---|---|
| `loopback-only` (default) | Bridge only accepts connections from the same Mac | You're connecting from a browser extension or local script on this Mac, not a phone |
| `all-interfaces` | Bridge accepts connections from any device that can reach this Mac's IP | You want mobile / Tailscale / LAN access |

`all-interfaces` is the right choice for mobile pairing — but it does mean the bridge is reachable from any device on your local network. The bearer token (set in Step 3) is your only authentication layer. Use a strong network (your own home Wi-Fi, Tailscale) and don't run this on a public café network with `all-interfaces` selected.

Click **Save & Next**.

### Step 2 — Confirm the network address

Graphnosis auto-detects every network interface on your Mac and surfaces them in this order of preference:

1. **Tailscale IP** (100.x.x.x range) — shown with an accent badge and a "great, use this one" tip. Tailscale traffic is end-to-end encrypted between your devices and routes through Tailscale's relay servers when direct connection isn't possible — gives you "cortex anywhere" without exposing a port to the public internet.
2. **LAN IPs** (e.g. 192.168.1.x, 10.x.x.x) — usable from any device on the same Wi-Fi network.
3. **No Tailscale detected?** The wizard surfaces a [tailscale.com/download](https://tailscale.com/download) link. We strongly recommend installing it before continuing if you'll ever leave your home network.

Pick the IP that matches your usage. The wizard remembers the choice and uses it to build the MCP Server URL in Step 3.

Click **Next**.

### Step 3 — Copy URL + token, paste into your mobile AI client

The wizard shows two values, each with a one-click Copy button:

- **MCP Server URL** — looks like `http://100.64.0.3:3457/` (Tailscale) or `http://192.168.1.42:3457/` (LAN). This is the address your mobile AI client will POST MCP requests to.
- **Bearer token** — a UUID like `a1b2c3d4-...-9876`. Masked by default; click the eye icon to reveal. This is your only auth — treat it like a password.

Below the values, numbered instructions for **Claude for iOS** and **Claude for Android**:

#### Claude for iOS

1. Open the Claude app
2. Settings → MCP Servers → Add server
3. Name: `Graphnosis` (or whatever)
4. Type: `HTTP`
5. URL: paste the MCP Server URL from the wizard
6. Authorization header: `Bearer <paste the token>`
7. Save

The new MCP server should show as connected within ~5 seconds. Start a new chat and your AI now has the Graphnosis tools (`recall`, `remember`, `dig_deeper`, etc.) available.

#### Claude for Android

Same flow — Settings → MCP Servers → Add server → fill in URL and Bearer token.

### Returning to add another device

Open the wizard again later — it skips to Step 3 since the bridge is already on. Copy the URL + token to the new device. No need to re-enable or re-configure anything.

## Without Tailscale

**LAN only (home or office Wi-Fi):** if your phone and Mac are always on the same network, you don't need Tailscale at all. Use your LAN IP from Step 2 and leave it at that. The limitation: it stops working the moment your phone leaves that network.

**Remote access without Tailscale — Cloudflare Tunnel:** Cloudflare's `cloudflared` tool punches an encrypted HTTPS tunnel from Cloudflare's edge to your Mac. Free for personal use, no port forwarding, no router config.

1. Install `cloudflared` on your Mac:
   ```sh
   brew install cloudflared
   ```
2. In Graphnosis, run the wizard with **Bind: Loopback only** (127.0.0.1) — the tunnel talks to localhost, so you don't need `all-interfaces`.
3. In a terminal, start a quick tunnel to the bridge port:
   ```sh
   cloudflared tunnel --url http://localhost:3457
   ```
   `cloudflared` prints a public `https://….trycloudflare.com` URL. That's your MCP Server URL.
4. Paste that URL (with your bearer token) into your mobile AI client the same way as Step 3.

A few caveats:
- **Quick tunnels are ephemeral** — the URL changes every time you restart `cloudflared`. For a stable URL, set up a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) with a free Cloudflare account and a domain you control.
- Traffic is encrypted end-to-end (Cloudflare terminates TLS), but Cloudflare does see the unencrypted request before it reaches your Mac. If that's a concern, use Tailscale (WireGuard, peer-to-peer — Tailscale's servers only relay metadata).
- Stop the tunnel when you're not using it. The bridge itself stays local.

## Revoking access

To cut off a device that has the token:

1. Open **Settings → Mobile & Remote Access → "Set up mobile access…"**
2. The wizard opens to Step 3 (since the bridge is already on)
3. Click **Revoke & Regenerate** below the token field
4. The token rotates immediately — the old one stops working at once

Devices that still have the old token will get `401 Unauthorized` on every request. Re-paste the new token only on devices you trust.

## Security model

- **Encryption:** all bridge traffic is plain HTTP from Graphnosis' perspective. Encryption is provided by the network layer you choose — Tailscale (WireGuard, end-to-end) or HTTPS-via-reverse-proxy if you've set one up. **Plain LAN HTTP is unencrypted** — fine for "same Wi-Fi as me," not fine for "shared WeWork network."
- **Authentication:** bearer token in the `Authorization` header. Requests without it return 401. Requests with the wrong token return 401.
- **CORS:** the bridge sets `Access-Control-Allow-Origin: *` so browser-based clients can connect. Combined with the bearer auth, this is safe (origin doesn't auth anything; the token does).
- **No public-internet exposure by default:** the bridge binds to `127.0.0.1` (loopback) until you explicitly choose `all-interfaces`. Even then, it's only reachable from your LAN unless you've explicitly forwarded the port at your router (don't).

## Troubleshooting

**Mobile client says "could not connect" / timeout**
- Confirm Graphnosis is running and cortex unlocked. Without unlock, the bridge accepts connections but every tool call returns "cortex is locked."
- Verify the IP you picked is reachable from the phone: open Safari on the phone, navigate to `http://<picked-ip>:3457/`. If you get a "401 Unauthorized" response, the IP is reachable and the bridge is up — the issue is the token. If you get a connection timeout, the IP isn't reachable (firewall, wrong interface choice, off-network).
- If using Tailscale: confirm both devices show "Connected" in the Tailscale app.

**Connected but tools return 401**
- The bearer token doesn't match. Re-open the wizard and re-copy the token from Step 3.

**Tools listed but `recall` returns nothing**
- Same as desktop: your cortex may be empty (add files first) or the active engram is empty. Try a broader query.

---

## Related

[Connect Your AI](/getting-started/connect-ai/) — desktop client setup; the wire format is the same as mobile.

[What Leaves Your Device](/guides/network-activity/) — every connection the app makes, including the mobile bridge.

[Keeping Your Cortex Safe](/guides/keeping-your-cortex-safe/) — bearer-token rotation, network isolation, and recovery.

[AI Access Controls](/guides/ai-access-controls/) — tier-aware recall over mobile is the same as desktop.

