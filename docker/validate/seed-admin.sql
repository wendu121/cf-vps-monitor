-- 本地验证用：把 admin 用户的密码替换为已知口令 TestAdmin123 的 pbkdf2_sha256 哈希。
-- 仅用于本地 Docker 验证，不计入口迁移。
update users
set passwd = 'pbkdf2_sha256$10000$uOWM8gwjM5Lq5k5Sjy1zjQ==$jp0/qszM9MV/3uiqlJweD62D8ywrFKdq7zxRcGTbZLk=',
    password_changed_at = now(),
    totp_secret_enc = null,
    totp_enabled_at = null
where username = 'admin';

select uuid, username, session_version, left(passwd, 30) as passwd_preview
from users where username = 'admin';
