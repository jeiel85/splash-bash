/**
 * 화면 문구(한국어·영어). 언어는 ?lang= → 저장된 선택 → 브라우저 언어 목록 순으로 고른다
 * (목록에서 ko 가 en 보다 먼저 나오면 한국어, 그 밖에는 영어). 바꾸면 페이지를 다시 불러 모든 문구가 따라온다.
 * 코드에서는 t(key, vars) 로 꺼내 쓰고, {name} 자리표시자를 vars 로 채운다.
 */
export const LANGS = ['ko', 'en'] as const;
export type Lang = (typeof LANGS)[number];

const ko = {
  'doc.title': 'Splash Bash! 물총 대소동',
  'doc.description': '귀여운 물총 싸움 브라우저 FPS — 설치 없이 링크 하나로 친구와 바로 온라인 대전!',
  'boot': '물총에 물 채우는 중…',
  'boot.progress': '물총에 물 채우는 중… {done}/{total}',
  'boot.drop': '물총에 물 채우는 중… 💧',
  'boot.failed': '게임 데이터를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.',
  'reload': '새로고침',
  'fatal.webgl': '3D 그래픽을 켤 수 없어요 😢',
  'fatal.webglDetail': '브라우저 설정에서 하드웨어 가속(WebGL)을 켜거나, 최신 Chrome·Edge·Firefox·Safari 로 열어 주세요.',
  'device.block': '🖱️ 키보드·마우스가 있는 PC에서 하는 게임이에요. 이 기기에서는 온라인 방에 들어갈 수 없어요 — 초대 링크는 PC 브라우저로 열어 주세요.',

  'online.noWebrtc': '이 브라우저는 온라인 대전(WebRTC)을 지원하지 않아요. 연습 모드로 놀아 주세요!',
  'online.offline': '인터넷에 연결되어 있지 않아요. 연결을 확인하거나 연습 모드로 놀아 주세요.',
  'online.insecure': '온라인 대전은 보안 연결(https) 주소에서만 할 수 있어요.',
  'online.lost': '인터넷 연결이 끊긴 것 같아요. 연결을 확인하고 다시 시도해 주세요. (연습 모드는 바로 할 수 있어요)',
  'online.failed': '연결에 실패했어요. 잠시 후 다시 시도해 주세요. (연습 모드는 바로 할 수 있어요)',
  'online.cancelled': '연결을 취소했어요.',
  'online.unstable': '온라인 연결이 불안정해요 — 친구가 못 들어올 수도 있어요',
  'net.joinError': '방 참가 오류: {err}',

  'connect.quick': '물총 친구 찾는 중…',
  'connect.quickFirst': '아무도 없으면 봇들과 먼저 시작해요',
  'connect.quickNext': '{n}번 방이 가득 차서 다음 방을 보고 있어요',
  'connect.quickFull': '빠른 대전 방이 모두 가득 찼어요 😢 잠시 후 다시 시도하거나 방을 만들어 보세요.',
  'connect.creating': '방 만드는 중… (코드 {code})',
  'connect.joining': '방에 들어가는 중… (코드 {code})',
  'connect.createSub': '만들고 나면 초대 링크를 복사할 수 있어요',
  'connect.joinSub': '친구들을 찾고 있어요',
  'connect.roomFull': '방이 가득 찼어요 (코드 {code}, 최대 {max}명). 다른 방을 만들어 보세요.',
  'connect.roomFullLater': '방이 가득 찼어요 (최대 {max}명). 다른 방을 만들어 보세요.',
  'connect.controls': '조작법',
  'connect.cancel': '취소 (Esc)',

  'room.practice': '연습 모드',
  'room.quick': '빠른 대전 #{n}',
  'room.code': '방 {code}',
  'room.players': '{label} · {n}명',

  'toast.created': '방을 만들었어요! 코드 {code} · Esc → 초대 링크 복사 💌',
  'toast.alone': '아직 아무도 없어요. 친구에게 방 코드를 알려 주세요!',
  'toast.quickAlone': '지금은 봇들과 먼저 놀아요. 누가 들어오면 알려 줄게요!',
  'toast.joined': '{name} 님이 들어왔어요 💦',
  'toast.left': '{name} 님이 나갔어요',
  'toast.host': '방장이 되었어요 👑',
  'toast.silent': '{name} 님 연결이 끊겼어요',
  'toast.back': '{name} 님이 다시 연결됐어요',

  'match.new': '새 경기 시작!',
  'match.newTdm': '팀을 도와 적을 흠뻑 적셔요',
  'match.newFfa': '모두를 흠뻑 적셔요',
  'match.over': '경기 종료!',
  'match.teamWin': '{team} 승리! 🎉',
  'match.draw': '무승부!',
  'match.winner': '{name} 우승! 🏆',
  'match.puddle': '물웅덩이',

  'weapon.pistol': '퐁퐁 권총',
  'weapon.soaker': '콸콸 펌프',
  'weapon.bucket': '양동이 블래스터',
  'weapon.balloon': '물풍선',
  'team.0': '탠저린 팀',
  'team.1': '그레이프 팀',
  'team.none': '팀 없음',

  'hud.soak': '젖음',
  'hud.tank': '물탱크',
  'hud.roomCode': '방 코드',
  'hud.inviteHint': 'Esc → 초대 링크 복사',
  'hud.lowWater': '물 부족! 분수나 수영장에서 채워요 💧',
  'hud.shielded': '비눗방울 보호 중 · 쏘면 풀려요',
  'hud.tankFull': '충전 완료!',
  'hud.tankLow': '물 부족!',
  'hud.goal': '목표 {n}',
  'hud.me': '나',
  'hud.leader': '1등',
  'hud.soakedTitle': '흠뻑 젖었다!',
  'hud.soakedBy': '{name}에게 흠뻑!',
  'hud.soakedSelf': '물에 풍덩!',
  'hud.drying': '몸 말리는 중… {s}',
  'hud.ping': '핑 {ms}ms',
  'hud.splashed': '{name} 흠뻑!',
  'hud.scoreboard': '점수판',
  'hud.nextMatch': '{s}초 후 다음 경기',
  'hud.soon': '곧 시작!',
  'hud.podiumScore': '적신 수 {n}',
  'hud.inviteLine': '친구 부르기 · 방 코드',
  'hud.host': '👑 방장',
  'hud.bot': '봇',
  'col.name': '이름',
  'col.splashes': '적신 수',
  'col.soaked': '젖은 수',
  'col.ping': '핑',
  'streak.3': '3연속 스플래시!',
  'streak.3sub': '물총 솜씨가 반짝반짝',
  'streak.5': '5연속! 멈출 수 없어!',
  'streak.5sub': '뒷마당이 물바다가 되어 가요',
  'streak.8': '8연속! 전설의 물총왕!',
  'streak.8sub': '아무도 못 말려요',
  'multi.2': '더블 스플래시!',
  'multi.3': '트리플 스플래시!',
  'multi.4': '멀티 스플래시!',

  'menu.sub': '물총 대소동',
  'menu.custom': '내 캐릭터 꾸미기',
  'menu.dice': '🎲 랜덤',
  'menu.diceTitle': '색깔·모자를 무작위로 바꿔요',
  'menu.name': '닉네임',
  'menu.color': '색깔',
  'menu.colorN': '색 {n}',
  'menu.hat': '모자',
  'menu.invited': '💌 초대받은 방',
  'menu.join': '참가',
  'menu.quick': '빠른 대전',
  'menu.quickSub': '바로 시작 · 사람이 적으면 봇이 채워요',
  'menu.create': '방 만들기',
  'menu.joinCode': '코드로 참가',
  'menu.ipNote': '🔒 온라인은 브라우저끼리 직접 연결돼서 같은 방 사람에게 내 IP 주소가 보여요. 모르는 사람이 싫으면 방 만들기로 친구끼리!',
  'menu.codePlaceholder': '방 코드',
  'menu.enter': '입장',
  'menu.practice': '🤖 연습 모드 (봇과 대전)',
  'menu.rules': '방 만들기·연습 규칙',
  'mode.ffa': '개인전',
  'mode.tdm': '팀전',
  'menu.credits': '크레딧·라이선스',
  'menu.settings': '⚙ 설정',
  'menu.settingsLabel': '설정',
  'menu.close': '닫기',
  'menu.visits': '👀 방문 {n}',
  'menu.visitsTitle': '이 사이트를 찾아온 방문 수(탭당 한 번 세요)',
  'menu.lang': 'English',
  'menu.langTitle': 'Switch to English',

  'color.0': '탠저린', 'color.1': '포도', 'color.2': '딸기', 'color.3': '민트',
  'color.4': '레몬', 'color.5': '하늘', 'color.6': '라임', 'color.7': '복숭아',
  'hat.none': '맨머리', 'hat.cap': '🧢 모자', 'hat.duck': '🦆 오리', 'hat.flower': '🌼 꽃',
  'hat.crown': '👑 왕관', 'hat.frog': '🐸 개구리', 'hat.bucket': '👒 벙거지',

  'ctl.move': '이동', 'ctl.jump': '점프', 'ctl.slide': '슬라이드', 'ctl.clickKey': '클릭', 'ctl.fire': '발사',
  'ctl.weapons': '무기', 'ctl.balloon': '물풍선', 'ctl.scoreboard': '점수판', 'ctl.menu': '메뉴',

  'set.sound': '소리',
  'set.volume': '전체 음량',
  'set.music': '음악',
  'set.sfx': '효과음',
  'set.controls': '조작',
  'set.sensitivity': '마우스 감도',
  'set.invertY': '마우스 상하 반전',
  'set.screen': '화면',
  'set.fov': '시야각',
  'set.quality': '그래픽 품질',
  'set.qualityHigh': '높음',
  'set.qualityLow': '낮음(빠름)',
  'set.reduceMotion': '움직임 줄이기',
  'set.reduceMotionNote': '흔들림·통통 튀는 효과를 줄여요',

  'invite.cap': '친구 초대 · 방 코드',
  'invite.copy': '🔗 초대 링크 복사',
  'invite.link': '초대 링크',
  'invite.copied': '복사했어요! ✓',
  'invite.copiedWeb': '웹 버전 링크를 복사했어요! ✓',
  'invite.manual': '링크를 직접 복사해 주세요',

  'pause.label': '일시정지',
  'pause.title': '잠깐 쉬는 중',
  'pause.online': '온라인 경기는 멈추지 않아요 — 쉬는 동안에도 젖을 수 있어요!',
  'pause.resume': '계속하기',
  'pause.leave': '🚪 방 나가기',
  'prompt.start': '클릭해서 시작! 💦',
  'prompt.leave': '🚪 메뉴로 나가기',
  'lock.unsupported': '이 기기·브라우저에서는 마우스로 조준할 수 없어요. 키보드·마우스가 있는 PC 브라우저로 열어 주세요.',
  'lock.failed': '마우스 잠금을 못 했어요 😢 다시 눌러 보고, 그래도 안 되면 메뉴로 나가 주세요.',
  'lock.embedded': '마우스 잠금을 못 했어요 😢 다시 눌러 보거나 이 페이지의 전체 화면 버튼을 눌러 보세요. 그래도 안 되면 메뉴로 나가 주세요.',

  'code.empty': '방 코드를 입력해 주세요',
  'code.confusing': '헷갈리는 글자(0, 1, O, I)는 방 코드에 없어요. 코드를 다시 확인해 주세요',
  'code.length': '방 코드를 확인해 주세요 (영문·숫자 {min}~{max}자)',
  'name.default': '물총러',
  'name.adj': '촉촉한,말랑한,통통한,반짝이는,졸린,용감한,수줍은,신나는',
  'name.noun': '오리,물개,해파리,올챙이,수달,펭귄,개구리,고래',
  'bot.names': '보글보글,찰랑이,퐁당이,물방울,첨벙이,촉촉이,뽀송이,출렁이,방울방울,졸졸이',
};

