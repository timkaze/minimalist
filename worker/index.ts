// Cloudflare Worker：静的ファイル（ゲーム画面）は assets から配信し，/api/room/:code/ws だけを部屋（Durable Object）へ渡す

import { ROOM_CODE_RE } from '../src/net/protocol';
export { Room } from './room';

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/room\/([^/]+)\/ws$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!ROOM_CODE_RE.test(code)) return new Response('bad room code', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
