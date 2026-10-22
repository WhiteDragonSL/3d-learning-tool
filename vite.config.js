import { defineConfig } from 'vite';

// Relative asset paths, so the build works both locally and on GitHub Pages
// (served from https://<user>.github.io/3d-learning-tool/).
export default defineConfig({
  base: './',
});
