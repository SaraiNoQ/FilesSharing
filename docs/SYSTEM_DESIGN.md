# FilesSharing 系统设计方案

## 1. 目标定位

FilesSharing 的目标不是做完整网盘，而是做一个轻量、低维护成本的临时文件分享工具。它只解决一个核心问题：把小文件临时上传到云端，通过自己的公网域名生成短链接，并让别人可以在受控时间窗口内下载。

核心原则：

1. 文件对象不公开暴露，R2 bucket 默认保持私有。
2. 所有公网访问都经过 Worker 网关。
3. 权限判断不依赖随机对象名，而依赖服务端分享记录。
4. 临时失效由 Worker 的实时校验保证，R2 lifecycle 只做后台兜底清理。
5. 第一版控制复杂度，不做多用户空间、目录同步、在线协作和复杂权限组。

## 2. 总体架构

```text
管理页 / CLI 上传
        ↓
Cloudflare Worker API
        ↓
R2 私有 bucket 写入对象
        ↓
D1 保存分享记录、过期时间、权限元数据
        ↓
生成 /s/:token 短链接
        ↓
Worker 校验 token / 过期时间 / 下载次数 / 可选密码
        ↓
从 R2 读取对象并返回下载响应
        ↓
D1 定时清理 + R2 lifecycle 后台兜底删除
```

## 3. 技术选型

### 3.1 Cloudflare Worker

Worker 是唯一公网入口，承担 API、下载网关、管理页渲染和定时清理。这样可以避免把 R2 bucket 设置为 public bucket，也避免对象 URL 被直接长期暴露。

### 3.2 R2

R2 只负责对象存储。对象 key 由 Worker 生成，不作为权限机制。推荐前缀：

```text
tmp/YYYY/MM/DD/<token>/<safe-filename>
```

R2 对象元数据中保存少量辅助信息：token、filename、expiresAt。这些元数据不是权限来源，只用于对象侧排查和恢复。

### 3.3 D1

D1 是分享记录的 source of truth。下载次数限制、撤销状态、过期判断都需要可靠读写，因此第一版不把 KV 作为权限数据源。

第一版使用一张表：

```sql
shares(
  token TEXT PRIMARY KEY,
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_downloaded_at INTEGER
)
```

### 3.4 KV，可选

KV 不作为强一致权限源。它可以在后续版本中缓存非关键元数据，例如分享页展示信息，或者减少 D1 读取压力。但每一次真正下载仍应更新 D1，以保证下载次数限制有效。

## 4. 核心流程

### 4.1 上传流程

```text
1. 管理页或 CLI 请求 POST /api/upload。
2. Worker 校验 Authorization: Bearer <ADMIN_TOKEN>。
3. 解析 multipart/form-data。
4. 校验文件大小、TTL、下载次数。
5. 生成 token 和 object_key。
6. 文件写入 R2 私有 bucket。
7. 分享记录写入 D1。
8. 返回短链接 /s/:token。
```

上传 API：

```http
POST /api/upload
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: multipart/form-data

file=<File>
ttlSeconds=86400
maxDownloads=5
password=optional
```

响应：

```json
{
  "ok": true,
  "token": "abc123",
  "url": "https://files.example.com/s/abc123",
  "objectKey": "tmp/2026/06/25/abc123/demo.pdf",
  "expiresAt": 1790000000
}
```

### 4.2 下载流程

```text
1. 用户访问 GET /s/:token。
2. Worker 从 D1 查询分享记录。
3. 检查 revoked_at、expires_at、max_downloads、password_hash。
4. 若需要密码，返回密码输入页或校验 POST 表单。
5. 更新 download_count。
6. 从 R2 读取对象。
7. 返回带 Content-Disposition 的响应。
```

下载不直接暴露 R2 URL。只要 bucket 保持私有，R2 object key 不能绕过 Worker 权限校验。

### 4.3 撤销流程

```text
1. 管理端请求 DELETE /api/shares/:token。
2. Worker 校验管理员 token。
3. D1 写入 revoked_at。
4. 删除可选 KV cache。
5. 如传入 ?deleteObject=1，则立即删除 R2 对象。
6. 否则由 scheduled cleanup 后台删除。
```

### 4.4 清理流程

清理有两层：

第一层是 Worker scheduled cleanup。它查询 D1 中已过期或已撤销的记录，删除对应 R2 对象，并清理 D1 记录。

第二层是 R2 lifecycle。它按 `tmp/` 前缀自动删除超过保留天数的对象，防止 Worker 清理失败后对象长期保留。

注意：R2 lifecycle 不是精确到秒的权限控制。链接失效必须由 Worker 在请求时判断。

## 5. API 设计

### 5.1 `GET /`

返回内置管理页面。

### 5.2 `GET /healthz`

健康检查。

### 5.3 `POST /api/upload`

管理员上传文件并创建分享链接。

字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---:|---:|---|
| file | File | 是 | 上传文件 |
| ttlSeconds | number | 否 | 默认 86400 |
| maxDownloads | number | 否 | 空表示不限次数 |
| password | string | 否 | 设置后下载前需要输入密码 |

### 5.4 `GET /api/shares`

管理员列出最近分享记录。

### 5.5 `DELETE /api/shares/:token`

管理员撤销分享。

可选参数：

```text
?deleteObject=1
```

表示立即删除 R2 对象。

### 5.6 `GET /s/:token`

访问分享链接。若无密码要求，直接返回文件。若需要密码，返回密码输入页。

### 5.7 `POST /s/:token`

提交密码并下载文件。

## 6. 部署拓扑

推荐域名：

```text
files.example.com
```

Worker route：

```toml
workers_dev = false

[route]
pattern = "files.example.com/*"
zone_name = "example.com"
```

开发阶段可以先使用 `workers.dev`。

## 7. 配置建议

| 配置 | 建议值 |
|---|---:|
| DEFAULT_TTL_SECONDS | 86400 |
| MAX_FILE_BYTES | 52428800 |
| R2 lifecycle tmp/ 删除 | 30 days |
| incomplete multipart cleanup | 1 day |
| 默认最大下载次数 | 不限制，由上传时指定 |

## 8. 后续 Roadmap

### v0.2

- 更完整的管理页列表。
- 下载日志表 `download_events`。
- 文件 MIME 类型白名单/黑名单。
- Turnstile 表单保护。

### v0.3

- Cloudflare Access 管理员登录。
- 多用户空间。
- 用户配额。
- 批量上传。

### v0.4

- 大文件 multipart upload。
- 临时上传直传 URL。
- 对象预览：图片、PDF、文本。
- 分享页品牌化。
