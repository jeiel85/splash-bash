# Splash Bash research: live casual browser shooters

**About the sources:** most numbers come from each game's own fandom wiki, read through the MediaWiki API. Some SEO "guide" sites such as playonhub and shellshock.pro gave weapon stats that disagree with the wikis, so I dropped them. Anything marked (unverified) or (rec) is my inference or recommendation, not a sourced fact.

## 1. From landing page to first shot

| Game | Flow | Clicks after load | Name | Friends / private | Bots |
|---|---|---|---|---|---|
| **Krunker** | Guests can play with no account and join the default server straight away. Guests are locked out of Hunter, Vince, Detective and Bowman. An account is needed for chat (level 5+), earning KR, and vote-kick. | about 1–2 | Guest by default | "Host Game": up to 10 players (6 for guests), default size **2**, default length **4 min**, all settings editable. Friends can join a friend's game from their profile. | None in public games |
| **Shell Shockers** | Main menu has name, mode, server region, weapon and a big Play button. You can also pick a weapon just before each spawn. | about 1–2 | Typed on the menu | "Create" → pick mode, server and map (every map is allowed in private games) → you get a code/link like `shellshock.io/#RNSBIF2`. You can paste the code, `#code` or the full URL. Any game, public or private, has an invite / copy-link button on the spawn screen. The host can /kick, /lock, pin chat messages, and set gravity, damage multiplier, regen rate and disabled weapons. | None |
| **Smash Karts** | Play drops you into a public match. A new player's first match is a tutorial with bots. | 1 | Auto-generated | Private match reachable only by code. **Every** match, public or private, shows its code and a "Copy invite link" button. The host sets mode, arena, weapons, match length (1–10 min) and player count. | Bots fill FFA games with **3 or fewer humans**. They are deliberately weak: slower, never drift, fire more or less at random. |
| **Venge.io** | Play → objective map | 1–2 | Guest | Private room: share the link from the lobby screen | — |
| **Bonk.io** | Quick Play (fixed mode, max **4**/server, goes straight into the map rotation) or Custom Game | 1 | Guest | Host sets rounds, teams, password and room name, and can hand host to someone else. Share the room link. | — |
| **1v1.lol** | Modes plus Practice, Aim Trainer and bot matches | 1–2 | Guest | Party mode shares a code for back-to-back custom games | Bot practice |

## 2. Match structure

- **Krunker**
  - Public games have **8 players** and a **4-minute timer**.
  - At the end, players vote from **4 map/mode options**; FFA always appears at least once.
  - Stats only count if you finish the match. Leaving early counts as a loss (since v5.0.0).
  - Scoring:
    - Kill +50 (+25 for pistol, crossbow or rocket kills), melee +150, assist +25.
    - Bonuses: headshot +50, mid-air +25, revenge +25, first blood +25, close call +20.
    - Multikills: double +50, triple +100, up to +350.
    - Slide kill ("Driftkill") +50; 360-spin kill +50.
  - A 25-kill streak gives a Nuke: 10 s countdown, then kills all enemies.
  - Health regenerates (it can be turned off in custom games).
  - Custom games: respawn delay 0–15 s, score limit 0–10000, 0–10 lives, 0–60 min.
  - Hardpoint: the zone moves every minute; holding it earns 10 points per 1.5 s.
  - Domination: capturing a zone takes 10 s.
  - Capture the Flag: a dropped flag resets after 45 s.
- **Shell Shockers**
  - Lobbies run continuously; FFA and Teams have **no win condition**, and players chase their personal best streak.
  - King of the Coop is the only mode with rounds: first team to **5 captures**. More players on the point capture faster, capped at 5.
  - Death means a **5 s respawn countdown**, sometimes with an ad. Spawn invincibility is **about 4 s** (per NamuWiki).
  - Egg HP is 100 and regenerates.
- **Smash Karts**
  - Matches last **3 minutes**; private matches can be 1–10 minutes.
  - Dying shows a **5–7 s banner ad**, which is their main revenue moment (Google publisher case study).
- **Venge.io**
  - Built around objectives. The Point mode's capture zone moves about every 30–60 s.
  - Gun Game advances you one weapon tier after 2–3 kills.
