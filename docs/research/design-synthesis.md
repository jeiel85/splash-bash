# Splash Bash (물총 대소동): Design Reference v0.1

Conventions: 1 unit = 1 m. The simulation runs at a fixed 60 Hz and rendering interpolates between steps. Soak runs 0–100 and so does the water tank. `[X]` names the game or source a rule is borrowed from. "Resolved:" marks a place where the research reports disagreed and a choice was made.

---

## 1. Core loop and session flow

**Loop, about 30–45 s per cycle.** Spot an enemy → soak them (primary splashes in 0.6 s) → tank runs low → refill at the pool or a fountain (exposed), or back off to dry → re-engage. If you get splashed out you respawn after 3 s. A match lasts 4 minutes, then an 8 s podium, then the next match starts in the same room. [Splatoon shoot/refill rhythm; Krunker and Smash Karts short rounds]

**From landing page to playing (1 click, 2 at most):**
1. **Landing page.** The real arena GLB plays as a slow fly-over behind a card that holds:
   - an auto-generated name (adjective + animal, "Soggy Otter / 촉촉한 수달"), editable and kept in localStorage;
   - 3 weapon cards (default Soaker);
   - a big **Splash!** button;
   - secondary buttons "Private room" and "Join code".
   
   There are no accounts. [Krunker guest play, Shell Shockers menu]
2. **Click 1: Splash!** In the same click handler, call `requestPointerLock({unadjustedMovement:true})` (fall back to a plain request) and `AudioContext.resume()`, then start quick-play. If pointer lock is lost, a "Click to play" overlay is click 2.
3. **Quick-play.** Join the Trystero room `qp-1`.
   - On `welcome`: spawn.
   - On `full`: leave and try `qp-(n+1)`, up to `qp-20`.
   - If no peer completes a handshake within **6 s**: self-host with bots (epoch 1). The room stays open to others.
   - Targets: in play within 6 s at p50 and 10 s at p95. (Trystero announces at 0.23 / 0.53 / 1.33 s, then every 5.33 s.)
4. **While connecting:** show a controls card over the fly-over: WASD, Space, Shift slide, LMB fire, RMB balloon, Tab.
5. **The room link is the invite.** The URL hash is the room code, e.g. `/#K7QMX`. Codes are 5 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (31 symbols, 28.6M codes). A "Copy invite link" button appears in the Esc menu, on the Tab scoreboard and on the podium, for public and private rooms alike. Opening a link shows the same Splash! card with the code already filled in. [Smash Karts, Shell Shockers]
6. **Esc** releases the pointer and opens the menu (resume, copy link, settings, leave). The game keeps running; there is no pause.
7. **Connection failure.** If peers are seen but none connects within 15 s, show "Couldn't reach splashers — playing with bots" with a Retry button, and self-host.
8. **Controls:** WASD move, Space jump, **Shift slide** (not Ctrl, because Ctrl+W closes the tab), LMB hold to fire or charge, RMB throw balloon, Tab scoreboard, 1/2/3 choose the weapon for the next spawn.

## 2. Modes and match rules

| Rule | Value | Source / resolution |
|---|---|---|
| Modes | **Splash Party** (FFA), **Team Splash** (Tangerine vs Grape) | Krunker FFA / TDM |
| Public rotation | FFA → Team → FFA… (no vote; there is only one map) | Krunker vote cut for v0.1 |
| Length | 4:00 | Krunker 4 min (Smash Karts 3) |
| Win condition | FFA: first to 15 splashes. Team: first team to 30. Otherwise the timer ends it | — |
| Ranking | Splashes, then fewer times soaked, then assists | — |
| Capacity | 8 humans, enforced by the host's `full` reply | Trystero has no room cap (#141) |
| Bot backfill | Fill to **6 participants** while humans ≤5. Each joining human replaces the lowest-scoring bot. With 6+ humans there are no bots | Smash Karts (≤3-human backfill, raised to 6 for this map size) |
| Respawn | **3.0 s** automatic: 0.5 s pop + 2.5 s "Soaked by {name}" card | Resolved: Shell Shockers 5 s and Splatoon 8.5 s are too long; 2 s is too short to read the card |
| Spawn protection | 2.0 s bubble; ends early when you fire or throw. The host ignores hits on a protected player | Shell Shockers (~4 s), shortened |
| Assist | Dealt ≥25 soak to the victim within the last 5 s | Krunker assist |
| Team rules | No friendly fire. Auto-balance on join (smaller human team, then bots). No switching mid-match | — |
| End of match | 8 s podium (top 3 do a victory wiggle on the pool deck), 3 s countdown, scores reset, everyone respawns, room persists | Smash Karts instant next round |
| Late join / leave | Join any time and spawn at once; no penalty for leaving | Krunker, minus its leave penalty |
| Private-room host options | Mode, length (3/4/6 min), bots on/off, kick. Nothing else | Shell Shockers private games, trimmed |
| Medals | Popup and sound only, no score effect: First Splash, Double (2 within 3 s), Triple, Revenge, Mid-air (victim airborne), Slide Splash, Balloon Bonk (splash-out by a direct balloon hit), Long Shot (Drencher ≥25 m), Close Call (own soak ≥85), streak callouts at 3/5/8 | Krunker medals |

