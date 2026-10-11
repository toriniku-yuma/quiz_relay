import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { localOperationsConfig } from './scripts/local-operations-config.ts';

const devVars = existsSync('.dev.vars')
  ? parseEnv(readFileSync('.dev.vars', 'utf8'))
  : {};

const probeOrigin = devVars.PROBE_ORIGIN;
export default defineConfig(({ command }) => {
  const operations = command === 'serve' ? localOperationsConfig(devVars) : undefined;
  return {
    plugins: [
      react(),
      tailwindcss(),
      cloudflare({
        persistState: { path: '.wrangler/state' },
        config:
          command === 'build'
            ? {}
            : {
                vars: { LOCAL_GAME_ENABLED: 'true' },
                services: operations
                  ? [
                      {
                        binding: 'ACCOUNT_ERASURE',
                        service: 'quiz-relay-account-erasure',
                      },
                    ]
                  : [],
              },
        auxiliaryWorkers: operations
          ? [
              {
                configPath: 'wrangler.erasure.jsonc',
                devOnly: true,
                config: { vars: operations },
              },
            ]
          : [],
      }),
    ],
    server: {
      // Local PostgreSQL clusters, backups, and DO state are not application sources.
      watch: { ignored: ['**/.wrangler/**'] },
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
  };
});
