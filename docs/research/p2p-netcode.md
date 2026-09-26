## Serverless P2P netcode for Splash Bash: research findings (grounded, as of Sep 2026)

### 1. Trystero: current state (v0.25.x)

**API. v0.25.0 (May 2026) broke the old API.** Most tutorials show the old `[send, get] = makeAction()` and `room.onPeerJoin(fn)` forms, and those no longer work.
- `import {joinRoom, selfId} from 'trystero'`. Nostr is the default. Other strategies ship as separate packages: `@trystero-p2p/{mqtt,torrent,supabase,firebase,ipfs,ws-relay}`, split out in v0.23.
- `joinRoom({appId, password?, relayConfig?:{urls, redundancy}, rtcConfig?, turnConfig?, trickleIce?, passive?, handshakeTimeoutMs?}, roomId, {onPeerHandshake?})`
- Room events are now nullable callback properties:
  - `room.onPeerJoin = id => …`
  - `room.onPeerLeave = id => …`
  - Assigning `onPeerJoin` replays peers that are already connected.
- Actions are objects:
  - Messages: `const a = room.makeAction('st'); a.send(data, {target, metadata, onProgress, signal})` returns a Promise; receive with `a.onMessage = (data, {peerId, metadata}) => …`.
  - Request/response: `makeAction('sync', {kind:'request', onRequest})`, then `a.request(x, {target, timeoutMs})` or `requestMany(...)`.
- Other room methods: `room.ping(id)` (RTT in ms), `room.getPeers()` (a map from peerId to `RTCPeerConnection`), `room.leave()`.
- Admission layer (v0.23+): the async predicate `onPeerHandshake(peerId, send, receive, isInitiator)` can reject a peer before it becomes visible. Default timeout is 10 s. This is the hook for version checks and a full-room check.

**Wire facts (from `packages/core` source):**
- Each connection has one data channel, `pc.createDataChannel('data')` with default options, so it is **reliable and ordered**. There is no unreliable mode.
- Each message carries a 36-byte header: 32-byte action type field (so action names are limited to 32 bytes), 2-byte nonce, 1-byte tag, 1-byte progress.
- Payloads are chunked at about 16 KB. TypedArrays and Blobs are sent as binary; everything else goes as JSON.
- Backpressure waits up to 10 s. `bufferedAmountLowThreshold` is 0xffff.
- Default ICE is STUN only: `stun.l.google.com`, `stun1.l.google.com` and `stun2.l.google.com` on port 19302, plus `stun.cloudflare.com:3478`. `turnConfig` is appended to that list.
- A broadcast is one `send` per peer, which is natural for a mesh.
- `ping()` uses `Date.now()` over the reliable channel. It is too coarse for clock sync.

**Signaling timings:**
- Announcements go out at 233, 533 and 1333 ms, then every **5.333 s**.
- Nostr connects to **5 of 24** default relays (`redundancy` 5). Room topics map to ephemeral event kinds 20000–29999.
- A failed relay backs off from 60 s, doubling up to 15 min.
- Consequence: if the first burst is lost on flaky relays, the next chance to connect is about 5 s later. Design the UI for a 2–10 s join and a 15 s timeout.

**Known issues and pitfalls:**
- **#196 (open, Sep 2026):** joins are slower on 0.25.4 than on 0.25.2. This came from cutting relay spam (#192, #193). Pin an exact version and measure.
- **#141 (open):** no room size limit. The app has to enforce it.
- **Peer leave detection:** Trystero fires `onPeerLeave` on data channel close (fast when a tab closes) or after **5 s** in the `disconnected` state, on top of ICE detection time. Host failure detection therefore needs an app-level heartbeat.
- **Relay reliability:** a Nostr study of 712 relays (Q4 2023) found only 50% were up more than 99% of the time. About 20% were down more than 40% of the time, and 132 were dead. Among live relays, 90% were up more than 80% of the time.
- **`password`** encrypts the SDP so relay observers cannot read it. It is not player authentication.
- **Put the protocol version in `appId`**, e.g. `splashbash-p3`, so incompatible builds never meet.
- **No room listing.** For quick-match, probe numbered rooms (`qp-1`, `qp-2`, …) and move on when the host replies `full`. A single global lobby room would create a mesh of every player.