Resolved: Shell Shockers-style streak power-ups and a Krunker-style nuke are cut from v0.1.

## 3. Movement

**Body:** bean 1.5 m tall, capsule radius 0.4 m, eye height 1.35 m.

| Parameter | Value | Source |
|---|---|---|
| Run speed | **6.0 m/s**. No sprint, no crouch; diagonal input is normalised | Overwatch 5.5, Splatoon 5.8, Valorant 6.75; Krunker has no sprint |
| Backpedal | ×0.9 (5.4 m/s) | Overwatch |
| Ground acceleration / friction | 50 m/s² (0→6 m/s in 0.12 s) / 40 m/s² (stop in 0.15 s) | — |
| Air control | 15 m/s² (30% of ground). Input cannot push air speed past 6 m/s, but existing momentum is kept | Report 1 recommendation |
| Gravity | **20 m/s²**. Terminal fall speed 30 m/s. No fall soak | Krunker low gravity |
| Jump | Apex **1.2 m**: v = 6.93 m/s, 0.69 s airtime. Coyote time 100 ms, jump buffer 100 ms | — |
| Step height / max slope | 0.35 m / 45° | — |
| Slide (Shift) | Needs grounded and speed ≥4.5 m/s. Speed becomes clamp(max(v×1.25, 7.5), 9.0) m/s. Lasts 0.8 s with 3 m/s² decay; steering 60°/s. Eye drops 1.35 → 0.85 m over 0.1 s; hurt capsule shrinks to 0.9 m. Cooldown 0.6 s | Krunker slide (~1 s) |
| Slide-hop | Jumping during a slide keeps horizontal speed, capped at 9.0 m/s | Krunker slidehopping |
| Moving while firing | Soaker ×0.8. Sloshbucket ×0.85 for 0.3 s after each slosh. Drencher ×0.5 while charging | Splatoon run-speed-while-shooting (75% / 42% / 21%, softened for FPS) |
| Pool wading | ×0.7 speed, no slide, jump apex ×0.8 (still enough to climb out of 0.6 m of water) | — |
| Jump pads | Launch velocity is solved so the apex is landing height + 1.0 m. Air control is 10% until landing | — |
| Mouse | 0.022° per count × sensitivity. Default sensitivity 2.0, range 0.1–10. Raw input where supported | Source-engine convention |
| FOV | Horizontal 95° by default, range 80–110. Convert for Three.js with vfov = 2·atan(tan(h/2)/aspect); 95° at 16:9 gives 63.1° | XAG 117 range 85–110 |
| Head bob | Off by default | XAG 117 |

Level metrics that follow from these numbers: low cover (0.9–1.0 m) can be jumped onto, high cover (≥1.6 m) cannot, and 0.9 m crate steps can be climbed one jump at a time.

## 4. Soak model (health)

- **Meter:** soak 0–100 per participant, owned by the host. Soak ≥100 means **SPLASHED OUT**. Spawning resets soak to 0. [Water Warfare: wet shirt = health]
- **Drying:** starts **1.5 s** after the last soak received, at **15/s** (full to dry in 6.7 s). [Splatoon: 1 s delay, 12.5/s]
  - Resolved: the Splatoon report asked for 1.2 s and the art report for 1.5 s. 1.5 s was chosen because P2P adds about 0.1 s of victim-side lag and a slightly longer delay still lets a third player finish a soaked target.
