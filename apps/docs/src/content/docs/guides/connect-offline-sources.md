---
title: Connect Offline Sources
description: Plug any off-the-grid data source into Graphnosis — smart-home sensors, NAS, scanned PDFs, local databases, lab instruments, anything emitting events. No cloud round-trip, no API keys, no data leaving your network.
sidebar:
  order: 3
---

The built-in **Data sources** in the sidebar — RSS, GitHub, Slack, Trello,
Linear, Obsidian, GBrain, AI Context Files — all talk to either cloud SaaS
or local files. But Graphnosis itself doesn't care where memory comes from.
Anything you can pipe into **a file on disk** or **an HTTP webhook** can
become a source. This page walks through every category of off-the-grid
data the app can ingest, with step-by-step recipes you can copy.

> The principle: **Graphnosis needs a file or a webhook. What's on the other
> side of either is up to you.** No data leaves your network at any stage of
> any pattern below.

## Quick map

| If your data lives in… | The pattern is… |
|---|---|
| A file on disk | Drag onto the app, or watch the folder with the Obsidian connector |
| A folder of files that grows over time | Mount it (NAS) and treat as a watched folder |
| A scanned PDF or paper document | Drop the PDF; OCR runs locally |
| A smart-home broker (MQTT) | Bridge script → Webhook connector |
| A sensor / instrument speaking serial / USB / network | Tiny reader script → Webhook connector |
| A local database (SQLite, Postgres on LAN) | Cron-driven export script → Webhook or folder drop |
| An on-device notes app (Apple Notes, Bear, Logseq) | App's CLI export → watched folder |
| A log file (router syslog, audio transcripts, DVR) | Tail script → Webhook, or watch the log directly |

The rest of this page expands each row with concrete commands.

---

## 1. Local files & folders

The simplest possible source. **Drop any file on the app window** and
Graphnosis ingests it: PDFs (with local OCR for scanned pages), markdown,
plain text, code, HTML, EPUB, .docx, .xlsx, JSON, CSV.

For a **growing folder** (notes you keep editing, exports written by a
script, screenshots), use one of the existing folder-watching connectors:

- **Obsidian** — point at your vault root; new notes ingest as you save them.
- **AI Context Files** — `CLAUDE.md`, `AGENTS.md`, `CURSOR_RULES`, `GEMINI.md`
  and any other AI-rule file in a project folder.
- **GBrain** — your local Git repo of plain-text notes.

All three are file-watcher connectors with no cloud component. Configure
each in **Settings → Data sources**.

### Effective Graphnosis usage

- Tag the engram for notes that change often as `personal` (default) so the
  recall budget is generous.
- For an "all my notes" engram that holds thousands of files, sensitivity
  `public` keeps recall fast and skips the consent gate.

---

## 2. NAS / network drives

A NAS is just a remote folder once you mount it. On macOS:

```bash
# Finder → Go → Connect to Server → smb://nas.local/your-share
# After mount, your share lives at /Volumes/your-share
```

Then ingest it like any local folder — drag the mount onto the app, or
add it as an Obsidian-style watched folder via **Settings → Data sources →
add custom folder**.

### Recipe: keep family photos' metadata searchable without sending them anywhere

```bash
# 1. Mount the NAS share that holds your photo archive.
# 2. On a cron, generate a JSON-line file of just metadata
#    (no images leave the NAS — only EXIF data is indexed).
exiftool -j -r /Volumes/photos > /Volumes/photos/.index.jsonl
# 3. Point Graphnosis at /Volumes/photos/.index.jsonl.
```

Now `recall pictures from the Greece trip` returns the EXIF entries the
photos came from, with date + location + camera — and you click through
to the actual files in Finder. The images themselves never enter the
cortex.

---

## 3. Scanned PDFs / paper records

Drop any scanned PDF onto the app. Graphnosis runs OCR **locally** (no
cloud round-trip) using the bundled engine, splits the result into
chunks, and indexes them like any other text.

### Common use cases

- **Handwritten meeting minutes** photographed or scanned — searchable
  alongside the meeting's Slack thread.
- **Tax records, contracts, lease agreements** — find clauses across
  years of paperwork.
- **Volunteer intake forms** for nonprofits — recall a former volunteer's
  emergency contact without re-reading the file folder.
- **Lab notebooks** photographed page-by-page — date and topic become
  searchable.

### Effective Graphnosis usage

- Use a `sensitive`-tier engram for tax / health / legal scans. The
  consent gate fires before any AI client can read them.
- Name the engram by topic (`Legal`, `Tax-2024`), not by source —
  Graphnosis routes future related ingests by name similarity.

---

## 4. Smart home — Home Assistant, MQTT, Zigbee, Z-Wave

Your smart-home hub already speaks MQTT (or can be configured to). Bridge
its events into Graphnosis via the **Webhook** connector. Two patterns:

### Pattern A — Watch the broker's log file

If your broker writes events to disk (mosquitto with `log_dest file …`),
just point a folder watcher at the log directory. Each new line becomes
an ingested chunk.

