// index.html（オンライン版）と slide.html（スライド版の試作）の2ページを作る
import { defineConfig } from 'vite';

export default defineConfig({
  build: { rollupOptions: { input: { main: 'index.html', slide: 'slide.html' } } },
});