- **No hit multipliers:** no headshots and no crits (a bean has no separate head). Shots-to-splash never changes. [Splatoon damage cap of 99.9, same reasoning]
- **No soak-level debuffs:** being soaked does not slow you, which avoids a losing spiral. Soak levels are purely visual.
- **No environmental soak** in v0.1: no enemy-ink floor, no sprinkler damage. (Splatoon's enemy-ink mechanic is cut.)
- **Towel pickup:** −50 soak instantly. [Water Warfare towel]
- **Visual steps at soak 25 / 50 / 75:** drips, then soggy, then dripping heavily.
  - The victim's screen-edge droplets start at 25.
  - Other players see an overhead soak bar for 2.5 s after each hit. [Splatoon 3 v11 health bar]

## 5. Water tank and refill

- **Tank:** 100, simulated by the client and sent as a u8 in the state packet. The host sanity-checks it against the firing flags. Everyone spawns with a full tank.
- **Passive refill:** **+8/s** once the weapon's pause has elapsed (empty → full in 12.5 s). Pause after firing: Soaker 0.5 s, Sloshbucket 0.7 s, Drencher 0.8 s, Balloon 1.0 s. [Splatoon standing 10 s to full; InkRecoverStop 15–60 f]
- **Garden fountain zone** (radius 1.5 m): **+30/s** (3.3 s to full), no slowdown.
- **Pool** (central, wading): **+60/s** (1.7 s to full), but you move at ×0.7 speed in the most exposed spot on the map. This is the risk/reward refill. [Splatoon submerged 3 s refill; art report]
- **Running low:**
  - You cannot fire when the tank holds less than the shot costs; the trigger gives a dry click.
  - The gun's tank blinks red.
  - At ≤20 the HUD shows **"Running dry!"** with a warning beep.
  - A chime plays when the tank rises past 40 (enough for a balloon).
  
  [Splatoon Low Ink warning and sub-weapon LED]
- **Diegetic readout:** a transparent tank on the first-person gun and a backpack tank on every character show the water level, so enemies can read it and punish an empty player. [Splatoon]
- Resolved: the "pressure falls as the tank drains, so range shrinks" idea is cut.

## 6. Weapon roster (3 guns + 1 throwable)

**Shared stream ballistics** [Splatoon straight-then-fall, damage falloff by flight]:
- A droplet flies straight at v0 for `tStraight`. After that, each step applies `v *= exp(-4·dt)` and `v.y -= 25·dt`.
- **Full soak applies while the stream is straight.** Falloff starts where the stream visibly droops, so the arc teaches range.
- Collision radii: droplet vs player uses a 0.15 m sphere against the 0.4 m capsule (0.55 m effective); droplet vs world uses 0.05 m. [Splatoon: player hit radius larger than wall radius]
- Spread is a uniform random point inside a cone, seeded with `mulberry32(slot<<16 | shotSeq)`.

The loadout is one gun per life plus the balloon. A new gun choice (1/2/3) applies at the next spawn. There is no reload, no aim-down-sights and no mid-life weapon switching. [Shell Shockers weapon pick before spawn]

| | **Soaker** (auto) | **Sloshbucket** (close burst) | **Drencher** (charger) | **Water Balloon** (throwable) |
|---|---|---|---|---|
| Borrowed from | Splattershot + Krunker AR | Splatoon Slosher + Krunker shotgun | Splat Charger + Krunker sniper | Burst Bomb + Water Warfare balloon |
| Fire rate | 10/s (100 ms) | 1 slosh per 0.7 s | Hold to charge; full charge at 1.0 s; 0.3 s recovery after release | 1.2 s cooldown; one in flight at a time |
| Projectile | 1 droplet per shot | 10 droplets in a fixed pattern: 1 centre, 3 at 3°, 6 at 7°, rotated by the seed | 1 slug | 1 balloon, radius 0.2 m |
| Speed | 40 m/s | 22 m/s | 150 m/s | 14 m/s along aim + 2.5 m/s up + 50% of player velocity |
| Gravity / flight | Straight 0.25 s (10 m), then drag/gravity; life 0.6 s | Straight 0.10 s (2.2 m), then drag/gravity; life 0.45 s | Straight line, no gravity, out to R(c) = 12 + 23c m | Gravity 20 m/s² from release, no drag; bursts on first contact (life cap 3 s) |
| Spread (half-angle) | 1.5° standing, 3° moving, 6° airborne | Pattern ×1.0, ×1.3 airborne | 0° | 0° |
| Water cost | 1.5 per shot (67 shots, 6.7 s of continuous fire) | 8 per slosh (12 per tank) | 5 + 15c (5 for a tap, 20 at full) | 40 |
| Soak per hit | 16 up to 10 m, falling linearly to 8 at 17 m | 10 per droplet up to 3 m, falling to 4 at 6.5 m | 30 + 40c for c < 1; **100 at full charge** | Direct hit 60. Splash: 45 within 1 m, falling to 15 at 3 m. Knockback 3.5 m/s outward + 2.5 m/s up (the thrower is pushed too but takes no soak) |
| Effective / max range | 12 m / about 17 m | 5 m / 6.5 m | 12 m (tap) to 35 m (full) | About 7 m thrown level, about 12 m at 45° |
| Shots to splash | 7 | 1 (all 10 droplets at ≤3 m), 2 typically | 1 at full charge; 4 taps | 2 direct hits (normally a combo: 1 direct + 3 Soaker shots) |
| **Time to splash** | **0.60 s** | **0 s / 0.70 s** | **1.0 s** including charge; about 1.05 s with taps | — |
| Max soak in a 1 s window (anti-cheat input) | 176 | 200 | 132 | 60 |

- **Drencher aim line.** While charging with c ≥ 0.2, a thin line in the shooter's team tint is visible to everyone. The charge level travels in the state packet. [Splat Charger laser]
- Resolved: the six weapons in report 1 are cut to 3 + 1, as the brief requires. Time to splash is 0.6 s: Splatoon's 0.15–0.27 s is too harsh for a casual first-person P2P game, and 0.6 s sits in Krunker's 0.4–0.6 s band.

## 7. Pickups and map interactables

| Item | Count / location | Behaviour | Source |
|---|---|---|---|
| Pool refill | 1, centre | +60/s, ×0.7 wading speed | Splatoon swim-refill as risk |
| Garden fountain | 2, one per lane | +30/s within 1.5 m. The 1.1 m basin doubles as low cover | Water Warfare drinking fountain |
| Towel rack | 2, lane centres | −50 soak. Host-authoritative `pickup`. Respawns after 20 s, with a shimmer in the last 3 s | Water Warfare towel; Halo pickup timers |
| Jump pad (inflatable trampoline) | 2, pool deck → tower tops | Launch solved for apex = landing height + 1 m. 0.5 s re-use lockout. "Boing" with a squash animation | Krunker/Quake pads |
| Inflatables | Flamingo (2.0 m, blocks droplets and players) and donut (0.5 m, cosmetic) in the pool | Drift on a path driven by the shared match clock: x = 3·sin(2πt/23), z = 1.5·sin(2πt/17), donut phase +π. Costs zero network traffic | Art report |
| Laundry lines | 2, one per lane | Towels 1.8 m tall. They block sight but let droplets and players pass | Art report |

Cut from v0.1: sprinkler hazards, power-weapon pickups, streak rewards.

## 8. Art bible

**Shape language** [Fall Guys bean; Lorenz baby schema; Fortnite taper rule]
- **Characters:** a gumdrop/bean with head and torso fused. The head is about 45% of height (2–2.2 heads tall). Large eyes in the lower half of the face, mitten hands (no finger rig), nub feet, 1.5 m tall.
- **Silhouettes:** characters are told apart by hat silhouette. The three guns must read as different black silhouettes at 64 px: Soaker is a long pump rifle, Sloshbucket a bucket with a nozzle, Drencher a long tube with a pressure bulb. Every gun carries a transparent tank.
- **Modelling rules:** every asset gets a Bevel modifier (3–4 segments, 30° angle limit, width 6–10% of the smallest dimension) followed by Weighted Normal. No sharp edges visible to the camera. Props taper 3–5° and bulge slightly; hero props have no parallel lines.
- **Triangle budgets:** character 3–6k, hat ≤800, prop 200–2k, whole arena 150–300k.
- **Materials:** albedo and baked AO live in vertex colours. The only textures are a 512 px 4×4 face atlas and a pattern atlas, which is v0.2.

**Palette** (hex)

| Group | Colours |
|---|---|
| Sky | `#7EC8FF` top → `#CDEBFF` horizon |
| Pool | deep `#2BB5D8`, shallow `#6FD6E8`, foam `#F4FFFF`, tile `#DDF4F7` |
| Grass | `#A6D98C`, shade `#7FB27A` |
| Deck | `#F2D6B0`, shade `#D9B48A` |
| Stucco | `#FFF4E0` |
| Inflatables | mint `#BDF2D5`, lemon `#FFF1A8`, pink `#FFC8D8` |
| UI ink (outlines and text) | `#2B1D4A` |
| Team Tangerine | `#C85A00` / **`#FF8A1F`** / `#FFC285` |
| Team Grape | `#4A2FC0` / **`#7B5CFF`** / `#BBA8FF` |
| FFA by slot | `#FF8A1F #7B5CFF #FF4F8B #19C3A6 #FFD23F #3D8BFF #A0E426 #FFFFFF` |

**Colour rules**
- Blue is never a team colour; the pool and sky already use it. [Splatoon 3 Splatfest visibility problem]
- The team pair keeps ΔE ≥82 under all simulated colour-vision deficiencies. The FFA set cannot be made colour-blind safe, so hats and nameplates carry identity there.
- Hue is never the only cue: every character also gets an outline in its dark shade, a rim light in its team tint, and an icon on its nameplate.
- Characters are the most saturated things on screen. The environment is at least 30% less saturated. Shadow tints stay warm or teal, never blue-violet.
- Floors are darker than walls, walls are plain, and detail goes to the edges of the play space. [Overwatch via Level Design Book]
- Provide an enemy/ally colour override setting. [Overwatch]
- Water streams are 35% team colour mixed into `#BFF3FF`.

**Toon rendering plan (Three.js)**

| Layer | Implementation | Tier |
|---|---|---|
| Ramp | `MeshToonMaterial` with a 3-texel `gradientMap` (Uint8 values [158, 217, 255] = 0.62 / 0.85 / 1.0). Nearest filtering, no mipmaps, `NoColorSpace` | All |
| Rim | Inject via `onBeforeCompile`: `smoothstep(0.59, 0.61, (1-dot(N,V))*pow(max(dot(N,L),0),0.2))`, strength 0.6, team-tinted. Characters and pickups only | All |
| Outline | Custom inverted hull: back faces pushed along normals by `thickness·(-mvPos.z)`. Thickness 0.0026 for characters (about 2.5 px at 1080p) and 0.0015 for guns; colour is the team's dark shade. Smoothed normals baked in Blender. Characters, guns and pickups only; no scene-wide `OutlineEffect` | Low tier: characters only |
| Lights | One `DirectionalLight` sun (`#FFF4E0`) plus a hemisphere light (sky `#CDEBFF`, ground `#A6D98C`). At most 3 lights | All |
| Shadows | Sun shadow over a tight 52 × 40 m orthographic frustum, `PCFShadowMap`, 2048 px (1024 on low), normalBias 0.02. Only characters, towers, cabanas and hedges cast. A blob shadow decal always sits under each character | All |
| Tone mapping | `NeutralToneMapping`, sRGB output, so palette hex values survive | All |
| Bloom | pmndrs `postprocessing` `BloomEffect` (mipmapBlur, threshold 1.0, intensity 0.6). Only emissives above 1 bloom: water sparkles, pickups, the splash-out burst | High tier only |
| Budgets | ≤250 draw calls; pixel ratio min(dpr, 2), or 1.5 on low. `InstancedMesh` for droplets (cap 1024, one draw call), confetti (512) and decals (96). Static environment merged per material or `BatchedMesh`. GLBs compressed with meshopt. Auto tier: if p90 frame time over the first 5 s exceeds 20 ms, drop a tier. Target 60 fps on an Iris Xe-class GPU at 1080p | — |

**Water and VFX**
- **Pool surface:** toon-banded shader with 2 vertex sine waves, plus authored foam ring meshes around the edge and the inflatables. No depth-texture foam.
- **Streams:** instanced capsule droplets plus one ribbon trail per active stream.
- **Impacts:** 6–10 droplets and a ring flash.
- **Wet decals:** pool of 96, each fading over 4 s.
- **Splash-out puddle:** lasts 5 s.

**UI style**
- **Fonts** (Google Fonts, `display=swap`):
  - Bagel Fat One for the logo and banners.
  - **Jua** for the HUD and body text.
  - Do Hyeon for the kill feed and compact labels.
  - **Fredoka** for Latin text.
  - Call `document.fonts.load()` before drawing nameplates to a CanvasTexture.
- **Buttons:** pill shape with radius ≥40% of height, a 3–4 px `#2B1D4A` border and a 4–6 px darker lip. Press moves the button down 3 px over 80 ms. Hover scales to 1.05 with easeOutBack.
- **HUD text:** white fill with a 3 px `#2B1D4A` stroke. Never white text on Tangerine (2.36:1 contrast fails); use dark ink on bright fills (9.4:1).
- **HUD layout:**
  - Centre: crosshair (dot plus 4 ticks whose gap tracks spread), Drencher charge ring, balloon-ready pip.
  - Bottom-left: round soak dial that fills with wavy `#6FD6E8` water. [Shell Shockers dial]
  - Bottom-right: tank bar and balloon icon, next to the diegetic gun tank.
  - Top-centre: timer and scores.
  - Top-right: splash feed, 5 lines, each shown for 5 s.
  - Top-left: room code and ping.
  - Tab: scoreboard.
- **Language:** Korean when `navigator.language` starts with `ko`, otherwise English.

**Copy: no violent words**

| Moment | English | Korean |
|---|---|---|
| Splash-out | SPLASHED OUT! | 흠뻑 젖었다! |
| Killed by | Soaked by {name} | {name}에게 흠뻑! |
| Respawn countdown | Drying off… 3 | 몸 말리는 중… 3 |
| Low water | Running dry! | 물 부족! |
| Refill done | Refill! | 충전 완료! |

## 9. Juice and feedback checklist

**Shooter**
- [ ] Nozzle splash sprite for 3 frames, plus the gun squashing along Z 0.92 → 1.0 over 80 ms on every shot.
- [ ] Recoil pitch: Soaker 0.3°, Sloshbucket 1.5°, full Drencher 2.5°; recovers in 120 ms; no random yaw.
- [ ] Hitmarker on local detection: scales 1.0 → 1.3 with easeOutBack over 90 ms.
- [ ] "Bloop" hit sound with ±1.5 semitone jitter, +1 semitone per consecutive hit within 0.5 s (capped at +7), 16 ms debounce. [Overwatch hit-pip; pitch-ladder technique]
- [ ] Soak numbers: an option, off by default.
- [ ] Host-confirmed splash-out: team-coloured "X" pop (150 ms), party horn, crowd "ooh", medal popup.
- [ ] Killer's screen: freeze **only the victim's model** for 70 ms (never the camera or input) and punch FOV −2°, recovering over 150 ms. [Vlambeer hitstop, adapted for multiplayer]

**Target (as others see them)**
- [ ] Volume-preserving squash on hit: Y = 0.85, XZ = 1/√0.85, for 60 ms, then a 9 Hz spring with damping ratio 0.45.
- [ ] Wetness shader: albedo × (1 − 0.2·soak), wider specular band, drip particles stepping up at 25/50/75.
- [ ] Faces from the 4×4 atlas: wince when hit, smug after a splash, dizzy `@_@` when splashed out.
- [ ] Overhead soak bar for 2.5 s after each hit.

**Victim**
- [ ] Screen-edge droplets from 25 soak, scaled with soak. Triggered locally when cosmetic droplets touch your own capsule; the meter itself comes from the host.
- [ ] Radial arc showing damage direction, fading over 1 s.
- [ ] At soak ≥75, low-pass "underwater" muffling on game audio.
- [ ] Streams cause no camera shake. A balloon burst within 5 m uses trauma² shake: ≤0.25 s, capped at 1.5° pitch/yaw and 0.75° roll. [Eiserloh GDC 2016]
- [ ] Splash-out: swell 1.0 → 1.25 over 120 ms, then pop into 32 droplets and 60 confetti quads in the killer's colour (1.0 s life, 3 m/s² gravity, flutter). 0.5 s third-person pull-back facing the killer, then the "Soaked by" card with the weapon icon.

**World**
- [ ] Jump-pad boing with squash; refill gurgle while the gun tank visibly rises; "Refill!" at 100; balloon-ready chime at 40.
- [ ] Footsteps squelch louder at soak ≥50; slide into the pool throws a big splash.
- [ ] Audio: WebAudio with at most 8 voices per sound and `equalpower` panning (no HRTF).

**Accessibility** [XAG 117]
- [ ] Shake slider 0–100%, head bob off, reduce-motion toggle (kills button breathing and the FOV punch), FOV 80–110, enemy colour override.

## 10. Map: Backyard Pool Party

- **Size:** playable area **48 × 36 m** (x ∈ [−24, 24], z ∈ [−18, 18]). Three east–west lanes at z = +13, 0 and −13.
- **Symmetry:** 180° rotational around the centre, so team play is fair. Tangerine's base is the west patio, Grape's the east patio.
- **Boundary:** 2.0 m picket fence plus an invisible wall up to 8 m. Neighbours' houses beyond the fence are backdrop only.
- **Height tiers:** pool floor −0.6 / ground 0 / patio +1.0 (can be jumped onto) / tower decks +3.6.

**Schematic** (1 character = 2 m in x, 1 row = 3 m in z; north at the top):

```
z+18 .......s....R......s....
     ....TT...LLL...F........
     ....TT..................
     ===....HHHH..HHHH....===
     =s=...C.J..KK........=s=
     =s=...C.~~~~~~~~.....=s=
     =s=.....~~~~~~~~.C...=s=
     =s=........KK..J.C...=s=
     ===....HHHH..HHHH....===
     ..................TT....
     ........F...LLL...TT....
z-18 ....s......R....s.......
```

Legend: `=` patio +1.0, `~` pool, `H` hedge 1.7 m, `C` cabana, `K` tiki bar, `T` tower +3.6, `J` jump pad, `F` fountain, `R` towel rack, `L` laundry line, `s` spawn.

| Element | Spec |
|---|---|
| **Pool** | Kidney shape, 14 × 7 m, centred at (0, 0). Water surface y −0.05, floor −0.65. Stepped entries (0.3 m risers) at the east and west ends; you can also jump out anywhere. 2 m wood deck all round. Refill +60/s. Flamingo and donut inflatables drift inside |
| **Patios (bases)** | x ∈ [−24, −18] and [18, 24], z ∈ [−8, 8], deck at +1.0 m. Stairs at the north and south ends. Each has a BBQ (1.0 m, low cover), a table with umbrella (overhead cover) and a 1.8 m lattice screen along the inner edge covering z ∈ [3, 8] (west) and [−8, −3] (east) |
| **Cabanas** | 3 × 4 m, 2.4 m high, at (−11, +2) and (+11, −2). Solid on 3 sides, open toward the pool. They break the patio-to-patio sightline through the middle |
| **Tiki bars** | 4 × 2 m, 2.2 m high, at (0, +5.5) and (0, −5.5) on the pool deck |
| **Hedges** | 4 segments, 6 × 0.8 m, 1.7 m high, at z = ±9 over x ∈ [−9, −3] and [3, 9]. Gaps at the centre and at the ends make loops, with no dead ends [Dust2 loop principle] |
| **Towers** | Treehouse NW, deck centred at (−14, +12), 4 × 4 m. Play-set SE, deck at (+14, −12), 4 × 4 m, with a slide. Both decks at +3.6 m with only a 0.5 m rail (not cover), so they are exposed from the pool deck and the far lane. **Three ways up each:** crate steps (4 × 0.9 m), a jump pad, and a 38° ramp (the treehouse plank ramp or the play-set slide, which can also be walked up) [Level Design Book: at least 2 routes up, exposed high ground] |
| **Jump pads** | J1 at (−7, +5) → treehouse. J2 at (+7, −5) → play-set |
| **Fountains** | F1 at (+6, +14), F2 at (−6, −14). Refill radius 1.5 m |
| **Towel racks** | R1 at (0, +16), R2 at (0, −16) |
| **Laundry lines** | North: x ∈ [−6, −1], z = +13. South: x ∈ [1, 6], z = −13 |
| **Low cover** (0.9–1.1 m) | 6 coolers (0.9 m) at the pool-deck corners and lane edges, 4 planters (1.0 m), 2 BBQs, 2 fountain basins |
| **Not cover** (≤0.5 m) | Sun loungers, flower beds, donut float |
| **Spawns** | **12 for FFA:** 4 per patio at (∓21, ±2) and (∓21, ±6), plus 2 per lane at (−10, +16), (+14, +15), (+10, −16), (−14, −15). Every spawn faces the map centre. **Team mode:** the own team's 4 patio spawns |
| **Spawn scoring** [Halo 3] | Base 1000. −500 per enemy in line of sight within 20 m. −250 per enemy within 10 m without line of sight. −700 for a splash-out within 8 m in the last 7 s, recovering +100/s. +200 per teammate within 10 m (team mode). Pick weighted-random among the top 3; never the same spawn twice in a row for the same player |
| **Sightlines** | Target: most sightlines 10–20 m, none longer than 30 m. **Hard cap 35 m** (the Drencher's maximum range). Enforce with a dev audit script: eye-height (1.35 m) points on a 2 m grid, raycast every pair, fail the build above 35 m, and fix failures with hedges, coolers or inflatables |

## 11. Netcode protocol

**Stack**
- Pin **`trystero@0.25.2` exactly**. 0.25.x changed the API (action objects, callback properties). Issue #196 reports slower joins on 0.25.4, which came from cutting relay spam. Re-benchmark joins (p50/p95 over 20 joins) before moving to ≥0.25.4.
- Nostr strategy, relay `redundancy` 5.
- `appId: 'splashbash-p1'`. Bump the protocol number on any wire change so incompatible builds never meet.
- Client simulation 60 Hz fixed; network sends 20 Hz.

**Authority** [Destiny client movement; Splatoon/Halo: Reach shooter-side hits; Overwatch RTT cutoff]

| What | Owner |
|---|---|
| Own movement, aim, tank, slide, knockback response | Client. Host sanity-checks it |
| Hit detection for streams, bucket and Drencher | Shooter: its own droplets tested against the interpolated remotes it renders. Shows the hitmarker immediately |
| Soak, drying, splash-outs, assists, score, respawns, spawn choice, protection, pickups, timer, bots, room size, slots | Host |
| Balloon trajectory and burst point | Thrower. Sends `pop`; each peer applies knockback to itself if within 3 m |
| Shooter RTT to host above 250 ms | Host ignores that shooter's claims and resolves hits from its own simulation of that shooter's cosmetic droplets |

**Unreliable channel `st`**
- In `onPeerJoin`, both sides create `getPeers()[id].createDataChannel('st', {negotiated:true, id:42, ordered:false, maxRetransmits:0})`, with `binaryType='arraybuffer'`.
- Before each send, skip the snapshot if `bufferedAmount` > 8 KB.
- Fallback if the channel fails: a Trystero action carrying a `Uint8Array`.
- Every packet is under 1200 B. All fields little-endian.

| Type | Direction and rate | Layout |
|---|---|---|
| 1 PlayerState (26 B) | Every peer to all at 20 Hz. Drops to 4 Hz when idle; sends immediately on a fire, jump or slide edge | `u8 type, u16 seq, u32 t (match ms), i16×3 pos (cm), i16×3 vel (cm/s), u16 yaw, i16 pitch, u8 flags (bit 0 grounded, 1 firing, 2 sliding, 3 inWater, 4 charging, 5 padFlight), u8 weapon (bits 0–1 id, bits 2–7 charge 0–63), u8 tank` |
| 2 WorldState (18 + 20·nBots B, ≤118 B) | Host to all at 20 Hz | `u8 type, u16 seq, u32 t, u8 soak[8], u8 aliveMask, u8 protectMask, u8 nBots`, then per bot `u8 slot` + a 19 B body (pos, vel, yaw, pitch, flags, weapon, tank) |
| 3 RelayState (27 B) | Host only, for mesh edges that failed to connect (listed in heartbeats) | `u8 type, u8 originSlot` + bytes 1–25 of a type 1 packet |

**Reliable Trystero actions** (JSON; names ≤32 bytes)

| Action | Direction | Fields |
|---|---|---|
| `hello` | Joiner → host | `{v, name≤16, hat, w}` |
| `welcome` / `full` | Host → joiner | `{epoch, slot, joinSeq, roster, match}` / `{}` |
| `roster` | Host → all, on change | `[{id, slot, name, hat, team, joinSeq, bot}]` |
| `match` | Host → all, 1 Hz and on change | `{epoch, mode, phase, endsAt, stats[8][splashes, soaked, assists], teamScore[2], respawnAt[8], pickups{id: readyAt}, seed}` |
| `shot` | Shooter → all | `{sid, w, t, o[3], d[3], seed, c}`. Sloshbucket, Drencher and balloon only; Soaker streams are carried by the firing flag, and remotes spawn cosmetic droplets. Receivers fast-forward the projectile by now − t |
| `pop` | Thrower → all | `{sid, t, p[3]}` |
| `hit` | Shooter → host, batched ≤10 Hz | `[{v, amt, n, t, p[3], cseq}]`. Deduplicated by (slot, cseq) |
| `splash` | Host → all | `{v, by, w, assist[], t, respawnAt, medals[]}` |
| `spawn` | Host → all | `{slot, p[3], yaw, t, protectUntil, w}` |
| `pickup` | Host → all | `{id, by, t, readyAt}` |
| `pick` | Client → host | `{w}`, applied at the next spawn |
| `hb` | Every peer → all, 1 Hz | `{epoch, peers: slot[], rttHost}` |
| `host` | New host → all | `{epoch, joinSeq}` |
| `kick` | Host → all | `{id, reason}`. Every peer closes that connection and ignores the id |
| `sync` (request kind) | Client → host | `{t0}` → `{t0, th}` |

**Timing**
- **Interpolation:** Hermite using the sent velocity. Delay D = clamp(2.5 × send interval + p95 jitter, 100, 200) ms, starting at 120 ms. [Valve 100 ms; Gaffer's survive-2-losses rule]
- **Extrapolation:** only when the buffer runs dry, capped at 250 ms, then freeze. Blend corrections over 100 ms; snap if the error exceeds 3 m.
- **Clock:** `performance.now()`. For each sample, rtt = t1 − t0 and offset = th + rtt/2 − t1. Keep 16 samples, drop those more than 1σ from the median, average the rest. Poll every 1 s for 10 s, then every 5 s. Slew at most 1 ms per frame. [Simpson]
- **Host lag history:** the host keeps 1 s of every participant's positions to validate claims made at time t.

**Hosting and migration** [Splatoon 2 Pia; Destiny host migration]
- Self-host collision in a quick-play room: the winner has the higher epoch, then the lower joinSeq, then the earlier `hostSince` (wall-clock ms), then the lower id. The loser drops its bots and sends `hello`.
- Host failure is declared on no WorldState or `hb` from the host for **2.5 s**, or on `onPeerLeave(host)`.
- The new host is the connected human with the lowest joinSeq (ties broken by id). It sends `host` with epoch + 1. The higher epoch always wins.
- The new host rebuilds from the last `match` and WorldState: soak, bots at their last positions, respawn timers. It keeps `endsAt` by publishing its clock offset, so the timer never pauses. Clients re-send unacknowledged `hit` claims younger than 300 ms.

**Validation on the host** (cheap checks on every peer too)
- Parse inside try/catch. Reject NaN or ±Infinity, oversize arrays, and messages over 1200 B.
- Speed: displacement ≤ 9.0 m/s × 1.3 over a 500 ms window, with allowances for jump pads and knockback. Otherwise snap back and add a strike.
- Hit claims must pass all of:
  - shooter and victim both alive, victim not protected;
  - distance at the host's historical time t ≤ 1.25 × max range + 1.5 m;
  - t within [hostNow − (RTT/2 + D + 150 ms), hostNow + 50 ms];
  - `amt` clamped to n × max soak per hit;
  - soak per 1 s window ≤ 1.25 × the weapon table value;
  - shooter's tank not implausibly empty.
- After more than 500 ms of silence followed by a burst (lag switch), drop claims older than the window.
- 3 strikes in 10 s means a kick.
- A cheating host is out of scope; that is accepted for a casual game.

**NAT and bandwidth**
- STUN only (the Trystero defaults), plus host relay (type 3) for broken pairs, plus a clear "couldn't connect" message with the bot fallback. About 19% of full rooms are estimated to have at least one broken pair.
- Budget: about 135 kbps up and 135 kbps down per peer at 20 Hz; host upload ≤300 kbps worst case. [Halo: Reach ran 16 players at 250 kbps]

## 12. Bot behaviour

- **Simulation:** on the host only. Movement at 60 Hz with the same capsule and weapon code as players. Decisions at 5 Hz, staggered across bots. Budget ≤0.25 ms per bot per frame. A new host adopts the bots from the last WorldState and re-plans them.
- **Navigation:**
  - About 40 waypoints authored in Blender as empties named `wp_###`, each with a custom property `links`.
  - Jump and pad links are flagged.
  - A* over this graph, with local steering.
- **States:**
  - **Wander:** weighted random goal among lanes, fountains and towels.
  - **Engage:** fight the current target.
  - **Refill:** when tank <25, go to the nearest refill zone and stay until ≥90. Abort if an enemy comes within 8 m.
  - **Retreat:** when own soak ≥70 and the target's ≤40, break line of sight to the nearest cover node for up to 3 s.
  - **Towel:** when soak ≥50 and a ready towel is within 15 m.
- **Perception:**
  - Vision cone 110° out to 30 m, with a line-of-sight raycast at 5 Hz.
  - "Hearing" makes the bot aware of an enemy regardless of the cone: any enemy firing within 12 m, or any hit on the bot.
- **Targeting:**
  - Reaction delay of 400–700 ms (uniform) before the first shot at a newly seen target.
  - Retarget hysteresis 1.5 s; prefer whoever last hit the bot.
- **Aim:**
  - Aim point = target capsule centre + 50% of target velocity × droplet flight time.
  - Gaussian aim error: σ starts at 4° and falls to 2° over 1.5 s of continuous tracking, plus 1° per 1 m/s of the target's lateral speed.
  - Yaw slew ≤200°/s. Fire only when the error is under 6°.
- **Movement:**
  - Speed ×0.9 (5.4 m/s), no slides.
  - While engaged: strafe direction changes every 0.6–1.2 s at the weapon's preferred range (Soaker 8 m, Sloshbucket 3 m, Drencher 20 m); random jumps at 10% per second.
- **Loadout mix:** Soaker 60%, Sloshbucket 25%, Drencher 15%. Drencher bots release at 60–80% charge, so they never one-shot anyone.
- **Balloons:** thrown when the target is 5–12 m away and either behind low cover or within 3 m of another enemy, and the bot's tank is ≥60. 8 s cooldown per bot.
- **Mercy rule:** a human who has been splashed out 3 times in a row without splashing anyone gets bot σ +2° against them until they score. [Smash Karts deliberately weak bots]
- **Labelling:** bots show a "BOT" tag on the scoreboard and nameplate, cute names, random hats. In team mode, bots are balanced per team.

## 13. Explicit non-goals for v0.1

- Accounts, XP and levels, currency, shop, season pass, persistent stats or leaderboards.
- Pattern atlas, gun stickers and emotes. v0.1 customisation is limited to slot colour, 8 hats, the name, and face expressions reacting to events.
- Mobile/touch and gamepad. Keyboard and mouse only; other inputs are not blocked, just unsupported.
- A second map, map voting, or modes beyond FFA and Team (no CTF or king-of-the-hill).
- Streak power-ups or nuke equivalents, power-weapon pickups, dodge dash, super jump.
- Mid-life weapon switching, ADS/zoom, reload, headshots or crits, pressure-dependent range.
- Paint or persistent ink coverage. Wet decals are cosmetic and fade.
- Floor soak, sprinkler hazards, weather.
- Swimming, diving, deep water.
- Networked physics props and ragdolls. Inflatables are driven by the match clock.
- TURN relay. The Cloudflare TURN via Worker goes in the backlog.
- Dedicated servers, protection against a cheating host, vote-kick.
- Text chat and voice chat.
- Spectator mode, replays, kill-cam replay (the static "Soaked by" card only).
- Custom physics settings in private rooms (gravity, damage multiplier, regen).
- Languages beyond Korean and English.