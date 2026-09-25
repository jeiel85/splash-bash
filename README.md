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
| 무기 선택 | 1 퐁퐁 권총 · 2 슈퍼 소커 · 3 양동이 블래스터 (휠) |
| 점수판 / 메뉴 | Tab / Esc |

- 물을 맞으면 **젖음**이 오르고 100% 가 되면 "흠뻑 젖었다!" → 3초 뒤 부활. 한동안 안 맞으면 마릅니다.
- 물총에는 **물탱크**가 있어요. 분수(초당 30)나 가운데 수영장(초당 60, 대신 느려짐)에서 채우세요.
- 개인전: 15명 먼저 적시면 승리 / 팀전: 30점 먼저. 한 경기 4분.

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
- 키보드·마우스 전용(모바일 미지원).

## 개발

```bash
npm install
npm run dev          # http://127.0.0.1:5317  (?map=test 시험장, ?bots=0 봇 끄기)
npm test             # 단위·규약·맵 검증 테스트
npm run test:e2e     # 실제 P2P 다중 브라우저 테스트(개발 서버 필요, 인터넷 필요)
npm run build        # 타입 검사 + 정적 빌드(dist/)
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
- 라이브러리: three.js, three-mesh-bvh, Trystero, Vite
