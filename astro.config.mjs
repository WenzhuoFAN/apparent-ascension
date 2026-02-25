// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  vite: {
    preview: {
      allowedHosts: [
        'fg-fansite-app-d9f490124f97.herokuapp.com',
        '.herokuapp.com',
      ],
    },
  },
});
