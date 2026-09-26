# Splash Bash: cute art direction and game feel research brief

Tags: **[src]** means the fact comes from a source listed at the end. **[rec]** means it is our recommendation for Splash Bash. **[calc]** means I computed it: CIELAB ΔE with Machado-2009 full-strength simulations for protan, deutan and tritan vision, and WCAG contrast ratios. **[verified]** means I checked it live, here against the Google Fonts CSS API.

---

## 1) Shape language and proportions

**What the reference games did**
- **Fall Guys**
  - The bean shape took "weeks of testing". A humanoid felt too aggressive and a circle too simple. The bean was "instantly loveable and funny when it fell". [src]
  - It has little legs, so it trips and has a high centre of gravity. It has big arms so falls look expressive. [src]
  - Its canonical height is 183 cm. [src]
  - Costumes sit on top of a padded base, "a costume on top of a costume". [src]
  - Fidelity was capped because 60 characters must render on screen at once. [src]
- **Party Animals**: plump round bodies, button noses and simple "thoughtless" eyes. The comedy comes from physics, not detail. [src]
- **Brawl Stars**: big heads, small bodies, short stubby limbs, and a unique silhouette for each character. [src]
- **Overwatch** (GDC 2017, Petras and Tsang)
  - Every hero must be identifiable in the middle of a fight. [src]
  - Mei's gun became a one-handed pistol so her silhouette differed from another hero's. [src]
  - Ana got a triangular cape for the same reason. [src]
- **Fortnite** (Peter Ellis, GDC 2018)
  - Start from real-world objects, then "taper, bulge or pinch" them. [src]
  - Remove parallel lines. [src]
  - Apply the style hardest at prominent touchpoints (doors, windows, characters), not on every asset. [src]
- **Animal Crossing: New Horizons**: keeps the art simple on purpose to leave players an "imagination gap". [src]
- **Baby schema (Lorenz)**: large head, large eyes below the skull's midline, round cheeks, short thick limbs, plump body, soft-elastic surface. These features measurably raise how cute people rate a face. [src]

**Recommendations for Splash Bash** [rec]
- **Body**
  - A gumdrop or bean body with head and torso fused into one mass. The head takes about 45% of total height, so the character is roughly 2 to 2.2 "heads" tall.
  - Mitten-sphere hands with no fingers, so no finger rig is needed.
  - Nub feet.
  - Eyes are large and sit in the lower half of the face.
- **Size**: about 1.5 m tall, collision capsule about 0.8 m wide, camera at about 1.35 m. Level metrics stay near engine norms (Unity-style eye height is 1.5–1.7 m). [src + rec]
- **Silhouette test**: characters differ by hat or hair silhouette, not by body. Water guns must read as four distinct silhouettes in black fill at 64 px: pistol, blaster, super-soaker, bucket or balloon.
- **Blender modelling**
  - Bevel modifier: 3–4 segments, angle limit 30°, width about 6–10% of the object's smallest dimension.
  - Follow with a Weighted Normal modifier.
  - Never ship an edge the camera can see as sharp.
