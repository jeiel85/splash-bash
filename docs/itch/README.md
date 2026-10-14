# itch.io 등록 안내

## 업로드 파일 만들기

```bash
npm run build
npm run pack:itch
```

`release/splash-bash-itch.zip`이 생깁니다. 압축 루트에 `index.html`이 있고 내용은 `dist/`와 같습니다(`release/`는 git 에 올리지 않습니다). Vite `base: './'` 라 itch 의 하위 경로에서도 에셋을 찾습니다.

## 프로젝트 설정 (Create new project)

| 항목 | 값 |
|---|---|
| Title | Splash Bash! |
| Kind of project | **HTML** |
| Uploads | `splash-bash-itch.zip` 업로드 후 **This file will be played in the browser** 체크 |
| Embed options → Viewport dimensions | 1280 × 720 |
| Embed options | **Fullscreen button** 체크, **Mobile friendly** 끔(키보드·마우스 전용), **Automatically start on page load** 끔(클릭해야 소리가 나고 마우스 잠금을 얻으므로) |
| Classification | Games · Shooter |
| Tags | `fps`, `shooter`, `multiplayer`, `cute`, `3d`, `casual`, `first-person`, `webgl`, `threejs`, `p2p` |
| Release status | Released (또는 In development) |
| Pricing | No payments (원하면 Donate) |
| Cover image | [`cover.jpg`](cover.jpg) (630×500, 메인 메뉴 실제 화면에서 메뉴 카드만 가리고 찍음) |
| Screenshots | 메뉴·게임 화면을 `tools/ingame-shot.mjs`로 찍어 올리기(1280×720) |

## 게임 동작 메모

- itch.io 는 게임을 다른 도메인(itch.zone)의 iframe 안에서 실행합니다. 그 주소는 남이 열 수 없고 `#room=` 해시도 iframe 에 넘겨 주지 않아서, itch 에서 복사한 **초대 링크는 웹 버전(GitHub Pages, https://jeiel85.github.io/splash-bash/) 주소**로 만들어집니다. 두 빌드는 같은 Trystero appId·릴레이를 써서 같은 방에 들어갑니다(itch 에서 방을 만들고 웹 버전 친구를 부르거나, 그 반대도 됨).
- iframe 안에서는 클립보드 접근이 막힐 수 있습니다. 그러면 예전 복사 방식으로 한 번 더 시도하고, 그것도 안 되면 초대 카드에 링크 칸이 나타나 직접 복사할 수 있습니다.
- 마우스 잠금(Pointer Lock)을 iframe 이 허락하지 않으면 "클릭해서 시작!" 카드에 다시 누르거나 itch 의 **전체 화면 버튼**을 눌러 보라는 안내와 "메뉴로 나가기"가 보입니다.
- 닉네임·꾸미기·설정·언어 선택은 itch.zone 쪽 브라우저 저장소에 따로 저장되므로 웹 버전과 공유되지 않습니다. 저장소가 막힌 환경에서도 기본값으로 실행되고, 언어 버튼은 주소의 `?lang=`으로 선택을 넘깁니다.
- 언어는 브라우저 언어를 따라 한국어 또는 영어로 시작하고(그 밖의 언어는 영어), 메인 메뉴 오른쪽 위 **English / 한국어** 버튼으로 바꿀 수 있습니다. 봇 이름은 방장 화면 언어를 따릅니다.
- 메뉴 아래 방문자 수 카운터는 itch 에서도 같은 공개 카운터(Abacus)에 요청합니다(웹 버전과 숫자를 합산, 쿠키·리퍼러는 보내지 않음).

## 페이지 소개문 (그대로 붙여 넣기)

```
SPLASH BASH! is a cute first-person water-gun battle in your browser.

Squishy bean characters soak each other at a backyard pool party. Jump in with friends from a single link — no install, no sign-up, and no game server: browsers connect to each other directly.

FEATURES
• Three water guns: the Pop Pistol, the full-auto Gush Pump and the spread-shot Bucket Blaster, plus water balloons
• Get hit and your soak meter fills up; at 100% you are soaked and dry off for 3 seconds before you're back. Dry off over time when nobody hits you
• Your water tank runs dry — refill at the fountains, or dive into the pool in the middle (faster refill, slower moving)
• Free-for-all (first to 15 splashes) or Teams (first to 30), 4-minute matches
• A backyard pool-party map with patios, cabanas, a treehouse lookout, ramps and jump pads
• Quick Match drops you into a public room; bots fill empty spots so you can always play
• Create a private room and invite friends with a link (up to 8 players), or practice offline against bots
• Customize your bean with 8 colors and 6 hats
• English and Korean UI

CONTROLS (keyboard and mouse)
Move  WASD      Jump  Space      Slide  Shift
Shoot  Left click      Water balloon  G or right click
Weapons  1 2 3 or mouse wheel      Scoreboard  Tab      Menu  Esc

ONLINE
Online play uses WebRTC: players find each other through public Nostr relays and then connect browser to browser, so people in the same room can see your IP address. To play only with friends, create a room and share the invite link. Some strict networks (office, school or symmetric NAT) can block direct connections. Phones and tablets are not supported.

Source code: https://github.com/jeiel85/splash-bash
```
