import react from '@vitejs/plugin-react';
import { loadEnv, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { SECURITY_HEADERS, cspMeta, headersFile } from './security-headers';

/** Adds the security policy to production builds only, because the dev server needs inline scripts for hot reload. */
function securityPolicy(supabaseUrl?: string): Plugin {
  return {
    name: 'gridtheory-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: cspMeta(supabaseUrl) }, injectTo: 'head-prepend' },
      { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' },
    ],
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: headersFile() });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    securityPolicy(loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'GridTheory',
        short_name: 'GridTheory',
        description: 'Duel chess bots, fix your own mistakes, study a course, and review your games.',
        theme_color: '#14171b',
        background_color: '#14171b',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Everything the app needs offline, including the chess engine and the puzzle set.
        globPatterns: ['**/*.{js,css,html,wasm,woff2,png,json}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
  base: './',
  build: { sourcemap: false },
  // Lets `npm run preview` behave like a real deployment, so the policy can be tested before going live.
  preview: { headers: SECURITY_HEADERS },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.engine.test.ts'],
  },
}));
