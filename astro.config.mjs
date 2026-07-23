// @ts-check
import { defineConfig, envField } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';
import { topic } from './src/config/topic.config.mjs';

// https://astro.build/config
export default defineConfig({
  site: topic.site.url,
  adapter: cloudflare(),
  vite: {
    resolve: {
      // Astro既定のtsconfigPaths解決（resolve.tsconfigPaths: true）はWindows上でRolldownの
      // 既知のパス解析バグ（rolldown/rolldown#8732、SSRビルドでのバックスラッシュ混在パス生成）を
      // 誘発し `npm run build` が失敗する。本プロジェクトはtsconfig.jsonにpathsエイリアスを
      // 定義しておらず解決対象が無いため、この機能自体を無効化しても挙動に影響しない。
      tsconfigPaths: false,
    },
    build: {
      rollupOptions: {
        // 静的ページのプリレンダービルドでは、Rolldownが各入力ファイルごとにtsconfigを
        // ディレクトリ遡上で自動探索する（tsconfig: true相当）が、これも上記と同じWindows
        // パス解析バグを踏む。プロジェクト直下のtsconfig.jsonを明示指定して自動探索自体を回避する。
        tsconfig: './tsconfig.json',
      },
    },
  },
  env: {
    schema: {
      SUPABASE_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
      SUPABASE_PUBLISHABLE_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      SUPABASE_SECRET_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      DATABASE_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
      QIITA_PER_PAGE: envField.string({ context: 'server', access: 'secret', optional: true }),
      QIITA_PAGES: envField.string({ context: 'server', access: 'secret', optional: true }),
      QIITA_TOKEN: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
});