- **Spawn selection:** none of these games documents its spawn logic.
  - The best public reference is Halo 3. Every spawn point starts at weight 1000.
  - An enemy within about 5 tiles in the last 7 s gives −500; a nearby teammate gives +500.
  - A recent death there gives −700, recovering by 100 per second.
  - The pick is random, weighted by those scores, and ignores line of sight.

## 3. Movement

- **Krunker class speed multipliers:**
  - Run N Gun 1.18 (can wall-jump twice)
  - Triggerman 1.05
  - Hunter 1.0
  - Spray N Pray 0.9 (cannot jump onto crates)
- **Krunker weapon speed multipliers:**
  - Knife 1.1 (the "knife buff")
  - Pistol 1.05, SMG 1.04
  - Assault rifle 0.95, sniper 0.95
- **Other Krunker movement:**
  - There is no sprint key. Holding two movement keys (diagonal "strafe") runs at **1.2×** (the custom range is 1–2).
  - Crouch slows you and gives shorter jumps.
  - Pressing crouch just before landing starts a **slide of about 1 s**, the fastest way to move. You can steer it but not go backwards.
  - Slide-hopping means jumping again before the slide ends, which keeps and adds momentum. It has been frame-rate independent since v2.8.4.
  - Default gravity 1 (range 0–2) is already much lower than real gravity. Jump force defaults to 1 (range 0.1–3).
  - Speed lines appear at high speed. A "Turbo" kill needs a speed of 200+ on the speedometer.
  - Default FOV is 90 (range 60–175); sensitivity defaults to 1 (range 0.1–15).
- **Shell Shockers:** movement is plain WASD and jump; jump-spamming is the standard way to dodge. Private games can change gravity. I found no speed numbers.
- **Reference speeds from other games:** Overwatch 5.5 m/s (crouched 3.0, backwards 90%); Valorant run 6.75 m/s, walk 3.8 m/s.
- **Recommended for Splash Bash (rec):**
  - Run 6.0 m/s, backwards ×0.9, crouch 3.0 m/s.
  - Belly-slide about 1 s at ×1.3 of entry speed; jumping cancels it and keeps momentum.
  - Jump apex about 1.2 m, with about 30% air control.
  - No sprint key.

## 4. HUD conventions

- **Krunker**
  - Crosshair types: default, custom, layered, image, precision. The default crosshair widens with spread.
  - Custom hitmarker image.
  - Floating **damage numbers** with a separate critical-hit colour (size slider 0.1–2).
  - Toggleable kill feed.
  - **Tab** scoreboard (added in v1.2.5); Alt shows the player list.
  - Medal popups such as "Headshot", "Quick Scope" and "Driftkill", each with a score popup.
  - Health bar that changes colour between high and low.
  - Enemy nametags with health bars (a custom option hides them).
  - Ping and speedometer toggles.
- **Shell Shockers**
  - A round health dial showing the HP number. It turns into a shield shape while the +100 shield is active.
  - Streak counter in the top-left.
  - **Damage shows on the model itself**: the egg cracks more with every 20 HP lost below 80, so enemies read your health without numbers.
  - The shotgun reticle widens when moving or jumping.
  - The rocket launcher's aim box turns red below the 3 m minimum range and green when a shot is valid.
  - The spatula carrier is visible through walls.
- **Damage direction indicators:** not documented for any of these games. Use the standard radial arc (rec).

## 5. What keeps casual players coming back

- **No friction:** no install, guest play, runs on low-end hardware.
- **Short rounds with a reason to replay:** Krunker's 4-minute round ends in a map vote; Smash Karts' 3-minute round starts the next one immediately.
- **Constant feedback:** medals, score bonuses and damage numbers after almost every action.
- **Visible progress:** XP and levels (Smash Karts goes to level 200), in-game currency per kill (Shell Shockers gives 10 eggs per kill, doubled on weekends), cosmetics-only shops, season pass.
- **Streak rewards (Shell Shockers):** power-ups at 5/10/15/20/25/30 kills:
  - +100 HP shield
  - Double damage for 15 s, with +2–3 s per kill
  - Ammo refill
  - Overheal to 200 HP
  - Double currency
  - Half-size egg