### Pattern B — Live bridge via the Webhook connector

The Webhook connector exposes a localhost endpoint Graphnosis listens on.
A small script subscribes to MQTT and POSTs each event:

```python
#!/usr/bin/env python3
# mqtt-to-graphnosis.py
import json, time, urllib.request
import paho.mqtt.client as mqtt

WEBHOOK_URL = "http://localhost:7779/webhook/smart-home"  # from Settings → Data sources → Webhook

def on_message(client, userdata, msg):
    payload = {
        "ts": int(time.time()),
        "topic": msg.topic,
        "value": msg.payload.decode(errors="replace"),
    }
    urllib.request.urlopen(
        urllib.request.Request(WEBHOOK_URL, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}),
        timeout=2,
    ).close()

c = mqtt.Client()
c.on_message = on_message
c.connect("mqtt.local", 1883)
c.subscribe("#")  # everything; narrow this for production
c.loop_forever()
```

Run it on the same machine as your hub (or as a Home Assistant add-on),
and every device event becomes a memory node.

### Effective Graphnosis usage

- Create a dedicated `Home` engram and route the webhook there.
- Once you have a few weeks of data, ask the local LLM via Claude or
  Cursor: *"recall what triggers the heater between 2 and 4 AM"* — it
  correlates sensor false-positives with automation rules you wrote
  months ago and forgot.
- Pair this with the `Home Assistant` YAML files (drop the `automations.yaml`
  folder in too) for a complete "what's installed + what's actually
  happening" view.

---

## 5. Sensors / IoT / lab instruments / agriculture

Any device emitting structured events — temperature probes, soil-moisture
sensors, weather stations, lab spectrometers, factory PLCs, hardware
counters — is the same shape as MQTT: a tiny reader script that POSTs to
the Webhook connector.

### Recipe: a serial-port sensor on a Raspberry Pi

```python
#!/usr/bin/env python3
# serial-to-graphnosis.py
import json, time, urllib.request
import serial

WEBHOOK_URL = "http://localhost:7779/webhook/sensors"
PORT = "/dev/ttyUSB0"

ser = serial.Serial(PORT, 9600)
while True:
    line = ser.readline().decode().strip()
    if not line:
        continue
    try:
        # Example: sensor sends '23.4,68.2,1013' (temp,humidity,pressure)
        t, h, p = [float(x) for x in line.split(",")]
        payload = {"ts": int(time.time()), "temp_c": t, "humidity_pct": h, "pressure_hpa": p}
        urllib.request.urlopen(
            urllib.request.Request(WEBHOOK_URL, data=json.dumps(payload).encode(), headers={"Content-Type":"application/json"}),
            timeout=2,
        ).close()
    except Exception:
        pass
    time.sleep(60)  # one event per minute is plenty for memory
```

### Effective Graphnosis usage

- **Don't ingest every reading.** Sample at a sane cadence (per-minute or
  per-event-of-note) — the memory layer isn't a time-series database.
  Use `condition: only POST when value changes by >X` to keep the cortex
  sparse and recall meaningful.
- For long-term trends, batch into hourly summaries via cron before POSTing.
- Use a `Lab` / `Greenhouse` / `Workshop` engram per project; cross-engram
  links surface unexpected correlations.

---

## 6. Local databases (SQLite, Postgres on LAN, DuckDB)

Two patterns:

### Pattern A — Periodic export to JSON/CSV + folder watch

```bash
# Cron: every hour, export new rows since last run
psql graphnosis -c "\COPY (SELECT * FROM events WHERE ts > NOW() - interval '1 hour') TO STDOUT WITH CSV HEADER" \
  > /Users/me/graphnosis-feeds/db-events-$(date +%s).csv
```

Point Graphnosis at `/Users/me/graphnosis-feeds/`. New CSVs ingest
automatically.

### Pattern B — Cron-driven webhook

```bash
# Same query, POST each row as JSON.
psql graphnosis -At -c "SELECT row_to_json(t) FROM events t WHERE ts > NOW() - interval '1 hour'" \
  | while read row; do
      curl -s -H "Content-Type: application/json" -d "$row" \
        http://localhost:7779/webhook/db
    done
```

### Effective Graphnosis usage

- For **append-only logs**, Pattern A is simpler.
- For **transactional events** you want to flag in near-real-time, Pattern B.
- Treat the cortex as a **memory layer over your DB**, not a replacement.
  Recall hits surface the right database rows by their *meaning*; you go
  to the DB for the full record.

---

## 7. Local notes apps — Apple Notes, Bear, Logseq, Notion local cache

Most local-first notes apps have CLI exporters. Drive them on a cron and
point Graphnosis at the output folder.

### Apple Notes (macOS)

```bash
# Via the open-source `notes-export` tool, or osascript:
osascript -e 'tell application "Notes" to repeat with n in every note of default account
  do shell script "echo " & quoted form of (body of n) & " > /Users/me/notes-mirror/" & quoted form of (id of n) & ".html"
end repeat'
```

