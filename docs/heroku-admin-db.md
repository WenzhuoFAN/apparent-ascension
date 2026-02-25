# Heroku 数据持久化与管理员配置

## 1. 为什么需要数据库
- 你现在要保存的是“线上编辑内容”，不是本地浏览器缓存。
- `localStorage` 只在当前浏览器有效，不适合作为站点后台数据源。
- Heroku 重建或重启后，dyno 文件系统是临时的，不能存后台数据。

本项目已改为：
- 使用 PostgreSQL 保存编辑内容（`site_content`）。
- 使用管理员账号 + 会话表做登录权限（`admin_users` / `admin_sessions`）。

## 2. 必需环境变量
- `DATABASE_URL`：Heroku Postgres 提供。

## 3. 初始化数据库
```bash
npm run db:init
```

首次拉取这些改动后，请先执行一次依赖安装并提交更新后的 lock 文件：
```bash
npm install
```

## 4. 创建管理员账号
```bash
npm run admin:create -- <username> <password>
```

示例：
```bash
npm run admin:create -- admin yourStrongPassword123
```

## 5. 使用方式
1. 打开 `/admin` 登录。
2. 登录后去 `/schedule` 或 `/start`，编辑按钮会自动出现。
3. 保存内容后会写入数据库，所有访客都会看到同一份数据。

## 6. Heroku 运行模式
- 项目已改为 Astro Node SSR（不是纯静态 `serve dist`）。
- `start` 脚本：`node dist/server/entry.mjs`