- **Rivalries:** continuous lobbies mean you keep meeting the same opponents.
- **A cute, memorable theme** at 200M+ lifetime players (Shell Shockers).
- **Bots:** they guarantee action even in an empty lobby.
- **Depth under a simple surface:** Krunker's slide-hopping.

## 6. Weapon types and time to kill (TTK = number of hits minus one, times the delay between shots)

| Type | Example (stats) | TTK vs 100 HP |
|---|---|---|
| Assault rifle | Krunker AR: 23 body / 34.5 head, 130 ms between shots, 28-round mag, 1.5 s reload | **0.52 s** body, 0.26 s headshots |
| Auto rifle | Shell Shockers EggK-47: 30 damage falling off to 2, 30-round mag | 4 close-range hits |
| SMG | Krunker SMG: 18 body, 100 ms, 24-round mag, 1.0 s reload<br>Shell Shockers Whipper: 23 damage, 600 rounds/min, 40-round mag | **0.50 s**<br>**0.40 s** (5 hits) |
| Burst rifle | Shell Shockers Tri-Hard: 35 × 3-round burst, 120 bursts/min | 2 bursts, about 0.5 s |
| Shotgun | Krunker: 5 pellets × 50 = 250, 450 ms, 2 shells, range 160 units<br>Shell Shockers Scrambler: 20 pellets × 7.5 = 150, 2 shells | One shot up close |
| Sniper | Krunker: 109 body / 163.5 head, 1000 ms, 3-round mag<br>Shell Shockers Crackshot: 180 dead-centre, ≤60 on the edge<br>Venge.io sniper: 95 body / 100 head, 1.1 s between shots | One hit, or 2 on a glancing hit |
| Marksman rifle | Shell Shockers Free Ranger: 85–95 per hit, one hit only dead-centre, 15-round mag | Under 2 s |
| Explosive | Shell Shockers RPEGG: 200+ direct, 100→3 splash, 3 m minimum range, 3 rounds carried<br>Grenade: 3 s fuse, max 3 carried | One hit |
| Sidearm | Krunker pistol: 20 body, 150 ms<br>Shell Shockers Cluck 9mm: 23 damage, 450 rounds/min | 0.53–0.6 s |
| Melee | Krunker knife: 50, 250 ms, thrown 180<br>Shell Shockers whisk: 40, about 1.5 s swing | 0.25 s (knife) |

Across these games, automatic weapons kill in about **0.4–0.6 s** of hits on the body. High-skill weapons (sniper, shotgun) can kill in one hit.

## Ranked: 10 features to copy