### 2. Full mesh with 8 peers: bandwidth and channels

**Topology:** 8 peers means 28 pairwise connections, 7 per peer. Splatoon 2 is a direct comparison: 8 consoles in a full mesh using Nintendo's "Pia" library.
- One console is session host. The game ticks at 60 Hz but sends state every 4 ticks, so **about 15 Hz**; Splatoon 3 stays around 16 Hz.
- Pia has three delivery classes: unreliable, reliable, and ordered-guaranteed "Event".
- Host migration picks "the highest ranking console".

**Use an unreliable channel for state.** Trystero's single ordered, reliable channel causes head-of-line blocking under packet loss. Add your own **negotiated** channel on the existing connection:
- In `onPeerJoin`, both peers run `room.getPeers()[id].createDataChannel('st', {negotiated:true, id:42, ordered:false, maxRetransmits:0})`.
- No renegotiation is needed because the SCTP association already exists. Negotiated channels do not fire `ondatachannel`, so Trystero will not see it.
- Avoid ids 0 and 1, which the auto-assigned Trystero channel may use.
- Before each send, check `bufferedAmount`. If it is above about 8 KB, skip the snapshot rather than queue it.
- Fallback if this fails: the Trystero action with a `Uint8Array`.
- The old Firefox bug where `maxRetransmits:0` produced a reliable channel was fixed in Firefox 62.

**Message size:** keep every message under 1200 bytes (path MTU) so it is never fragmented. 16 KiB is the cross-browser safe maximum; above 64 KiB is effectively unusable.

**Bandwidth budget (my own calculation):**
- Per-packet overhead is about 93 bytes: IPv4 20 + UDP 8 + DTLS header 13 + GCM 24 + SCTP common header 12 + DATA chunk 16. TURN ChannelData adds 4 bytes.
- A 26-byte binary player state becomes about 120 bytes on the wire. Sent through a Trystero action, the 36-byte header makes it about 156 bytes.
- **Player state at 20 Hz to 7 peers: about 135 kbps up and about 135 kbps down.** At 30 Hz it is about 200 kbps. Through Trystero actions at 20 Hz it is about 175 kbps.
- The host also sends a bot and world snapshot: about 180–200 bytes on the wire at 20 Hz. It peaks around 5 humans plus 3 bots, at about 115 kbps.
- **Worst-case host upload is about 250–300 kbps.** For comparison, Halo: Reach ran 16 players at 250 kbps against a 384 kbps target.
- SCTP SACKs add a little on the return path (my estimate: about 5 KB/s total).
- This fits any broadband or 4G link.

### 3. Authority model

**Movement is client-authoritative** (Destiny: "each player is authoritative over their own movement and abilities"). No rollback is needed.

**Hit detection is on the shooter's side, "favor the shooter":**
- Splatoon uses client-side hit detection, and trades are common as a result.
- Halo: Reach sends target-relative claims ("I shot at the head of player X") and the host checks them.
- Overwatch rewinds to the shooter's view but **turns off hit prediction above about 220 ms RTT**.
- Valve's Source engine keeps 1 s of position history. It computes command execution time as server time minus packet latency minus interpolation delay.
- Gambetta describes the trade-off: a player can get hit "a fraction of a second" after reaching cover. That is acceptable for a casual water game.

Recommended split:
- **The shooter** tests its own droplets against the interpolated remote players it is rendering. That view is already about D + RTT/2 in the past, so this favors the shooter automatically. It shows a hit marker immediately.
- **The host** owns soak, splash-outs, score, respawns, pickups, the timer and bots. It validates each hit claim and applies it. The victim sees the soak about one host hop later, roughly 50–150 ms.
- If the shooter's RTT to the host is above 250 ms, stop favoring the shooter: the host resolves that shooter's hits from its own view, following Overwatch.
- Why not victim-side authority: a victim client can ignore hits, which is god mode. Host validation is the cheapest single point of truth.

**Host stability and migration:**
- Do **not** elect purely by lowest id. A newcomer with a lower random id would take over the host role.
- Instead:
  - The host assigns each peer a `joinSeq`.
  - On failure, the oldest remaining peer by (`joinSeq`, then id) becomes host.
  - Every claim carries an `epoch`. The higher epoch wins, and on a tie the lower `joinSeq` wins; this resolves split-brain.
