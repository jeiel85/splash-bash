// dist/ 를 itch.io HTML 업로드용 zip 으로 묶는다(압축 루트에 index.html). 먼저 npm run build.
// 의존성 없는 순수 Node(zlib.crc32 때문에 22.2+): deflate 항목 + 중앙 디렉터리.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const root = 'dist';
const out = 'release/splash-bash-itch.zip';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]))
  .sort();
const files = walk(root);
if (!files.some((f) => relative(root, f) === 'index.html')) throw new Error('dist/index.html 이 없습니다 — 먼저 npm run build');

// 빌드 파일 중 가장 늦은 수정 시각(DOS 형식) — 같은 빌드를 다시 묶으면 같은 zip 이 나온다
const when = new Date(Math.max(...files.map((f) => statSync(f).mtimeMs)));
const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();

const locals = [];
const central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(relative(root, file).split(sep).join('/'), 'utf8');
  const data = readFileSync(file);
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(8, 8); // deflate
  head.writeUInt16LE(dosTime, 10);
  head.writeUInt16LE(dosDate, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(packed.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26);
  locals.push(head, name, packed);

  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4); // made by
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0x0800, 8);
  dir.writeUInt16LE(8, 10);
  dir.writeUInt16LE(dosTime, 12);
  dir.writeUInt16LE(dosDate, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(packed.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(name.length, 28);
  dir.writeUInt32LE(offset, 42);
  central.push(dir, name);
  offset += head.length + name.length + packed.length;
}
const dirSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(dirSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync('release', { recursive: true });
const zip = Buffer.concat([...locals, ...central, end]);
writeFileSync(out, zip);
console.log(`${out}: v${version}, ${files.length} files, ${(zip.length / 1024).toFixed(0)} kB`);
