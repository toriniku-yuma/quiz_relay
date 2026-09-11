import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const devVars = existsSync('.dev.vars')
  ? parseEnv(readFileSync('.dev.vars', 'utf8'))
  : {};

const probeOrigin = devVars.PROBE_ORIGIN;
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({
      config:
        command === 'build'
          ? {
              hyperdrive: [
                { binding: 'HYPERDRIVE', id: '49ed9c4348e1429d8f04cc6a47755e21' },
              ],
            }
          : { vars: { LOCAL_GAME_ENABLED: 'true' } },
    }),
  ],
  server: {
    https:
      command === 'serve' && devVars.DEV_TLS_CERT && devVars.DEV_TLS_KEY
        ? {
            cert: readFileSync(devVars.DEV_TLS_CERT),
            key: readFileSync(devVars.DEV_TLS_KEY),
          }
        : undefined,
    strictPort: true,
    allowedHosts: probeOrigin ? [new URL(probeOrigin).hostname] : [],
  },
}));
