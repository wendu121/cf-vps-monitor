// 生成本地验证用的 service_role JWT。
// 必须与 docker-compose.yml 里的 PGRST_JWT_SECRET 完全一致。
// Worker 会把该 JWT 作为 apikey（及 Authorization）发给 PostgREST。
import crypto from 'node:crypto';

const secret = 'local-validation-only-jwt-secret-change-me';
const now = Math.floor(Date.now() / 1000);
const payload = {
  role: 'service_role',
  iss: 'cf-vps-monitor-local',
  iat: now,
  exp: now + 60 * 60 * 24 * 365 * 10, // 10 年，纯本地验证用
};

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const header = b64url({ alg: 'HS256', typ: 'JWT' });
const body = b64url(payload);
const signingInput = `${header}.${body}`;
const sig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
const jwt = `${signingInput}.${sig}`;

console.log(jwt);
