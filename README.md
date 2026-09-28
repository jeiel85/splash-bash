# Splash Bash! 물총 대소동 💦

말랑한 콩 캐릭터들이 뒷마당 수영장 파티에서 벌이는 **귀여운 3D 물총 싸움 FPS**.
설치 없이 브라우저에서 링크 하나로 바로 친구와 온라인 대전할 수 있고, **게임 서버가 없습니다**(브라우저끼리 P2P 로 직접 연결).

- 🎮 플레이: GitHub Pages 배포 주소(저장소 About 참고)
- 📐 설계: [docs/GAME_DESIGN.md](docs/GAME_DESIGN.md) · 구조: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · 에셋 규약: [docs/ASSETS.md](docs/ASSETS.md)
- 🔎 참고 게임 리서치: [docs/research/](docs/research/) (Krunker, Shell Shockers, 스플래툰, Fall Guys 등)

## 게임 방법

| 조작 | 키 |
|---|---|
| 이동 / 점프 / 슬라이드 | WASD / 스페이스 / Shift |
| 발사 / 물풍선 | 마우스 왼쪽 / G (또는 마우스 오른쪽) |
| 무기 선택 | 1 퐁퐁 권총 · 2 콸콸 펌프 · 3 양동이 블래스터 (휠) |
| 점수판 / 메뉴 | Tab / Esc |

- 물을 맞으면 **젖음**이 오르고 100% 가 되면 "흠뻑 젖었다!" → 3초 뒤 부활. 한동안 안 맞으면 마릅니다.
- 물총에는 **물탱크**가 있어요. 분수(초당 30)나 가운데 수영장(초당 60, 대신 느려짐)에서 채우세요.
- 개인전: 15명 먼저 적시면 승리 / 팀전: 30점 먼저. 한 경기 4분.
- 메뉴의 **🎲 랜덤** 버튼을 누르면 캐릭터 색깔·모자를 무작위로 바꿔 줘요(지금과 같은 조합은 나오지 않아요).

### 같이 하기

- **빠른 대전** — 공개 방에 바로 들어갑니다. 사람이 적으면 봇이 채워 줘요.
- **방 만들기** — 방 코드가 생기고, Esc 메뉴의 "초대 링크 복사"로 친구를 부르세요(`…/#room=코드`).
- **연습 모드** — 인터넷 없이 봇과 대전.

## 서버리스 온라인 구조

[Trystero](https://github.com/dmotz/trystero) 가 공개 Nostr 릴레이로 WebRTC 연결 정보를 주고받아(시그널링) 브라우저끼리 직접 연결합니다. 게임 데이터는 릴레이를 거치지 않고 P2P 로만 오갑니다.
가장 먼저 들어온 사람이 **호스트**가 되어 경기 시간·점수·봇을 맡고, 호스트가 나가면 다음 사람이 이어받습니다. 자세한 권한 모델은 [ARCHITECTURE.md](docs/ARCHITECTURE.md).

**알려진 한계**
- 일부 회사·학교망이나 대칭형 NAT 끼리는 STUN 만으로 연결이 안 될 수 있습니다. TURN 서버가 있으면 빌드 시 `VITE_TURN_URLS`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` 로 지정하세요.
- 서버가 없으므로 치트를 완전히 막을 수는 없습니다(형식·범위·권한 검증만 수행). 친구끼리 즐기는 캐주얼 게임을 전제로 합니다.
- **같은 방 사람끼리 IP 주소가 보입니다.** 브라우저끼리 WebRTC 로 직접 연결하므로, 공개 방인 빠른 대전에서는 모르는 사람에게도 내 공인 IP 가 전달됩니다. 원하지 않으면 **방 만들기**(코드 초대)로 아는 친구끼리 하세요. 메뉴의 빠른 대전 아래에도 같은 안내가 있습니다.
- **방문자 수**(메뉴 아래 "👀 방문")는 무료 공개 카운터 [Abacus](https://v2.jasoncameron.dev/abacus) 에 탭당 한 번 요청해 셉니다. 그래서 배포 사이트를 열면 그 서비스에 내 IP 주소가 전달되고(쿠키·리퍼러는 보내지 않음), 서비스가 멈추거나 광고 차단기가 막으면 칸이 보이지 않을 뿐 게임은 그대로입니다. 개발 서버·로컬 주소에서는 세지 않습니다.
- 키보드·마우스 전용(모바일 미지원). 휴대폰·태블릿이나 포인터 잠금(Pointer Lock)이 없는 브라우저로 열면 메뉴에 안내가 뜨고 온라인 방에는 들어가지 않습니다. 시작 안내("클릭해서 시작!")에서 마우스 잠금을 못 얻으면 이유와 "메뉴로 나가기"가 보입니다.

## 개발

```bash
npm install
npm run dev          # http://127.0.0.1:5317  (?map=test 시험장, ?bots=0 봇 끄기)
npm test             # 단위·규약·맵 검증 테스트
npm run test:e2e     # 실제 P2P 다중 브라우저 테스트(자체 서버를 띄움, 인터넷 필요)
npm run build        # 타입 검사 + 정적 빌드(dist/)
node tools/licenses.mjs          # 제3자 라이선스 고지(public/third-party-licenses.txt) 다시 만들기 — 런타임 의존성을 바꾸면 실행 후 커밋
node tools/licenses.mjs --check  # 고지가 지금 빌드와 같은지만 확인(릴리스 전)
```

`npm run test:e2e`, `tools/screenshot.mjs`, `tools/ingame-shot.mjs`, `tools/check-relays.mjs` 는 Playwright 의 Chromium 을 씁니다. 처음 한 번 브라우저를 설치하세요.

```bash
npx playwright install chromium
```

### 에셋

모든 3D 모델(캐릭터·모자·물총·맵)은 **Blender 4.5 Python 스크립트로 직접 생성**합니다(`tools/blender/`).
효과음·배경음은 WebAudio 로 실시간 합성해 외부 음원 파일이 없습니다.

```bash
npm run assets                     # 전체 GLB 재생성 (환경변수 BLENDER 로 blender.exe 경로 지정 가능)
node tools/screenshot.mjs "/dev/viewer.html?file=character.glb" out.png   # 에셋 툰 셰이딩 미리보기
```

## 크레딧

- 폰트: [Jua](https://fonts.google.com/specimen/Jua) (SIL Open Font License, @fontsource/jua)
- 라이브러리: three.js, three-mesh-bvh, Trystero(@trystero-p2p, @noble/secp256k1 포함), Vite
- 배포 빌드에 들어가는 오픈소스의 저작권·라이선스 전문은 [public/third-party-licenses.txt](public/third-party-licenses.txt) 에 있고, 게임 메뉴 아래의 **크레딧·라이선스** 링크로도 볼 수 있습니다(`tools/licenses.mjs` 가 빌드 결과에서 생성).