- Trigger migration on host silence over **2.5 s**, or on `onPeerLeave(host)`, whichever comes first.
- The new host rebuilds from the last replicated `match` state and bot snapshots. It re-plans bot AI and accepts re-sent hit claims that are less than 300 ms old.
- For scale: Call of Duty migrations took about 15 s. Destiny 1 migrated the physics host every 2 min 40 s on average "without you noticing", because all state was already replicated.

**Partial mesh:**
- STUN failures can leave a pair (B, C) unconnected while both still reach the host.
- Each peer lists its connected slots in a 1 Hz heartbeat. The host forwards state for missing edges (type 3 packet below).

### 4. Interpolation, dead reckoning, clock

**Interpolation buffer:**
- Valve renders 100 ms in the past at 20 updates/s, which survives one lost packet.
- Gaffer's rule is to survive 2 lost packets, so D = 3 × send interval: about 350 ms at 10 pps, about 150 ms at 30 pps, about 85 ms at 60 pps.
- **Recommendation: 20 Hz sends, D adaptive at max(100 ms, 2.5 × interval + p95 jitter), clamped to 100–200 ms. Start at 120 ms.**
- Use Hermite interpolation with the sent velocity; linear interpolation "pulses".

**Extrapolation:**
- Only when the buffer runs dry, and at most **250 ms** (Source `cl_extrapolate_amount` 0.25 s). Then freeze the player or show a lag ghost.
- Gaffer warns that even 200 ms extrapolation produces visible errors.
- Blend corrections over about 100 ms. Snap when the error exceeds 3 m.

**Rate reduction (dead reckoning):** when a player is idle, drop to a 4 Hz keepalive. Send immediately when the change exceeds a threshold.

