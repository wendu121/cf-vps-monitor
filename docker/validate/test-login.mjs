// 本地验证：通过 Worker(:8787) 测试 admin 登录 + 鉴权会话路径。
// 不打印任何密码 / token / cookie 明文，仅输出状态与返回的用户名。
const BASE = 'http://127.0.0.1:8787';
const PW = 'TestAdmin123';

function summarize(label, res, body) {
  let extra = '';
  try {
    const j = JSON.parse(body);
    if (j && j.username) extra = ` username=${j.username}`;
    if (j && j.code) extra += ` code=${j.code}`;
  } catch {}
  console.log(`${label}: HTTP ${res.status} setCookie=${res.headers.get('set-cookie') ? 'yes' : 'no'}${extra}`);
}

const loginRes = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: PW }),
});
const loginBody = await loginRes.text();
const cookie = loginRes.headers.get('set-cookie');
summarize('POST /api/login', loginRes, loginBody);

if (cookie) {
  const meRes = await fetch(`${BASE}/api/me`, {
    method: 'GET',
    headers: { Cookie: cookie.split(';')[0] },
  });
  const meBody = await meRes.text();
  summarize('GET  /api/me', meRes, meBody);

  const adminRes = await fetch(`${BASE}/api/admin/clients`, {
    method: 'GET',
    headers: { Cookie: cookie.split(';')[0] },
  });
  const adminBody = await adminRes.text();
  let clients = '';
  try { const j = JSON.parse(adminBody); clients = ` clients=${(j.clients || j.data || []).length}`; } catch {}
  console.log(`GET  /api/admin/clients: HTTP ${adminRes.status}${clients}`);
} else {
  console.log('GET  /api/me: SKIPPED (no session cookie returned)');
}
