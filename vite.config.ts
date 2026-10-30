// index.html（スライド版のゲーム）と print.html（印刷データ）の2ページを作る
import { defineConfig } from 'vite';

export default defineConfig({
  build: { rollupOptions: { input: { main: 'index.html', print: 'print.html' } } },
});