type Key = keyof typeof ko;

const en: Record<Key, string> = {
  'doc.title': 'Splash Bash! Water Gun Party',
  'doc.description': 'A cute water-gun FPS in your browser. No install: share a link and play online with friends right away!',
  'boot': 'Filling up the water guns…',
  'boot.progress': 'Filling up the water guns… {done}/{total}',
  'boot.drop': 'Filling up the water guns… 💧',
  'boot.failed': 'Could not load the game data. Check your internet connection and reload.',
  'reload': 'Reload',
  'fatal.webgl': 'Cannot start 3D graphics 😢',
  'fatal.webglDetail': 'Turn on hardware acceleration (WebGL) in your browser settings, or open the game in a recent Chrome, Edge, Firefox or Safari.',
  'device.block': '🖱️ This game is played on a computer with a keyboard and mouse. You cannot join online rooms on this device — open the invite link in a desktop browser.',

  'online.noWebrtc': 'This browser does not support online matches (WebRTC). Try Practice mode instead!',
  'online.offline': 'You are not connected to the internet. Check your connection, or play Practice mode.',
  'online.insecure': 'Online matches only work on a secure (https) address.',
  'online.lost': 'Your internet connection seems to be down. Check it and try again. (Practice mode works right away.)',
  'online.failed': 'Could not connect. Please try again in a moment. (Practice mode works right away.)',
  'online.cancelled': 'Connection cancelled.',
  'online.unstable': 'The online connection is shaky — friends may not be able to join',
  'net.joinError': 'Error joining the room: {err}',

  'connect.quick': 'Looking for water-gun buddies…',
  'connect.quickFirst': 'If nobody is around, you start with bots',
  'connect.quickNext': 'Room {n} is full, checking the next one',
  'connect.quickFull': 'All Quick Match rooms are full 😢 Try again in a bit, or create a room.',
  'connect.creating': 'Creating a room… (code {code})',
  'connect.joining': 'Joining the room… (code {code})',
  'connect.createSub': 'Once it is ready you can copy the invite link',
  'connect.joinSub': 'Looking for your friends',
  'connect.roomFull': 'That room is full (code {code}, max {max} players). Try creating another room.',
  'connect.roomFullLater': 'The room is full (max {max} players). Try creating another room.',
  'connect.controls': 'Controls',
  'connect.cancel': 'Cancel (Esc)',

  'room.practice': 'Practice',
  'room.quick': 'Quick Match #{n}',
  'room.code': 'Room {code}',
  'room.players': '{label} · {n} players',

  'toast.created': 'Room created! Code {code} · Esc → copy invite link 💌',
  'toast.alone': 'Nobody here yet. Send your friends the room code!',
  'toast.quickAlone': 'Playing with bots for now. We will tell you when someone joins!',
  'toast.joined': '{name} joined 💦',
  'toast.left': '{name} left',
  'toast.host': 'You are now the host 👑',
  'toast.silent': '{name} lost connection',
  'toast.back': '{name} reconnected',

  'match.new': 'New match!',
  'match.newTdm': 'Help your team soak the other side',
  'match.newFfa': 'Soak everyone',
  'match.over': 'Match over!',
  'match.teamWin': '{team} wins! 🎉',
  'match.draw': 'Draw!',
  'match.winner': '{name} wins! 🏆',
  'match.puddle': 'Puddle',

  'weapon.pistol': 'Pop Pistol',
  'weapon.soaker': 'Gush Pump',
  'weapon.bucket': 'Bucket Blaster',
  'weapon.balloon': 'Water Balloon',
  'team.0': 'Team Tangerine',
  'team.1': 'Team Grape',
  'team.none': 'No team',

  'hud.soak': 'Soak',
  'hud.tank': 'Tank',
  'hud.roomCode': 'Room code',
  'hud.inviteHint': 'Esc → copy invite link',
  'hud.lowWater': 'Low on water! Refill at a fountain or the pool 💧',
  'hud.shielded': 'Bubble shield on · shooting pops it',
  'hud.tankFull': 'Full!',
  'hud.tankLow': 'Low water!',
  'hud.goal': 'Goal {n}',
  'hud.me': 'Me',
  'hud.leader': '1st',
  'hud.soakedTitle': 'Soaked!',
  'hud.soakedBy': 'Soaked by {name}!',
  'hud.soakedSelf': 'Splashdown!',
  'hud.drying': 'Drying off… {s}',
  'hud.ping': 'Ping {ms}ms',
  'hud.splashed': '{name} soaked!',
  'hud.scoreboard': 'Scoreboard',
  'hud.nextMatch': 'Next match in {s}s',
  'hud.soon': 'Starting soon!',
  'hud.podiumScore': 'Splashes {n}',
  'hud.inviteLine': 'Invite friends · room code',
  'hud.host': '👑 Host',
  'hud.bot': 'Bot',
  'col.name': 'Name',
  'col.splashes': 'Splashes',
  'col.soaked': 'Soaked',
  'col.ping': 'Ping',
  'streak.3': '3 in a row!',
  'streak.3sub': 'Sparkling aim',
  'streak.5': '5 in a row! Unstoppable!',
  'streak.5sub': 'The backyard is turning into a lake',
  'streak.8': '8 in a row! Legendary soaker!',
  'streak.8sub': 'Nobody can stop you',
  'multi.2': 'Double Splash!',
  'multi.3': 'Triple Splash!',
  'multi.4': 'Multi Splash!',

  'menu.sub': 'Water Gun Party',
  'menu.custom': 'Customize your character',
  'menu.dice': '🎲 Random',
  'menu.diceTitle': 'Pick a random color and hat',
  'menu.name': 'Nickname',
  'menu.color': 'Color',
  'menu.colorN': 'Color {n}',
  'menu.hat': 'Hat',
  'menu.invited': '💌 You are invited',
  'menu.join': 'Join',
  'menu.quick': 'Quick Match',
  'menu.quickSub': 'Jump right in · bots fill empty spots',
  'menu.create': 'Create room',
  'menu.joinCode': 'Join with code',
  'menu.ipNote': '🔒 Online play connects browsers directly, so people in the same room can see your IP address. Prefer not to meet strangers? Create a room and play with friends!',
  'menu.codePlaceholder': 'Room code',
  'menu.enter': 'Enter',
  'menu.practice': '🤖 Practice (vs. bots)',
  'menu.rules': 'Rules for new rooms & practice',
  'mode.ffa': 'Free-for-all',
  'mode.tdm': 'Teams',
  'menu.credits': 'Credits & licenses',
  'menu.settings': '⚙ Settings',
  'menu.settingsLabel': 'Settings',
  'menu.close': 'Close',
  'menu.visits': '👀 {n} visits',
  'menu.visitsTitle': 'Visits to this site (counted once per tab)',
  'menu.lang': '한국어',
  'menu.langTitle': '한국어로 바꾸기',

  'color.0': 'Tangerine', 'color.1': 'Grape', 'color.2': 'Strawberry', 'color.3': 'Mint',
  'color.4': 'Lemon', 'color.5': 'Sky', 'color.6': 'Lime', 'color.7': 'Peach',
  'hat.none': 'No hat', 'hat.cap': '🧢 Cap', 'hat.duck': '🦆 Duck', 'hat.flower': '🌼 Flower',
  'hat.crown': '👑 Crown', 'hat.frog': '🐸 Frog', 'hat.bucket': '👒 Bucket hat',

  'ctl.move': 'Move', 'ctl.jump': 'Jump', 'ctl.slide': 'Slide', 'ctl.clickKey': 'Click', 'ctl.fire': 'Shoot',
  'ctl.weapons': 'Weapons', 'ctl.balloon': 'Balloon', 'ctl.scoreboard': 'Scores', 'ctl.menu': 'Menu',

  'set.sound': 'Sound',
  'set.volume': 'Master volume',
  'set.music': 'Music',
  'set.sfx': 'Sound effects',
  'set.controls': 'Controls',
  'set.sensitivity': 'Mouse sensitivity',
  'set.invertY': 'Invert mouse Y',
  'set.screen': 'Display',
  'set.fov': 'Field of view',
  'set.quality': 'Graphics quality',
  'set.qualityHigh': 'High',
  'set.qualityLow': 'Low (faster)',
  'set.reduceMotion': 'Reduce motion',
  'set.reduceMotionNote': 'Less screen shake and bouncy effects',

  'invite.cap': 'Invite friends · room code',
  'invite.copy': '🔗 Copy invite link',
  'invite.link': 'Invite link',
  'invite.copied': 'Copied! ✓',
  'invite.copiedWeb': 'Copied the web link! ✓',
  'invite.manual': 'Copy the link below by hand',

  'pause.label': 'Paused',
  'pause.title': 'Taking a break',
  'pause.online': 'Online matches keep going — you can still get soaked while paused!',
  'pause.resume': 'Resume',
  'pause.leave': '🚪 Leave room',
  'prompt.start': 'Click to start! 💦',
  'prompt.leave': '🚪 Back to menu',
  'lock.unsupported': 'This device or browser cannot aim with a mouse. Open the game in a desktop browser with a keyboard and mouse.',
  'lock.failed': 'Could not capture the mouse 😢 Click again, and if it still fails, go back to the menu.',
  'lock.embedded': "Could not capture the mouse 😢 Click again, or try the page's fullscreen button. If it still fails, go back to the menu.",

  'code.empty': 'Enter a room code',
  'code.confusing': 'Room codes never contain the look-alike characters 0, 1, O or I. Please check the code again',
  'code.length': 'Check the room code ({min}–{max} letters and digits)',
  'name.default': 'Splasher',
  'name.adj': 'Soggy,Squishy,Chubby,Sparkly,Sleepy,Brave,Shy,Bouncy',
  'name.noun': 'Duck,Seal,Jelly,Tadpole,Otter,Penguin,Frog,Whale',
  'bot.names': 'Bubbles,Splishy,Plunk,Droplet,Splashy,Misty,Fluffy,Wobbles,Fizzy,Trickle',
};

