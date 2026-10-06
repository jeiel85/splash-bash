#!/usr/bin/env node
/**
 * 의존성 소스 패치 — npm install/ci 뒤(postinstall)에 자동으로 실행된다.
 *
 * @trystero-p2p/core 0.25.4 action-wire.mjs (#1)
 *   공개 방에 들어온 피어 하나가 다른 참가자 탭의 메모리를 끝없이 늘릴 수 있었다.
 *   - 16KB 청크를 크기 제한 없이 이어 붙였다 → 메시지당 약 64KB, 피어당 대기 데이터 약 256KB 로 제한하고
 *     넘친 메시지는 버린다(이 게임 메시지는 모두 수 KB 이하).
 *   - 등록하지 않은 action 이름의 페이로드를 쌓아 두고 피어가 떠나도 지우지 않았다 → 버린다.
 *     (게임은 방에 들어가자마자 모든 action 을 등록하고, Trystero 내부 action 도 방을 만들 때 등록된다)
 *   - 깨진 JSON 은 예외 대신 경고 후 버린다.
 *   앱의 형식 검증(src/net/protocol.ts)은 이 재조립 뒤에 일어나서 막을 수 없기 때문에 라이브러리를 고친다.
 *
 * patch-package 대신 직접 적용하는 이유: 이 패치 하나 때문에 lockfile 이 700줄 넘게 늘고 하위 의존성 취약점 경고가
 * 생긴다. 대신 버전이 다르거나 원본이 예상과 다르면 설치를 실패시켜, 업그레이드할 때 패치가 조용히 빠지지 않게 한다.
 * 이미 적용된 파일(표식 있음)은 건너뛴다. 적용하면 Vite 사전 번들 캐시(node_modules/.vite)를 지운다.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MARKER = 'splash-bash patch (#1)';

const WIRE_STATE_FROM = `	const pendingActionPayloads = {};
`;
const WIRE_STATE_TO = `	const pendingActionPayloads = {};
	// ${MARKER}: 재조립 대기 데이터 상한. 청크마다 ArrayBuffer 전체를 붙잡으므로 청크 크기 + 고정 비용으로 센다
	const maxMessageBytes = 64 * 2 ** 10;
	const maxPendingBytesPerPeer = 256 * 2 ** 10;
	const pendingOverheadBytes = 64;
	const pendingBytes = {};
	const dropWarned = {};
	const warnDrop = (id, reason) => {
		if (dropWarned[id]) return;
		dropWarned[id] = true;
		console.warn(\`\${libName}: dropping data from peer \${id} (\${reason})\`);
	};
`;

const WIRE_HANDLE_FROM = `	const handleData = (id, data) => {
		const buffer = new Uint8Array(data);
		const type = decodeBytes(buffer.subarray(typeIndex, nonceIndex)).replaceAll("\\0", "");
		const action = actions[type];
		if (!canReceiveFromPeer(id, Boolean(action?.options.receiveWhilePending))) return;
		const nonce = (buffer[nonceIndex] ?? 0) << 8 | (buffer[33] ?? 0);
		const tag = buffer[tagIndex] ?? 0;
		const progress = buffer[progressIndex] ?? 0;
		const payload = buffer.subarray(payloadIndex);
		const isLast = Boolean(tag & 1);
		const isMeta = Boolean(tag & 2);
		const isBinary = Boolean(tag & 4);
		const isJson = Boolean(tag & 8);
		pendingTransmissions[id] ??= {};
		pendingTransmissions[id][type] ??= {};
		const target = pendingTransmissions[id][type][nonce] ??= { chunks: [] };
		if (isMeta) target.meta = fromJson(decodeBytes(payload));
		else target.chunks.push(payload);
		action?.onProgress(progress / oneByteMax, id, target.meta);
		if (!isLast) return;
		const full = new Uint8Array(target.chunks.reduce((a, c) => a + c.byteLength, 0));
		target.chunks.reduce((a, c) => {
			full.set(c, a);
			return a + c.byteLength;
		}, 0);
		delete pendingTransmissions[id][type][nonce];
		const payloadValue = isBinary ? full : isJson ? fromJson(decodeBytes(full)) : decodeBytes(full);
		if (action) {
			action.onComplete(payloadValue, id, target.meta);
			return;
		}
		(pendingActionPayloads[type] ??= []).push({
			payload: payloadValue,
			peerId: id,
			...target.meta === void 0 ? {} : { metadata: target.meta }
		});
	};
`;
const WIRE_HANDLE_TO = `	const handleData = (id, data) => {
		const buffer = new Uint8Array(data);
		const type = decodeBytes(buffer.subarray(typeIndex, nonceIndex)).replaceAll("\\0", "");
		const action = actions[type];
		// ${MARKER}: 등록하지 않은 action 은 쌓아 두지 않는다(피어가 떠나도 지워지지 않았다)
		if (!action) return warnDrop(id, \`unknown action "\${type}"\`);
		if (!canReceiveFromPeer(id, action.options.receiveWhilePending)) return;
		const nonce = (buffer[nonceIndex] ?? 0) << 8 | (buffer[33] ?? 0);
		const tag = buffer[tagIndex] ?? 0;
		const progress = buffer[progressIndex] ?? 0;
		const payload = buffer.subarray(payloadIndex);
		const isLast = Boolean(tag & 1);
		const isMeta = Boolean(tag & 2);
		const isBinary = Boolean(tag & 4);
		const isJson = Boolean(tag & 8);
		pendingTransmissions[id] ??= {};
		pendingTransmissions[id][type] ??= {};
		let target = pendingTransmissions[id][type][nonce];
		if (!target) {
			if ((pendingBytes[id] ?? 0) + pendingOverheadBytes > maxPendingBytesPerPeer) return warnDrop(id, "too much pending data");
			target = pendingTransmissions[id][type][nonce] = { chunks: [], bytes: 0 };
			pendingBytes[id] = (pendingBytes[id] ?? 0) + pendingOverheadBytes;
		}
		const release = () => {
			delete pendingTransmissions[id][type][nonce];
			pendingBytes[id] -= target.bytes + pendingOverheadBytes;
		};
		// 넘친 메시지는 청크를 버리고 표식만 남겨, 같은 nonce 의 나머지 청크가 새 메시지로 이어 붙지 않게 한다
		const drop = (reason) => {
			warnDrop(id, reason);
			pendingBytes[id] -= target.bytes;
			target.bytes = 0;
			target.chunks = [];
			target.meta = void 0;
			target.dropped = true;
		};
		const cost = buffer.byteLength + pendingOverheadBytes;
		if (!target.dropped) {
			if (target.bytes + cost > maxMessageBytes) drop("message too large");
			else if (pendingBytes[id] + cost > maxPendingBytesPerPeer) drop("too much pending data");
		}
		if (target.dropped) {
			if (isLast) release();
			return;
		}
		target.bytes += cost;
		pendingBytes[id] += cost;
		if (isMeta) {
			try {
				target.meta = fromJson(decodeBytes(payload));
			} catch {
				drop("malformed metadata");
				if (isLast) release();
				return;
			}
		} else target.chunks.push(payload);
		action.onProgress(progress / oneByteMax, id, target.meta);
		if (!isLast) return;
		const full = new Uint8Array(target.chunks.reduce((a, c) => a + c.byteLength, 0));
		target.chunks.reduce((a, c) => {
			full.set(c, a);
			return a + c.byteLength;
		}, 0);
		release();
		let payloadValue;
		try {
			payloadValue = isBinary ? full : isJson ? fromJson(decodeBytes(full)) : decodeBytes(full);
		} catch {
			return warnDrop(id, "malformed payload");
		}
		action.onComplete(payloadValue, id, target.meta);
	};
`;

const WIRE_CLEAR_FROM = `		clearPeer: (id) => {
			delete pendingTransmissions[id];
		}
`;
const WIRE_CLEAR_TO = `		clearPeer: (id) => {
			delete pendingTransmissions[id];
			delete pendingBytes[id];
			delete dropWarned[id];
		}
`;

const PATCHES = [
  {
    pkg: '@trystero-p2p/core',
    version: '0.25.4',
    file: 'dist/action-wire.mjs',
    edits: [
      [WIRE_STATE_FROM, WIRE_STATE_TO],
      [WIRE_HANDLE_FROM, WIRE_HANDLE_TO],
      [WIRE_CLEAR_FROM, WIRE_CLEAR_TO],
    ],
  },
];

let failed = false;
let applied = false;
for (const p of PATCHES) {
  const dir = path.join(root, 'node_modules', p.pkg);
  const label = `${p.pkg}/${p.file}`;
  if (!existsSync(dir)) {
    console.error(`[patch-deps] ${p.pkg} 가 설치되어 있지 않아요.`);
    failed = true;
    continue;
  }
  const version = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  if (version !== p.version) {
    console.error(`[patch-deps] ${p.pkg} 버전이 ${p.version} 이 아니라 ${version} 이에요. 새 버전에 맞게 tools/patch-deps.mjs 를 다시 확인하세요(#1).`);
    failed = true;
    continue;
  }
  const file = path.join(dir, p.file);
  const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (src.includes(MARKER)) {
    console.log(`[patch-deps] ${label} 이미 적용됨`);
    continue;
  }
  let out = src;
  for (const [from, to] of p.edits) {
    if (out.split(from).length !== 2) {
      console.error(`[patch-deps] ${label} 에서 고칠 부분을 정확히 한 곳 찾지 못했어요:\n${from.split('\n')[0]}…`);
      failed = true;
      out = null;
      break;
    }
    out = out.replace(from, () => to);
  }
  if (out === null) continue;
  writeFileSync(file, out);
  applied = true;
  console.log(`[patch-deps] ${label} 적용`);
}

// Vite 는 의존성을 미리 묶어 node_modules/.vite 에 두고 lockfile 이 바뀔 때만 다시 묶는다
if (applied) rmSync(path.join(root, 'node_modules', '.vite'), { recursive: true, force: true });
if (failed) process.exit(1);
