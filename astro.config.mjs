// @ts-check
import { defineConfig, envField } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  site: 'https://poke-research.com',
  adapter: cloudflare(),
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