export type StringKey = Key;

const STRINGS: Record<Lang, Record<Key, string>> = { ko, en };

const LANG_KEY = 'splash-bash:lang';

const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as readonly string[]).includes(v);

/** ?lang= 값, 저장된 선택, 브라우저 언어 목록으로 언어를 고른다 */
export function pickLang(param: string | null | undefined, saved: string | null | undefined, browserLangs: readonly string[] = []): Lang {
  if (isLang(param)) return param;
  if (isLang(saved)) return saved;
  for (const l of browserLangs) {
    const base = String(l).toLowerCase().slice(0, 2);
    if (isLang(base)) return base;
  }
  return 'en';
}

function detect(): Lang {
  if (typeof window === 'undefined' || typeof location === 'undefined') return 'en';
  let saved: string | null = null;
  // 저장소가 막힌 환경(다른 사이트 iframe·시크릿 모드)에서는 브라우저 언어로 정한다
  try { saved = localStorage.getItem(LANG_KEY); } catch { /* 위 주석 */ }
  const nav = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  return pickLang(new URLSearchParams(location.search).get('lang'), saved, nav);
}

let lang: Lang = detect();

export const getLang = (): Lang => lang;

/** 테스트용: 이 모듈이 내줄 언어를 바꾼다(실제 화면에서는 저장 후 다시 불러온다) */
export function setLang(l: Lang): void {
  lang = l;
}

