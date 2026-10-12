/**
 * Throwaway tsdown config that bundles the preview entry (real component plus
 * React) into one browser IIFE for screenshotting.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-plugin-subscription-oauth/preview',
  entry: { preview: 'tools/preview-entry.tsx' },
  outDir: 'probe',
  format: 'iife',
  platform: 'browser',
  dts: false,
  sourcemap: false,
  clean: false,
  // A standalone page has no loader table, so everything inlines.
  noExternal: () => true,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
  },
  outputOptions: { entryFileNames: 'preview.js' },
})