**Clock sync** (Simpson's stream-based technique):
- The client sends `t0`; the host replies with `th`. On receipt at `t1`: `rtt = t1 − t0` and `offset = th + rtt/2 − t1`.
- Keep 16 samples. Discard any more than 1σ from the median, then average the rest.
- Poll every 1 s for 10 s, then every 5 s. Slew the clock by at most about 1 ms per frame.
- Use `performance.now()`, not `Date.now()`.
- On migration the new host keeps the timeline: it publishes its local time plus its existing offset to the old host. The match `endsAt` timestamp stays valid, so the timer never pauses.

### 5. Projectiles (water)

**Continuous streams:** send no per-droplet events.
- The unreliable state packet carries `firing`, `weapon` and aim.
- Every client spawns cosmetic droplets from the interpolated aim.
- **Only the shooter's own droplets deal damage.**
- Hit claims are batched per victim at 10 Hz or less: `{victim, amount, n, t, pos}`.

**Discrete shots** (balloon, charger):
- A reliable `shot` event carries `{sid, w, t, origin, dir, seed, charge}`.
- Receivers fast-forward the projectile by `now − t` so it appears where it would be by now.
- A seeded PRNG (e.g. mulberry32) gives every client the same spread pattern.
- Halo: Reach grenades: players "don't notice gaps up to 150 ms", and casual players not up to 200 ms. Play the throw animation locally and create the projectile at release.
- Halo: Reach stopped networking ragdolls after the initial death state and saved 10–12% of bandwidth. Apply the same idea to splash-out effects: send only the event, simulate locally.

### 6. NAT traversal

**Direct (STUN-only) connection success:**
- Callstats.io 2016: about 22% of conferences needed TURN.
- libp2p, 4.4 million hole-punch attempts: about 70% succeeded directly.
- Residential networks: about 90%.
- About 11% of peers sit behind symmetric NAT, where STUN alone fails.

**Implication for 8-player rooms (my estimate):**
- Assume 10% of players are on hard NAT and every pair of hard-NAT players fails.
- Then 1 − 0.9⁸ − 8·0.1·0.9⁷ ≈ **19% of full rooms have at least one broken pair.**
- The host-relay fallback covers most of these. TURN covers a player who cannot reach anyone.

**Hosted TURN options (2026):**

| Provider | Free tier | After free tier | Credentials | Catch |
|---|---|---|---|---|
| Cloudflare Realtime TURN | 1,000 GB/month (shared with SFU) | $0.05/GB | Minted with a server-side API token | Needs a tiny Worker endpoint (short TTL, e.g. 1 h), a small break from "no server" |
| Metered Open Relay | 20 GB/month, ports 80/443 including TLS (`turns:`) | ~$0.04/GB | Free signup plus API key | Key is used from the browser, so the quota can be drained |
| ExpressTURN | Advertised 1 TB/month, port 3478 only | $9/month for 5 TB | — | Tests suggest the free tier is less than advertised |
| Twilio | — | $0.40–0.80/GB | — | — |

- Offer `turns:` on port 443 for corporate firewalls. Browsers block port 53.
- **Usage estimate:** a fully relayed player uses about 300 kbps, roughly 135 MB per hour. Metered's 20 GB covers about 150 relayed player-hours per month; Cloudflare's 1 TB covers about 7,400.
- ICE only uses relay candidates when nothing else works, so TURN costs apply only to failing pairs.

**Recommendation:**
- v1: STUN plus host relay plus a clear "couldn't connect" message.
- Next step: Cloudflare TURN through a Worker.

### 7. Abuse mitigation without a server

Put these checks on the host. Every peer also runs the cheap ones.

- **Validate every input:** reject NaN or Infinity, enforce array lengths and message byte caps, and wrap parsing in try/catch. A malicious peer can otherwise crash other clients with junk.
- **Speed:** displacement over time must stay at or below `maxSpeed × 1.3` plus allowances for dash and knockback, measured over a 500 ms window. Otherwise snap the player back and mark a strike.
- **Hit claims:**
  - Shooter and victim both alive; victim not in spawn protection.
  - Range at or below 1.25 × weapon range.
  - Claim time `t` between `hostNow − (RTT/2 + D + 150 ms)` and `hostNow + 50 ms`.
  - Soak per second at or below 1.25 × weapon DPS over a 1 s sliding window.
  - Shooter's tank not empty, tracked from the firing flags.
- **Lag switch** (worked in Destiny 1): after more than 500 ms of silence followed by a burst, treat buffered hits and positions with suspicion and drop claims older than the window.
- **Kicks:** 3 strikes in 10 s means kick. The host broadcasts `kick`, and every peer closes its connection with `getPeers()[id].close()` and ignores that id.
- **Admission and room size:** `onPeerHandshake` checks the protocol version. The host's `welcome`/`full` reply enforces 8 humans. Peers ignore state from anyone the host has not welcomed.
- **A cheating host cannot be stopped** without voting. Accept that for a casual game; peers can cross-check score changes against events they saw themselves.

### 8. Recommended protocol (up to 8 players plus bots)

**Slots:** the host assigns each player a u8 slot (0–7) and puts slots in the roster. Use slots on the wire instead of the roughly 20-character Trystero ids.

**Unreliable binary channel `st` (negotiated, id 42, unordered, 0 retransmits), little-endian:**
- **Type 1, player state** (every peer to all, 20 Hz; 4 Hz when idle), 26 bytes:
  - `u8 type, u16 seq, u32 t` (match clock, ms)
  - `i16×3 pos` (cm), `i16×3 vel` (cm/s)
  - `u16 yaw, i16 pitch`
  - `u8 flags` (grounded, firing, crouch, refilling, sprint), `u8 weapon, u8 tank`
- **Type 2, world state** (host to all, 20 Hz):
  - `u8 type, u16 seq, u32 t, u8 soak[8], u8 aliveMask, u8 nBots`
  - Then per bot: `u8 slot` plus the 23-byte body above.
- **Type 3, relayed player state** (host only, for missing mesh edges): `u8 type, u8 originSlot` plus the type 1 body.

**Reliable Trystero actions (JSON is fine at these rates; names at most 32 bytes):**
- **Joining:**
  - `hello` (joiner to host): `{v, name, skin}`
  - `welcome` (host to joiner): `{epoch, slot, joinSeq, roster, match}`, or instead `full` / `badver`
- **Host broadcasts:**
  - `roster` (on change): `[{id, slot, name, skin, team, joinSeq, bot}]`
  - `match` (1 Hz and on change): `{epoch, phase, endsAt, scores, respawnAt[], pickups{id:readyAt}, botBrains[], mapSeed}`
- **Combat:**
  - `shot` (shooter to all): `{sid, w, t, o, d, seed, charge}`
  - `hit` (shooter to host, batched at 10 Hz or less): `[{v, amt, n, t, p}]`
  - `splash` (host to all): `{v, by, assist[], t, respawnAt}`
  - `spawn` (host to all): `{slot, pos, yaw, t, protectUntil}`
  - `pickup` (host to all): `{id, by, t}`
- **Control:**
  - `hb` (every peer, 1 Hz): `{epoch, peers[] (connected slots), rttHost}`
  - `host` (new host to all): `{epoch, joinSeq}`
  - `kick` (host to all): `{id, reason}`
  - `sync` request action (client to host): `{t0}` → `{t0, th}`
- **Social:** `chat` / `emote`

**Timings:**
- Interpolation delay 120 ms (adaptive 100–200); extrapolation cap 250 ms.
- Host timeout 2.5 s. Hit-claim window 300 ms. Stop favoring the shooter above 250 ms RTT.
- Join timeout 15 s with retry.
- Trystero version pinned exactly.

### Sources
- [Trystero README](https://github.com/dmotz/trystero/blob/main/README.md), [releases](https://github.com/dmotz/trystero/releases), [issue #196](https://github.com/dmotz/trystero/issues/196), [issue #141](https://github.com/dmotz/trystero/issues/141)
- Trystero source: [peer.ts](https://raw.githubusercontent.com/dmotz/trystero/main/packages/core/src/peer.ts), [action-wire.ts](https://raw.githubusercontent.com/dmotz/trystero/main/packages/core/src/action-wire.ts), [strategy.ts](https://raw.githubusercontent.com/dmotz/trystero/main/packages/core/src/strategy.ts), [nostr index.ts](https://raw.githubusercontent.com/dmotz/trystero/main/packages/nostr/src/index.ts), [room.ts](https://raw.githubusercontent.com/dmotz/trystero/main/packages/core/src/room.ts)
- [Nostr relay availability study (arXiv 2402.05709)](https://arxiv.org/html/2402.05709v2)
- [RTCDataChannel message size limits (webrtc.link)](https://webrtc.link/en/articles/rtcdatachannel-usage-and-message-size-limits/), [RFC 8831](https://www.rfc-editor.org/info/rfc8831/), [Mozilla bug 1464917](https://bugzilla.mozilla.org/show_bug.cgi?id=1464917)
- [Splatoon 2 netcode (OatmealDome)](https://oatmealdome.me/blog/splatoon-2s-netcode-an-in-depth-look/), [Splatoon 3 tick rate (Nintendo Life)](https://www.nintendolife.com/news/2022/08/splatoon-3-demo-server-tick-rate-is-apparently-30percent-slower-than-originals), [Squidboards on client-side hit detection](https://squidboards.com/threads/client-side-hit-detection.1551/)
- [Halo: Reach netcode (Edgegap)](https://edgegap.com/blog/game-backend-deep-dive-halo-reach-netcode-host-migration), [Overwatch netcode (Edgegap)](https://edgegap.com/blog/game-backend-deep-dive-overwatch-2016-netcode-architecture-rollback), [Destiny networking (Bungie, gist)](https://gist.github.com/nessus42/df399f31e4ab41192cbd51b32e9d7b73), [CoD host migration](https://callofduty.fandom.com/wiki/Host_Migration)
- [Valve Source Multiplayer Networking (mirror)](https://gist.github.com/CoolOppo/fe0586836de3fb2f90f9), [Gaffer on Games: Snapshot Interpolation](https://gafferongames.com/post/snapshot_interpolation/), [Gambetta: Lag Compensation](https://www.gabrielgambetta.com/lag-compensation.html), [Simpson time sync (summary)](https://www.researchgate.net/publication/220969352_Challenges_for_Network_Computer_Games)
- [NAT traversal statistics (lazyharu)](https://lazyharu.com/en/webrtc-nat-traversal/), [Cloudflare TURN credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/), [Cloudflare Realtime pricing](https://developers.cloudflare.com/realtime/sfu/pricing), [Metered Open Relay](https://www.metered.ca/tools/openrelay/), [ExpressTURN](https://www.expressturn.com/), [Hosted TURN comparison 2026 (BlogGeek)](https://bloggeek.me/webrtc-tools/nat-hosted/)