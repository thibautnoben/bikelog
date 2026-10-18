// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  // No images to transform, so skip the Cloudflare Images binding.
  adapter: cloudflare({ imageService: 'passthrough' }),
  // Auth uses a signed cookie (src/lib/auth.ts), so Astro sessions and their KV binding are not needed.
  session: false,
  // Self-hosted through the Fonts API: the file gets a hashed, immutably cached URL under /_astro/, a
  // <link rel="preload"> (see Layout.astro) and a metric-matched fallback face so the swap causes no layout shift.
  fonts: [
    {
      provider: fontProviders.local(),
      name: 'JetBrains Mono',
      cssVariable: '--font-mono',
      fallbacks: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      options: {
        variants: [
          {
            // Variable font, Latin subset (license: public/fonts/jetbrains-mono-OFL.txt).
            src: ['./src/assets/fonts/jetbrains-mono.woff2'],
            weight: '400 700',
            style: 'normal',
            display: 'swap',
            unicodeRange: [
              'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
            ],
          },
        ],
      },
    },
  ],
});