Point Graphnosis at `/Users/me/notes-mirror/`. New notes ingest as you
write them (run the cron every 5 min).

### Bear

Bear has built-in *Export all notes* (File menu). For automation, the
[bear-cli](https://github.com/) tools work via x-callback URLs.

### Logseq

Logseq pages are already markdown files in a folder — point an Obsidian-
style folder watcher at `~/Logseq/pages/` and you're done.

### Notion local cache

Notion stores the local cache as SQLite — extract recent edits per
Pattern A above.

### Effective Graphnosis usage

- Mirror your fast-changing notes into a dedicated `Notes` engram with
  `personal` tier — recall surfaces them alongside everything else without
  you having to remember which app you wrote in.

---

## 8. Logs — router syslog, security cam DVR, audio recordings

### Syslog / router logs

```bash
# Anything writing to a log file → watch the directory.
tail -F /var/log/syslog | while read line; do
  echo "$line" >> /Users/me/graphnosis-feeds/syslog-$(date +%Y%m%d).log
done
```

Point a folder watcher at `/Users/me/graphnosis-feeds/`. Rotate daily;
old logs roll off naturally.

### Security cam DVR

If the DVR writes motion-event metadata to disk (most do — JSON or
sidecar files), watch that folder. Video files themselves stay where
they are; the cortex indexes the metadata.

### Audio recordings (meetings, podcasts, voice memos)

Transcribe locally first with [whisper.cpp](https://github.com/ggerganov/whisper.cpp):

```bash
# Drop new audio into ~/audio-in; transcribe to ~/audio-out.
fswatch ~/audio-in | while read f; do
  whisper.cpp/main -m models/ggml-base.en.bin -f "$f" -of "${f}.txt"
  mv "${f}.txt" ~/audio-out/
done
```

Point Graphnosis at `~/audio-out/`. Now `recall what Sarah said about the
budget on Thursday's call` works — the transcript is searchable like any
other note.

### Effective Graphnosis usage

- Transcribe locally for privacy. Cloud transcription works too, but
  defeats the offline pattern.
- Tag the engram `sensitive` if recordings contain health, financial, or
  legal content.

---

## 9. Industrial / agricultural — PLCs, OPC-UA, field sensors

Same shape as smart-home: a bridge script subscribing to the industrial
protocol and POSTing summaries to the Webhook connector. Common stacks:

- **OPC-UA** (factory floor): the `asyncua` Python library subscribes to
  variable changes and POSTs them.
- **Modbus** (older PLCs): poll registers on a schedule; POST when a value
  crosses a threshold.
- **LoRaWAN field sensors**: most network servers (ChirpStack, TTN) have
  webhook hooks built in — point them directly at Graphnosis.

### Effective Graphnosis usage

- Don't flood the cortex with every reading. Bridge **events of note**:
  threshold crossings, machine state changes, maintenance flags.
- Combine with `edit` to fix mis-named lines after the fact: *"edit
  the engram — the sensor labeled Reactor-B is actually Reactor-C."*

---

## Bonus: AI-rule files & local agent context

Graphnosis already has the **AI Context Files** connector for
`CLAUDE.md`, `AGENTS.md`, `CURSOR_RULES`, `GEMINI.md` and other rule
files in a project folder. Point it at each repo root. Now the rules you
wrote for your AI tools become part of the same memory the AI reads from
— closing the loop.

---

## Where everything lives

| Pattern | Configure in |
|---|---|
| Drag-and-drop file | The app window — any pane |
| Watched folder (Obsidian-style) | Settings → Data sources → add custom folder |
| Webhook target | Settings → Data sources → Webhook |
| Connector authentication / OAuth | Settings → Data sources → the specific connector |

The full Webhook reference (payload schema, security model, examples) is
at [Auto-ingest from your tools](/guides/connectors).

## What stays local, what doesn't

Everything in this guide runs on your machine. The patterns above:

- **Files / folders / NAS / scans / databases / notes apps / logs**: never
  touch the network.
- **Webhook bridge scripts**: POST to `localhost`. No external connection.
- **MQTT brokers, OPC-UA servers, LoRaWAN gateways**: typically on your LAN.
  If you've set them up to talk to a cloud service, that's a separate
  decision — Graphnosis just sees the local copy.

The only time data leaves your device is when you authorize an AI client
to read a recall — and that's gated by the [consent system](/guides/ai-access-controls).

---

## Related

[Auto-ingest from Your Tools](/guides/connectors/) — the cloud-side counterpart for SaaS connectors.

[Adding Content](/guides/adding-content/) — manual file / URL / clip ingest.

[Graphs & Sensitivity Tiers](/guides/graphs-and-tiers/) — route each source to the right engram.

[What Leaves Your Device](/guides/network-activity/) — proof that offline sources stay offline.

[MCP Tools](/reference/mcp-tools/) — what AI clients actually call once the cortex is populated.