- **Taper rule** (Fortnite): no perfectly vertical walls on props. Taper by 3–5° and bulge the middles slightly.
- **Diegetic ammo** (from Splatoon's back-mounted ink tank): a transparent water tank on the gun, and a backpack tank on other players, shows the water level.
- **Triangle budgets**: characters 3–6k tris; hats 800 or fewer; props 200–2k; whole arena 150–300k.

## 2) Colour and readability

**What the reference games did**
- **Overwatch environments** (via the Level Design Book)
  - Avoid deeply saturated colours and leave room for lighting: "if you make a very red texture, it can't get much redder." [src]
  - Keep walls plain with little noisy detail and push detail to the edges of the play space. [src]
  - Make floors darker than walls. [src]
  - Reserve specific colours for gameplay meaning. [src]
- **Overwatch UI**: enemies are red and allies blue by default. Players can change the enemy UI colour (to yellow, purple and others) under colour-blind options. [src]
- **Splatoon**
  - Teams always use a pair of contrasting colours. [src]
  - Signature pairs: orange vs blue (Splatoon 1), pink vs green (Splatoon 2), yellow vs blue (Splatoon 3). [src]
  - Splatoon 3's "Color Lock" setting keeps the ink pairs predictable for colour-blind players. [src]
  - A Splatoon 3 Splatfest blue ink was widely reported as hard to see (Automaton, 2022). The lesson: test team colours against the arena. [src]
- **Fall Guys**
  - About 50 colours, drawn from food and sweets references. [src]
  - In team rounds the costume colour is overridden by the team colour, but the faceplate stays the same. [src]

**Team pair: Tangerine #FF8A1F vs Grape #7B5CFF** [calc]
- Lightness (L*) 69 vs 51.
- ΔE between the two colours:

| Vision type | ΔE |
|---|---|
| Normal | 149 |
| Protan | 141 |
| Deutan | 150 |
| Tritan | 82 |

- Alternatives I rejected:
  - Coral vs Teal drops to ΔE 22 for protan vision.
  - Pink vs Lime drops to ΔE 69 for deutan vision.
- Blue must not be a team colour. The pool and sky are already blue.

**Environment palette for a sunny backyard or water park** (hex)

| Group | Swatch | Hex |
|---|---|---|
| Sky | Top | `#7EC8FF` |
| Sky | Horizon | `#CDEBFF` |
| Pool | Deep | `#2BB5D8` |
| Pool | Shallow | `#6FD6E8` |
| Pool | Foam | `#F4FFFF` |
| Pool | Tile | `#DDF4F7` |
| Grass | Base (lighter, yellower green, not saturated) | `#A6D98C` |
| Grass | Shade | `#7FB27A` |
| Deck | Wood | `#F2D6B0` |
| Deck | Wood shade | `#D9B48A` |
| Walls | Stucco | `#FFF4E0` |
| Inflatables (pastel only) | Mint | `#BDF2D5` |
| Inflatables (pastel only) | Lemon | `#FFF1A8` |
| Inflatables (pastel only) | Pink | `#FFC8D8` |
| UI | Outline and text ink | `#2B1D4A` |

Team ramps:

| Team | Dark | Base | Light |
|---|---|---|---|
| Tangerine | `#C85A00` | `#FF8A1F` | `#FFC285` |
| Grape | `#4A2FC0` | `#7B5CFF` | `#BBA8FF` |

**Findings from the colour checks** [calc]
- Tangerine vs the pool, sky and tiles stays at ΔE 77 or more under every simulated colour-vision deficiency.
- Grape vs any mid-value blue-grey shadow (for example `#6E8C9E`) drops to ΔE 18–23 under deficiency simulation. So:
  - Keep environment shadow tints warm or teal and lighter, never blue-violet.
  - Never rely on hue alone. Add an outline, a rim light and a team icon.
- Free-for-all with 8 colours (`#FF8A1F #7B5CFF #FF4F8B #19C3A6 #FFD23F #3D8BFF #A0E426 #FFFFFF`) cannot be made colour-blind safe. Yellow vs lime falls to ΔE 5. Each FFA player also needs a distinct hat silhouette or symbol and a nameplate.
- UI contrast:

| Combination | Contrast | Verdict |
|---|---|---|
| White on Tangerine | 2.36:1 | Fails |
| Dark ink `#2B1D4A` on Tangerine or yellow | 9.4:1 | Use this |
| White on Grape | 4.36:1 | OK for large text |

**Colour rules** [rec]
- Characters are the most saturated things on screen. The environment is at least about 30% less saturated.
- Water streams and splashes are team-tinted, roughly 35% team colour mixed into `#BFF3FF`, so you can tell whose stream it is.
- Offer an enemy-colour override option, as Overwatch does.

## 3) Toon shading in Three.js at 60 fps

| Technique | How | Cost | Verdict [rec] |
|---|---|---|---|
| Ramp shading | `MeshToonMaterial` with a 3–4 texel `gradientMap`. Filters must be `NearestFilter`, colour space `NoColorSpace`. [src] Suggested ramp values [0.62, 0.85, 1.0] so shadows stay colourful. | Almost free | Yes, everywhere |
| Rim light | Add a Fresnel term through `onBeforeCompile`, e.g. `(1-dot(V,N))*pow(NdotL,0.2)`, then `smoothstep(0.59,0.61)`. Tutorial defaults: rim amount 0.6, specular `smoothstep(0.05,0.1)`. [src] Tint the rim with the team colour. | Almost free | Yes, on characters and pickups |
| Outlines, inverted hull | Draw back faces, pushed out along the normals. The built-in `OutlineEffect` re-renders the whole scene (default thickness 0.003). [src] Hull outlines can add up to about 50% render cost. [src] | +1 draw call per outlined mesh | Characters, guns and pickups only, with a custom per-mesh hull. Outline colour = the team's dark shade, which is an extra team cue |
| Outlines, post pass | Depth and normal edge detection. `OutlinePass` scales badly with many objects. [src] The WebGPU `ToonOutlinePassNode` only works with toon materials. [src] | Full-screen fill rate | Optional high-quality setting |
| Shadows | One directional sun with a tight frustum over the arena. Shadow maps of 1024–2048 px on desktop. [src] 3 or fewer dynamic lights. [src] | Moderate | Only characters and large props cast shadows. Bake ambient occlusion into vertex colours in Blender. Always add a blob shadow under each character for grounding |
| Bloom | pmndrs `postprocessing` `BloomEffect` with `mipmapBlur`. Set `luminanceThreshold` near 1 and push only chosen emissives above 1. `EffectPass` merges effects into fewer passes. [src] | Moderate | Water sparkles, pickups and the splash-out burst only. Half resolution on the low tier |
| Tone mapping | `NeutralToneMapping` (Khronos PBR Neutral) matches base colours 1:1 up to a threshold. [src] ACES shifts bright saturated colours. | Free | Neutral, so the palette hex values survive |
| Budgets | Desktop handles "several hundred" draw calls; mobile about 100. Cap pixel ratio at `min(dpr, 2)`. Textures 2048 or smaller, KTX2. Use `InstancedMesh` for particles and repeated props, `BatchedMesh` for static environment. [src] | — | Target 250 draw calls or fewer and a 1.5 pixel ratio on the low tier |

- **Water** [rec]
  - Toon-banded surface with vertex waves.
  - Foam as authored ring meshes, not depth-texture foam.
  - Streams as instanced capsule droplets plus one ribbon trail.
- **Wet-spot decals** [rec]: a pool of 64–128 decals that fade after 3–5 s ("evaporation").

## 4) Cheap character customization

**What the reference games did**
- **Fall Guys**: about 50 colours × about 50 patterns × about 50 tops × about 50 bottoms, plus faceplates, gives thousands of combinations from few assets. [src]
- **Splatoon**: three gear slots (headgear, clothing, shoes). [src]

**Recommendations** [rec]
- **Colour**: one shared character material. An RGB mask (vertex colour or a 256 px mask) maps R to primary, G to secondary and B to accent. Colours are passed per instance as uniforms.
- **Patterns**: a 1024 px atlas of tiling greyscale patterns (stripes, dots, checks, camo, hearts, waves), multiplied inside the secondary-colour zone.
- **Face**: a separate face mesh sampling a 4×4 expression atlas at 512 px, switched by UV offset.
  - Expressions: idle, blink, happy, wince, determined, sleepy, dizzy (`@_@` for splashed out), smug.
  - Faces react to events: hit → wince; kill → smug.
- **Hats**: GLB files attached to a head socket bone, 800 tris or fewer, pivot at the top of the head. Keep 16–32 hats at launch.
- **Team modes**: the team colour overrides primary and secondary. Hat, face and pattern are kept for identity, following Fall Guys' faceplate rule.
- **First-person camera**: your own gun is the cosmetic you see most. Prioritise gun colours and a sticker atlas. Show the full body in the lobby, emotes and the splash-out camera.
- **Networking**: one cosmetics payload of 4 bytes or less sent on join:
  - colour pair: 2 × 6 bits
  - pattern: 5 bits
  - face: 4 bits
  - hat: 6 bits

## 5) Hit and splash-out feedback ("juice")

**Sourced principles** [src]
- **Juice it or Lose it** (Jonasson and Purho): add more feedback than feels reasonable, then dial it back. Juice sits on top of a mechanic that already works.
- **Art of Screenshake** (Nijman, Vlambeer): bigger bullets, muzzle flash, hit animations, gun kickback, permanence (debris stays), and a 20 ms sleep on kill.
- **Hitstop**: a pause of a few dozen milliseconds on impact, as in fighting games.
- **Screen shake** (Eiserloh, GDC 2016): shake = trauma² × maximum, driven by Perlin noise, with trauma decaying over time.
- **Shake comfort**
  - Hits ring down in 0.15–0.25 s; explosions last about 0.3 s. Around 1.5 s risks motion sickness.
  - Rotational shake is worse than positional.
  - Ship an intensity slider.
- **Xbox Accessibility Guideline 117**
  - Let players disable shake, head bob, blur and weapon sway, and adjust field of view.
  - Halo Infinite has 0–100% sliders for these effects.
  - Suggested FOV: 85–110° on PC.
- **Splatoon damage readouts**
  - Screen-edge ink appears above 30 damage (Splatoon 1 and 2) or 20 damage (Splatoon 3).
  - Healing starts after a 1 s delay: 12.5 HP/s in humanoid form, 100/s while submerged.
  - Splatoon 3 v11.0.0 (Jan 2026) added a brief enemy health bar that appears after a hit.
- **Fortnite damage numbers**: white = health, blue = shield, yellow = critical hit.
- **Overwatch hit sound**
  - The hit-pip is a reversed beer-can opening.
  - It must cut through the mix but not sound like any hero.
- **Audio variation**
  - Randomise pitch by 0–2 semitones.
  - Raise pitch step by step on chained hits.

**Splash Bash spec** [rec]

*Shooter side*
- Recoil kick of 0.3–0.8° pitch per shot, recovering in 120 ms.
- A bubbly "bloop" hit sound:
  - pitch jitter of ±1.5 semitones
  - +1 semitone for each consecutive hit within 0.5 s, capped at +7
- The hitmarker grows 1.0→1.3 with an easeOutBack curve over 90 ms.
- Soak numbers are optional. Use yellow for head splashes, following Fortnite.

*Target, as seen by others*
- Squash and stretch that preserves volume (Y = s, XZ = 1/√s): s = 0.85 for 60 ms, then a damped spring at about 9 Hz with damping ratio about 0.45.
- Wetness rises with the soak level:
  - albedo × 0.8
  - a wider, brighter specular band
  - drip particles stepping up at 25, 50 and 75%
- An overhead soak bar for 2.5 s after each hit (Splatoon 3 style).

*Victim's own screen*
- Edge-droplet overlay starts at 25% soak and scales with it.
- No rotational shake from normal streams.
- Drying starts after a 1.5 s delay.

*Splash-out (the "kill")*
- The victim swells 1.0→1.25 over 120 ms, then pops like a water balloon:
  - 24–40 instanced droplet spheres
  - 40–80 confetti quads in the shooter's team colour, 0.8–1.2 s life, 2–4 m/s² gravity, spin flutter
- Hitstop cannot pause time globally in multiplayer. Instead:
  - freeze only the victim's model and effects for 60–80 ms on the killer's screen
  - never freeze the camera or input
- A −2° FOV punch that recovers in 150 ms.
- Sound: "pop" + short kazoo or party horn + a pitched crowd "ooh".
- A puddle decal stays for 5 s (permanence).

*Water balloons and big splashes within 5 m*
- Trauma model, lasting 0.25 s or less.
- Caps: 1.5° pitch/yaw, 0.75° roll.
- Global slider from 0 to 100%. Head bob off by default. Default FOV 95°, adjustable 80–110.

## 6) UI style

**Korean fonts on Google Fonts** [verified]
- Every Korean family below is served as about 87–95 `unicode-range` slices. The first Jua slice is about 6.5 KB.
- Google's slicing sorts characters by frequency into about 100 slices and cut bytes downloaded by 38%. [src]
- Before drawing Hangul to canvas or WebGL (3D nameplates), call `document.fonts.load('40px Jua', '<exact string>')`.

| Font | Weights | Use [rec] |
|---|---|---|
| Bagel Fat One (has Hangul) | 400 | Logo "물총 대소동", big banners |
| Jua | 400 | HUD numbers, buttons, body text (rounded Gothic) |
| Do Hyeon | 400 | Compact labels, kill feed |
| Dongle | 300 / 400 / 700 | Cute captions. Small x-height, so set it about 1.3× larger |
| Gaegu | 300 / 400 / 700 | Handwritten flavour text, tips, chat |
| Sunflower | 300 / 500 / 700 | Settings and long text |
| Black Han Sans | 400 | Impact callouts only (not rounded) |
| Gamja Flower, Cute Font | 400 | Decoration only, poor legibility at small sizes |
| Latin pairing: Fredoka (300–700 variable), Baloo 2 (400–800), Lilita One, Titan One | as listed | English UI |

**Visual style** [rec]
- **Buttons**
  - Pill or rounded-rectangle shape, corner radius at least 40% of the height.
  - 3–4 px ink border and a 4–6 px darker bottom lip.
  - On press, move down 3 px over 80 ms and shrink the lip.
  - On hover, scale to 1.05 with easeOutBack.
  - Idle "breathing" on the main call-to-action at 2% or less, turned off by a reduce-motion setting (XAG 117).
- **HUD text**: white fill with a 3–4 px `#2B1D4A` stroke (`paint-order: stroke`), or dark text on bright fills.

**Copy: never "kill" or "die"** [rec]

| Moment | English | 한국어 |
|---|---|---|
| Splash-out | SPLASHED OUT! | 흠뻑 젖었다! |
| Killed by | Soaked by {name} | {name}에게 흠뻑! |
| Respawn countdown | Drying off… 3 | 몸 말리는 중… 3 |
| Streak | Triple Splash! | 트리플 스플래시! |
| Refill | Refill! | 충전 완료! |
| Low water | Running dry! | 물 부족! |

## 7) Map themes and small-map layout

**Themes** [rec]
1. **Backyard Pool Party (뒷마당 풀파티)**
   - A kidney-shaped pool in the middle as the contested refill point.
   - Treehouse as high ground.
   - Hedges as lane walls.
   - BBQ and patio furniture as low cover.
   - Sprinklers for area denial.
   - Floating inflatables (flamingo, donut) as moving soft cover.
   - Towel lines that block sight but let water through.
2. **Splash Park**
   - Tube slides as one-way fast travel from a 5 m tower to the ground in about 3 s.
   - A lazy river as a current lane (about 1.5 m/s).
   - Timed splash-pad geysers every 10 s.
   - A giant tipping bucket every 30 s as the landmark and map event.
3. **Beach Boardwalk**
   - Lifeguard tower as high ground with an exposed ladder.
   - Umbrellas as overhead cover.
   - Sandcastles as low cover.
   - Tide pools as refill points.

**Layout principles**
- **Loops, not dead ends** [src]
  - Good Counter-Strike maps overlay about 3 large loops with no absolute chokepoint (Dust2 vs Dust).
  - Too many paths creates "guess maps", where an enemy can appear from anywhere.
  - Halo's Blood Gulch uses curving hills to hide distant enemies, and high side paths for flanking.
  - Splatoon 4v4 stages are always symmetrical with a spawn per team.
- **Cover heights** [src]
  - High cover is 1.75 m or more; low cover 1.0–1.25 m. Anything at 0.5 m or below is not cover (Uncharted 4 metrics).
  - Prefer low cover so players keep awareness (Gears of War's Gridlock).
  - Scale these to our 1.5 m bean: low cover about 0.9–1.0 m, high cover 1.6 m or more. [rec]
- **Size and sightlines** [rec]
  - Playable area about 35×35 m for 4 players and about 50×50 m for 8.
  - Three lanes 10–15 m apart.
  - Water-gun effective range 8–15 m.
  - Most sightlines 10–20 m. The longest should not exceed about 2× the longest weapon range (about 30 m).
  - Break up anything longer with hills, inflatables or towels.
- **Verticality** [rec]
  - 2–3 tiers: ground, a deck at +1.5–2 m, a tower at +4–5 m.
  - Every high point has at least 2 ways up and is exposed from at least one angle.
- **Refill as risk and reward** [rec]: standing in pool water refills fast, like Splatoon's submerged healing at 100/s, but slows you and exposes you.
- **Spawns** [rec]
  - Team modes: symmetrical.
  - FFA: 8–12 spawn points, chosen by distance and line of sight to enemies.
- **Clarity** [src]
  - Floors darker than walls, plain walls, detail pushed to the edges.
  - Keep gameplay colours (team colours, refill aqua) out of the decoration.

---

## Art bible checklist

1. [ ] Bean or gumdrop body; head about 45% of height; eyes in the lower half of the face; mitten hands; nub feet; about 1.5 m tall, camera at about 1.35 m.
2. [ ] No sharp visible edges: Bevel (3–4 segments, 6–10% width) + Weighted Normal on every asset.
3. [ ] Props tapered 3–5° and bulged; no parallel lines on hero props (Fortnite rule).
4. [ ] Each gun reads uniquely as a 64 px black silhouette; water tank level is visible on the gun and on other players' backpacks.
5. [ ] Triangle budgets: character 3–6k, hat 800 or fewer, prop 200–2k, arena 150–300k.
6. [ ] Team pair Tangerine `#FF8A1F` / Grape `#7B5CFF`; blue never used as a team colour.
7. [ ] Environment desaturated and at least about 30% below the characters; pastel inflatables only; shadow tints warm or teal, never blue-violet.
8. [ ] Hue is never the only cue: team-dark outline + team rim + team icon on the nameplate; FFA uses colour + hat or symbol.
9. [ ] Enemy/ally colour override option; UI contrast of at least 4.5:1 for small text (dark ink on bright fills).
10. [ ] `MeshToonMaterial` with a 3-step ramp [0.62, 0.85, 1.0], `NearestFilter`; `NeutralToneMapping`.
11. [ ] Rim light via `onBeforeCompile`; inverted-hull outlines on characters, guns and pickups only.
12. [ ] One shadowed sun (2048 desktop / 1024 low); ambient occlusion baked to vertex colours; blob shadows under characters.
13. [ ] Selective bloom (threshold near 1, pmndrs `EffectPass`, half resolution on the low tier).
14. [ ] 250 draw calls or fewer; pixel ratio capped at 2 (1.5 on low); instanced particles and props; KTX2 textures at 2048 or less.
15. [ ] Customization: RGB mask with 3 colour slots, pattern atlas, 4×4 face atlas, socketed hats, gun colours and stickers; team colour overrides colours only.
16. [ ] Hit feedback: bloop with ±1.5-semitone jitter + pitch ladder; squash to 0.85 then a 9 Hz spring; wetness shader + overhead soak bar for 2.5 s.
17. [ ] Splash-out: 120 ms swell → pop (droplets + team-colour confetti) + 60–80 ms victim-only freeze + −2° FOV punch + puddle for 5 s.
18. [ ] Shake follows the trauma² model, lasts 0.25 s or less, caps at 1.5° (0.75° roll); none from normal streams; 0–100% slider; head bob off; FOV 80–110 (default 95).
19. [ ] Fonts: Bagel Fat One for titles, Jua for the HUD, Do Hyeon for labels, Gaegu for flavour text, Fredoka or Baloo 2 for Latin; `document.fonts.load` before canvas text.
20. [ ] UI: pill buttons, 3–4 px ink border, press-lip animation, easeOutBack; reduce-motion toggle.
21. [ ] Copy uses splash/soak/dry vocabulary only; no violent words.
22. [ ] Maps: 3 lanes / 3 loops, no dead ends; 35–50 m square; sightlines 30 m or less; low cover about 0.9–1.0 m, high 1.6 m or more; 2–3 tiers with at least 2 routes up; pool refill as risk and reward; floors darker than walls.

---

## Sources
- [Escapist: Fall Guys design secrets](https://www.escapistmagazine.com/the-secrets-of-how-fall-guys-creates-adorable-designs-incredible-brand-collaborations/) (via search snippet)
- [ESPN: Fall Guys costumes](https://www.espn.com/gaming/story/_/id/29734365/meet-minds-fall-guys-costumes)
- [EssentiallySports: Fall Guys anatomy](https://www.essentiallysports.com/fall-guys-concept-artist-shares-the-adorable-anatomy-of-the-characters-mediatonic-esports-news/)
- [Fall Guys Faceplates wiki](https://fallguysultimateknockout.fandom.com/wiki/Faceplates)
- [Game Developer: Overwatch art direction](https://www.gamedeveloper.com/art/video-defining-and-evolving-the-art-direction-of-i-overwatch-i-)
- [Cook & Becker: Designing Overwatch](https://www.cookandbecker.com/en/article/378/designing-overwatch.html)
- [Level Design Book: environment art](https://book.leveldesignbook.com/process/env-art)
- [Level Design Book: cover](https://book.leveldesignbook.com/process/combat/cover)
- [Level Design Book: metrics](https://book.leveldesignbook.com/process/blockout/metrics)
- [Fortnite GDC talk review (John Greer)](https://johngreerhonoursprojectblog.wordpress.com/2018/10/05/developing-the-art-of-fortnite-gdc-talk-review/amp/)
- [RetroStyle Games: Brawl Stars art style](https://retrostylegames.com/blog/game-art-design-like-brawl-stars/)
- [Goomba Stomp: Party Animals interview](https://goombastomp.com/party-animals-interview/)
- [Party Animals (Wikipedia)](https://en.wikipedia.org/wiki/Party_Animals_(video_game))
- [Animal Crossing: New Horizons (Wikipedia)](https://en.wikipedia.org/wiki/Animal_Crossing:_New_Horizons)
- [Royal Society: Lorenz's baby schema](https://royalsocietypublishing.org/doi/10.1098/rspb.2024.0570)
- [Inkipedia: Ink](https://splatoonwiki.org/wiki/Ink)
- [Inkipedia: Options (Color Lock)](https://splatoonwiki.org/wiki/Options)
- [Automaton: Splatoon 3 blue ink visibility](https://automaton-media.com/en/news/20221112-16667/)
- [Squidboards: Splatoon regen mechanics](https://squidboards.com/threads/health-regeneration-enemy-ink-damage-mechanics.2688/)
- [Nintendo Life: Splatoon 3 health bars](https://www.nintendolife.com/news/2026/01/surprise-splatoon-3s-first-update-of-2026-has-added-health-bars)
- [Followchain: Overwatch 2 enemy colour](https://www.followchain.org/enemy-color-overwatch-2/)
- [Kotaku: Overwatch hit sound](https://kotaku.com/the-sound-of-a-hit-in-overwatch-is-made-by-beer-1778482754)
- [Gamer Journalist: Fortnite damage colours](https://gamerjournalist.com/how-to-tell-how-much-damage-you-have-done-in-fortnite-chapter-4-season-1/)
- [three.js MeshToonMaterial docs](https://threejs.org/docs/pages/MeshToonMaterial.html)
- [Maya Ndljk: three.js toon shader](https://www.maya-ndljk.com/blog/threejs-basic-toon-shader)
- [three.js OutlineEffect docs](https://threejs.org/docs/pages/OutlineEffect.html)
- [three.js ToonOutlinePassNode docs](https://threejs.org/docs/pages/ToonOutlinePassNode.html)
- [three.js forum: OutlinePass performance](https://discourse.threejs.org/t/performance-issues-with-three-outlinepass/7363)
- [pmndrs postprocessing](https://github.com/pmndrs/postprocessing)
- [pmndrs BloomEffect docs](https://pmndrs.github.io/postprocessing/public/docs/class/src/effects/BloomEffect.js~BloomEffect.html)
- [Khronos PBR Neutral tone mapper](https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/README.md)
- [Utsubo: 100 three.js tips](https://www.utsubo.com/blog/threejs-best-practices-100-tips)
- [Xbox Accessibility Guideline 117](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/117)
- [StraySpark: camera shake without motion sickness](https://www.strayspark.studio/blog/camera-shake-game-feel-without-motion-sickness)
- [Playtank: first-person camera](https://playtank.io/2023/05/12/first-person-3cs-camera/)
- [Art of Screenshake notes](https://theengineeringofconsciousexperience.com/jan-willem-nijman-vlambeer-the-art-of-screenshake/)
- [Juice it or Lose it (YouTube)](https://www.youtube.com/watch?v=Fy0aCDmgnxg)
- [Eiserloh: Juicing Your Cameras With Math (YouTube)](https://www.youtube.com/watch?v=tu-Qe66AvtY)
- [Game Developer: The Power of Pitch Shifting](https://www.gamedeveloper.com/audio/the-power-of-pitch-shifting)
- [Critpoints: Good FPS map design](https://critpoints.net/2018/02/18/good-fps-map-design/)
- [Jank.cool: most-loved multiplayer FPS levels](https://www.jank.cool/heres-our-17-most-loved-multiplayer-fps-levels/)
- [Google Developers Blog: Google Fonts Korean support](https://developers.googleblog.com/google-fonts-launches-korean-support/)
- [Fontsource: Korean fonts](https://fontsource.org/languages/korean)

The colour-check scripts are in `D:\Users\jeiel\Temp\claude\D--Project-fps\41c402a9-3a67-405c-9a6f-aa5d5b780b8f\scratchpad\` (`palette_check.py`, `p2.py`, `p3.py`).