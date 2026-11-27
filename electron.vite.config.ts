import { defineConfig } from "electron-vite"

// Entries are the electron-vite defaults: src/main/index.ts,
// src/preload/index.ts and src/renderer/index.html.
export default defineConfig({
  main: {},
  preload: {
    // A sandboxed preload script has to be CommonJS.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } }
  },
  renderer: {}
})
