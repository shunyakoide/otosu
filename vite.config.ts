import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';

// PWA（D74）: ビルドの後に dist/ の中身を全部並べて、オフライン用の Service Worker を書き出す。
// 版の名前はファイルの中身のハッシュなので、中身が変わらなければ端末は取り直さない

const SW_SOURCE = 'src/pwa/sw.js';
const SW_OUT = 'sw.js';
// インストールの画面でしか使わないので、取っておかない
const SKIP = (path: string) => path === SW_OUT || path.startsWith('screenshots/');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)],
  );
}

function pwa(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'otosu-pwa',
    apply: 'build',
    configResolved(c) {
      config = c;
    },
    closeBundle() {
      const out = resolve(config.root, config.build.outDir);
      const source = readFileSync(resolve(config.root, SW_SOURCE), 'utf8');
      // SW 自身を変えたときも版を変える
      const hash = createHash('sha256').update(source);
      const urls: string[] = [];
      for (const f of files(out).sort()) {
        const path = relative(out, f).split(sep).join('/');
        if (SKIP(path)) continue;
        hash.update(path).update(readFileSync(f));
        // index.html は / で取る（Cloudflare は /index.html を / へ転送する）
        urls.push(path === 'index.html' ? '/' : `/${path}`);
      }
      const sw = source
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__PRECACHE__', JSON.stringify(urls));
      writeFileSync(join(out, SW_OUT), sw);
    },
  };
}

export default defineConfig({
  plugins: [pwa()],
});
