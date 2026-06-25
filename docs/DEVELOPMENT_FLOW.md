# FilesSharing 开发流程

## 1. 阶段划分

### Phase 0：项目初始化

目标：建立 Cloudflare Worker + R2 + D1 的最小工程骨架。

交付物：

- `package.json`
- `wrangler.toml`
- `tsconfig.json`
- `src/index.ts`
- `migrations/0001_init.sql`
- `scripts/upload.mjs`
- `docs/SYSTEM_DESIGN.md`

验收标准：

```bash
npm install
npm run typecheck
npm run dev
```

### Phase 1：上传与分享闭环

目标：完成从管理页或 CLI 上传文件，到生成短链接，再到下载文件的闭环。

工作项：

1. `POST /api/upload`：校验管理员 token，解析 multipart form。
2. 写入 R2 私有 bucket。
3. 写入 D1 分享记录。
4. 返回 `/s/:token` 链接。
5. `GET /s/:token`：校验并返回文件。
6. CLI 上传脚本。

验收标准：

```bash
node scripts/upload.mjs ./demo.pdf --endpoint http://localhost:8787 --token "$ADMIN_TOKEN"
curl -I http://localhost:8787/s/<token>
```

### Phase 2：权限与生命周期

目标：让链接具备临时分享所需的基本控制。

工作项：

1. TTL 实时校验。
2. 最大下载次数限制。
3. 可选密码。
4. `DELETE /api/shares/:token` 撤销。
5. `scheduled()` 清理任务。
6. R2 lifecycle 兜底规则。

验收标准：

- 过期链接返回 410。
- 超过下载次数返回 410。
- 撤销链接返回 410。
- 设置密码的链接不能被无密码请求直接下载。
- cleanup 后 R2 对象被删除。

### Phase 3：管理体验

目标：让个人使用更顺手。

工作项：

1. 管理页增加分享列表。
2. 支持复制链接。
3. 支持一键撤销。
4. 支持过期状态展示。
5. 支持上传后立即显示链接。

### Phase 4：生产化增强

目标：减少误用和异常流量带来的问题。

工作项：

1. 接入 Cloudflare Access 保护管理页。
2. 增加 Turnstile。
3. 增加 WAF/rate limit 策略。
4. 增加下载事件表。
5. 增加 MIME 类型策略。
6. 增加上传大小按环境配置。

## 2. 本地开发步骤

### 2.1 安装依赖

```bash
npm install
```

### 2.2 配置本地变量

```bash
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`：

```bash
ADMIN_TOKEN=change-me-to-a-long-random-token
PASSWORD_PEPPER=change-me-to-a-long-random-secret
SHARE_BASE_URL=http://localhost:8787
DEFAULT_TTL_SECONDS=86400
MAX_FILE_BYTES=52428800
```

### 2.3 初始化本地 D1

```bash
npm run db:migrate:local
```

### 2.4 启动开发服务

```bash
npm run dev
```

打开：

```text
http://localhost:8787
```

## 3. Cloudflare 资源创建

### 3.1 登录

```bash
npx wrangler login
```

### 3.2 创建 R2 bucket

```bash
npx wrangler r2 bucket create files-sharing-temp
```

### 3.3 创建 D1 database

```bash
npx wrangler d1 create files-sharing
```

把返回的 `database_id` 写入 `wrangler.toml`。

### 3.4 远端迁移

```bash
npm run db:migrate:remote
```

### 3.5 设置 lifecycle

```bash
npm run r2:lifecycle:set
```

### 3.6 设置 secret

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put PASSWORD_PEPPER
```

### 3.7 部署

```bash
npm run deploy
```

## 4. 自定义域名

开发阶段可以先使用 `workers.dev`。正式使用时建议把 Worker 绑定到自己的子域名：

```toml
workers_dev = false

[route]
pattern = "files.example.com/*"
zone_name = "example.com"
```

同时设置：

```toml
[vars]
SHARE_BASE_URL = "https://files.example.com"
```

## 5. 验证命令

### 5.1 类型检查

```bash
npm run typecheck
```

### 5.2 本地上传

```bash
node scripts/upload.mjs ./README.md \
  --endpoint http://localhost:8787 \
  --token "$ADMIN_TOKEN" \
  --ttl 3600 \
  --max-downloads 2
```

### 5.3 下载验证

```bash
curl -L "http://localhost:8787/s/<token>" -o downloaded-file
```

### 5.4 列出分享

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:8787/api/shares"
```

### 5.5 撤销分享

```bash
curl -X DELETE \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:8787/api/shares/<token>?deleteObject=1"
```

## 6. 后续开发优先级

最先做：

1. 管理页列表和撤销按钮。
2. 下载事件表。
3. Cloudflare Access 登录。
4. Turnstile 表单保护。
5. 大文件 multipart upload。

不建议第一版做：

1. 多用户系统。
2. 在线预览。
3. 文件夹树。
4. 版本管理。
5. 桌面同步客户端。

这些会把项目从临时分享工具扩展成完整网盘，复杂度会快速上升。
