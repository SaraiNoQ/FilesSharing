# FilesSharing

FilesSharing 是一个面向临时文件分享的轻量服务。核心架构是：Cloudflare Worker 作为公网分享网关，R2 私有 bucket 存储文件对象，D1 保存分享记录与权限元数据，KV 仅作为可选缓存层。

它不是完整网盘系统，而是一个更窄、更可靠的“临时文件投递/分享工具”：上传小文件，生成短链接，通过自己的公网域名暴露下载地址，并支持过期、撤销、下载次数限制和可选密码。

## 架构

```text
前端管理页 / CLI 上传
        ↓
Cloudflare Worker API
        ↓
R2 私有 bucket 写入对象
        ↓
D1 保存分享记录、过期时间、权限元数据
        ↓
生成 /s/:token 短链接
        ↓
Worker 校验 token / 过期时间 / 下载次数 / 密码
        ↓
从 R2 读取对象并返回下载响应
        ↓
D1 定时清理 + R2 lifecycle 后台兜底删除
```

## 已实现的第一版能力

- Worker 单体服务，无需自建服务器。
- 管理页上传文件。
- CLI 上传文件。
- R2 私有 bucket 存储对象。
- D1 保存分享记录。
- 短链接下载：`/s/:token`。
- 管理 API：上传、列出、撤销。
- 分享控制：TTL、最大下载次数、可选密码。
- Cron scheduled cleanup：定期删除过期或撤销的对象。
- R2 lifecycle JSON 示例：后台兜底删除 `tmp/` 前缀对象。

## 目录结构

```text
.
├── docs/
│   ├── SYSTEM_DESIGN.md
│   └── DEVELOPMENT_FLOW.md
├── lifecycle/
│   └── r2-lifecycle.json
├── migrations/
│   └── 0001_init.sql
├── scripts/
│   └── upload.mjs
├── src/
│   ├── html.ts
│   ├── index.ts
│   └── types.ts
├── wrangler.toml
├── package.json
└── tsconfig.json
```

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars` 至少需要：

```bash
ADMIN_TOKEN=change-me-to-a-long-random-token
PASSWORD_PEPPER=change-me-to-a-long-random-secret
SHARE_BASE_URL=http://localhost:8787
```

## Cloudflare 资源初始化

```bash
npx wrangler login
npx wrangler r2 bucket create files-sharing-temp
npx wrangler d1 create files-sharing
```

然后把 D1 返回的 `database_id` 写入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "files-sharing"
database_id = "REPLACE_WITH_D1_DATABASE_ID"
```

初始化数据库：

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

设置 R2 生命周期规则：

```bash
npm run r2:lifecycle:set
```

部署：

```bash
npm run deploy
```

## 使用 CLI 上传

```bash
node scripts/upload.mjs ./demo.pdf \
  --endpoint https://files.example.com \
  --token "$ADMIN_TOKEN" \
  --ttl 86400 \
  --max-downloads 5
```

返回内容包含分享链接：

```json
{
  "ok": true,
  "url": "https://files.example.com/s/abc123...",
  "expiresAt": 1790000000
}
```

## 设计文档

- [系统设计方案](docs/SYSTEM_DESIGN.md)
- [开发流程](docs/DEVELOPMENT_FLOW.md)

## 当前边界

这一版先做轻量临时分享，不做多用户账号系统、目录同步、在线预览、全文搜索、版本管理和大文件分片上传。后续如果需要扩展为完整网盘，应把用户、空间配额、审计日志、对象版本、后台任务队列和更细粒度 ACL 独立出来。
