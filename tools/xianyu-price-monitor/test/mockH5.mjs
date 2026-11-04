// 本地模拟 h5api.m.goofish.com：首次无令牌时下发 _m_h5_tk；之后严格校验签名。
import crypto from 'node:crypto';
import http from 'node:http';

export async function startMockH5(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const api = url.pathname.split('/')[2];
      const dataStr = new URLSearchParams(body).get('data') || '{}';
      const cookies = Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
      const call = { api, data: JSON.parse(dataStr), cookies, headers: req.headers, query: Object.fromEntries(url.searchParams) };
      calls.push(call);
      const send = (json, status = 200, extraHeaders = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
        res.end(typeof json === 'string' ? json : JSON.stringify(json));
      };
      const tk = cookies._m_h5_tk;
      if (!tk) {
        return send({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'] }, 200, {
          'set-cookie': ['_m_h5_tk=tok123_1999999999999; Path=/; Max-Age=86400', '_m_h5_tk_enc=enc456; Path=/; Max-Age=86400; HttpOnly'],
        });
      }
      const expected = crypto.createHash('md5').update(`${tk.split('_')[0]}&${call.query.t}&34839810&${dataStr}`).digest('hex');
      if (call.query.sign !== expected) return send({ ret: ['FAIL_SYS_ILLEGAL_SIGN::非法签名'] });
      const out = handler(call, calls.length);
      if (out && out.__raw) return send(out.body, out.status ?? 200);
      return send(out);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

export const loginCookie = (host = '127.0.0.1') => ({ name: 'unb', value: '42', domain: host, path: '/', expires: -1 });