1. **Two clicks to your first splash.** The page loads into a live 3D lobby with a cute generated name already filled in (editable) and one big "Splash!" button. No account. (Krunker, Shell Shockers, Smash Karts)
2. **The room link is the invite.** Every match shows a short code and a "Copy invite link" button, with the Trystero room ID in the URL hash like `/#ABCD`. The same link works for public and private rooms. (Smash Karts, Shell Shockers)
3. **Bot backfill.** The host keeps at least 4 players by adding bots, and removes a bot each time a human joins. Bots are deliberately weaker: slower, worse aim, slower reactions. (Smash Karts' ≤3-human rule)
4. **Timed 3–4 minute rounds**, then a podium and a vote on 3 map/mode options with FFA always offered. Late joiners drop straight in and nobody is penalised for leaving. (Krunker, Smash Karts)
5. **Soak shown on the character.** Visible wetness steps every 20% soak (dripping, then soggy, then puddle), plus a round soak dial in the HUD. Soak drains after a delay. (Shell Shockers cracks and regen)
6. **Fair spawns.** 2–3 s auto-respawn (not Shell Shockers' 5 s) with a 3 s bubble shield that ends when you fire. Spawn choice uses Halo-style weights: base 1000, enemy nearby −500, recent death −700 recovering 100 per second, weighted random pick.
7. **A feedback stack.** Hitmarker, floating splash numbers with a crit colour, kill feed, Tab scoreboard, and "Splashed out!" medals that give score bonuses: first blood, revenge, mid-air, slide kill, double splash. (Krunker medals and scoring)
8. **Six clear weapon types, tuned to Krunker-like kill times.** Auto soaker (about 0.5 s), burst rifle, bucket shotgun (full soak at close range), charge sniper (full soak on a centre hit, 2 hits otherwise), water-balloon lobber (3 s fuse, carry 3), plus a squirt-pistol sidearm.
9. **Streak power-ups instead of a nuke.** 5 splashes: raincoat shield (+100). 10: "Super Pressure", double damage for 12 s with +2 s per splash. 15: full refill. (Shell Shockers)
10. **Slide and jump as the skill ceiling.** No sprint key; diagonal ×1.2 kept as optional; a belly-slide of about 1 s that jumping cancels while keeping momentum; speed lines at high speed. Private rooms also get Shell Shockers-style host toggles: gravity, damage multiplier, regen, allowed weapons, lock, kick. (Krunker movement, Shell Shockers 0.47.0 settings)

## Sources
- [Krunker Game Modes](https://krunkerio.fandom.com/wiki/Game_Modes), [Custom Games](https://krunkerio.fandom.com/wiki/Custom_Games), [Moveset](https://krunkerio.fandom.com/wiki/Moveset), [Classes](https://krunkerio.fandom.com/wiki/Classes), [Assault Rifle](https://krunkerio.fandom.com/wiki/Assault_Rifle), [Sniper Rifle](https://krunkerio.fandom.com/wiki/Sniper_Rifle), [SMG](https://krunkerio.fandom.com/wiki/Submachine_Gun), [Shotgun](https://krunkerio.fandom.com/wiki/Shotgun), [Scoring](https://krunkerio.fandom.com/wiki/Scoring), [Settings](https://krunkerio.fandom.com/wiki/Settings), [Accounts](https://krunkerio.fandom.com/wiki/Accounts), [Nuke](https://krunkerio.fandom.com/wiki/Nuke), [Slidehopping](https://krunkerio.fandom.com/wiki/Slidehopping), [Krunker guide: game modes](https://krunker.io/guides/game-modes/)
- [Shell Shockers weapons](https://shellshockers.fandom.com/wiki/Weapon), [EggK-47](https://shellshockers.fandom.com/wiki/EggK-47), [Crackshot](https://shellshockers.fandom.com/wiki/Crackshot), [Private game](https://shellshockers.fandom.com/wiki/Private_game), [Gamemodes](https://shellshockers.fandom.com/wiki/Gamemodes), [Healthmeter](https://shellshockers.fandom.com/wiki/Healthmeter), [Power-Ups](https://shellshockers.fandom.com/wiki/Power-Ups), [Grenade](https://shellshockers.fandom.com/wiki/Grenade), [NamuWiki Shellshock.io](https://en.namu.wiki/w/Shellshock.io), [Boar review](https://theboar.org/2021/07/shell-shockers-review/), [Wikipedia](https://en.wikipedia.org/wiki/Shell_Shockers)
- [Smash Karts Bots](https://smash-karts.fandom.com/wiki/Bots), [Tall Team, Google publisher story](https://www.google.com/ads/publisher/stories/tall_team/), [Poki Smash Karts](https://poki.com/en/g/smash-karts)
- [Venge.io wiki](https://vengeio.fandom.com/wiki/Weapons), [Poki Venge.io](https://poki.com/en/g/venge-io), [Bonk.io Quick Play](https://bonkio.fandom.com/wiki/Quick_Play), [Bonk.io Custom Game](https://bonkio.fandom.com/wiki/Custom_Game), [1v1.lol modes](https://1v1lolreloaded.com/blog/game-modes-explained/)
- [Halo 3 spawn system (FyreWulff)](https://halo.bungie.org/misc/fyrewulff_spawnsystem/), [Overwatch movement speed](https://overwatch.fandom.com/wiki/Movement_speed), [Valorant walking/running](https://support-valorant.riotgames.com/hc/en-us/articles/4414682724755-Walking-Running-and-Crouching)