/**
 * 선택을 저장한다(호출한 쪽이 페이지를 다시 불러온다). 저장소가 막혀 있으면 false —
 * 그때는 다시 불러올 주소의 ?lang= 으로 선택을 넘긴다.
 */
export function saveLang(l: Lang): boolean {
  try {
    localStorage.setItem(LANG_KEY, l);
    return true;
  } catch {
    return false;
  }
}

/** 메뉴의 언어 버튼: 반대 언어로 바꾸고 다시 불러온다 */
export function switchLang(): void {
  const next: Lang = lang === 'ko' ? 'en' : 'ko';
  const url = new URL(location.href);
  // 주소의 ?lang= 은 저장된 선택보다 먼저 쓰이므로 저장에 성공하면 지우고, 저장이 막혔으면 주소로 넘긴다
  if (saveLang(next)) url.searchParams.delete('lang');
  else url.searchParams.set('lang', next);
  // 해시만 바뀌거나 그대로면 다시 불러오지 않으므로 직접 reload
  if (url.search === location.search) location.reload();
  else location.replace(url);
}

/** key 의 문구. {name} 자리표시자는 vars 로 채우고, 없는 자리는 그대로 둔다 */
export function t(key: Key, vars?: Record<string, string | number>): string {
  let s = STRINGS[lang][key] ?? STRINGS.ko[key];
  if (s === undefined) throw new Error(`missing UI string: ${key}`);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** 쉼표로 묶은 목록 문구(이름 조각·봇 이름) */
export function tList(key: Key): string[] {
  return t(key).split(',');
}

/** 문서 언어·제목·설명을 지금 언어로 맞춘다 */
export function applyDocument(): void {
  document.documentElement.lang = lang;
  document.title = t('doc.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('doc.description'));
}

/** 테스트용: 두 언어의 문구 표 */
export const STRING_TABLES: Readonly<Record<Lang, Readonly<Record<Key, string>>>> = STRINGS;
