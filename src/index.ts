import { htmlResponse, renderAdminPage, renderMessagePage, renderPasswordPage } from './html';
import type { Env, ErrorResponse, ShareRecord, UploadResponse } from './types';

const DEFAULT_TTL_SECONDS = 86_400;
const DEFAULT_MAX_FILE_BYTES = 52_428_800;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{16,96}$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal error';
      return jsonResponse({ ok: false, error: message }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupExpiredShares(env));
  },
};

async function handleRequest(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  if (request.method === 'GET' && url.pathname === '/') {
    return htmlResponse(renderAdminPage());
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    return jsonResponse({ ok: true, service: 'files-sharing' });
  }

  if (request.method === 'POST' && url.pathname === '/api/upload') {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    return handleUpload(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/api/shares') {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    return listShares(url, env);
  }

  const deleteMatch = url.pathname.match(/^\/api\/shares\/([^/]+)$/);
  if (request.method === 'DELETE' && deleteMatch) {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    return revokeShare(deleteMatch[1], url, env);
  }

  const shareMatch = url.pathname.match(/^\/s\/([^/]+)$/);
  if ((request.method === 'GET' || request.method === 'POST') && shareMatch) {
    return handleShareDownload(request, shareMatch[1], env);
  }

  return jsonResponse({ ok: false, error: 'Not found' }, 404);
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const fileValue = form.get('file');

  if (!(fileValue instanceof File)) {
    return jsonResponse({ ok: false, error: 'Missing file field' }, 400);
  }

  const maxFileBytes = parseConfigInt(env.MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
  if (fileValue.size <= 0) {
    return jsonResponse({ ok: false, error: 'Empty files are not accepted' }, 400);
  }
  if (fileValue.size > maxFileBytes) {
    return jsonResponse({ ok: false, error: `File is too large. Max bytes: ${maxFileBytes}` }, 413);
  }

  const defaultTtl = parseConfigInt(env.DEFAULT_TTL_SECONDS, DEFAULT_TTL_SECONDS);
  const ttlSeconds = parseOptionalInt(form.get('ttlSeconds'), defaultTtl, 1, MAX_TTL_SECONDS);
  const maxDownloads = parseNullableInt(form.get('maxDownloads'), 1, 1_000_000);
  const password = stringField(form.get('password'));

  const now = unixSeconds();
  const expiresAt = now + ttlSeconds;
  const token = randomToken();
  const filename = sanitizeFilename(fileValue.name || 'file');
  const contentType = fileValue.type || 'application/octet-stream';
  const objectKey = buildObjectKey(token, filename, new Date(now * 1000));
  const passwordHash = password ? await hashPassword(password, env) : null;

  await env.BUCKET.put(objectKey, fileValue.stream(), {
    httpMetadata: {
      contentType,
    },
    customMetadata: {
      token,
      filename,
      expiresAt: String(expiresAt),
    },
  });

  await env.DB.prepare(
    `INSERT INTO shares (
      token, object_key, filename, content_type, size, expires_at,
      max_downloads, download_count, password_hash, created_at,
      revoked_at, last_downloaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL)`,
  )
    .bind(token, objectKey, filename, contentType, fileValue.size, expiresAt, maxDownloads, passwordHash, now)
    .run();

  if (env.SHARE_CACHE && ttlSeconds >= 60) {
    await env.SHARE_CACHE.put(
      `share:${token}`,
      JSON.stringify({ token, objectKey, filename, contentType, size: fileValue.size, expiresAt }),
      { expirationTtl: ttlSeconds },
    );
  }

  const baseUrl = getBaseUrl(request, env);
  const response: UploadResponse = {
    ok: true,
    token,
    url: `${baseUrl}/s/${token}`,
    objectKey,
    filename,
    size: fileValue.size,
    expiresAt,
    maxDownloads,
    passwordProtected: Boolean(passwordHash),
  };

  return jsonResponse(response, 201);
}

async function listShares(url: URL, env: Env): Promise<Response> {
  const limit = parseOptionalInt(url.searchParams.get('limit'), 50, 1, 200);
  const result = await env.DB.prepare(
    `SELECT token, object_key, filename, content_type, size, expires_at,
      max_downloads, download_count, password_hash, created_at,
      revoked_at, last_downloaded_at
     FROM shares
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<ShareRecord>();

  const shares = (result.results ?? []).map((share) => ({
    token: share.token,
    filename: share.filename,
    contentType: share.content_type,
    size: share.size,
    expiresAt: share.expires_at,
    maxDownloads: share.max_downloads,
    downloadCount: share.download_count,
    createdAt: share.created_at,
    revokedAt: share.revoked_at,
    lastDownloadedAt: share.last_downloaded_at,
    passwordProtected: Boolean(share.password_hash),
  }));

  return jsonResponse({ ok: true, shares });
}

async function revokeShare(token: string, url: URL, env: Env): Promise<Response> {
  if (!TOKEN_PATTERN.test(token)) {
    return jsonResponse({ ok: false, error: 'Invalid token' }, 400);
  }

  const record = await getShare(token, env);
  if (!record) {
    return jsonResponse({ ok: false, error: 'Share not found' }, 404);
  }

  const now = unixSeconds();
  await env.DB.prepare('UPDATE shares SET revoked_at = ? WHERE token = ?').bind(now, token).run();
  await env.SHARE_CACHE?.delete(`share:${token}`);

  const deleteObject = url.searchParams.get('deleteObject') === '1';
  if (deleteObject) {
    await env.BUCKET.delete(record.object_key);
  }

  return jsonResponse({ ok: true, token, revokedAt: now, objectDeleted: deleteObject });
}

async function handleShareDownload(request: Request, token: string, env: Env): Promise<Response> {
  if (!TOKEN_PATTERN.test(token)) {
    return htmlResponse(renderMessagePage('链接无效', '分享链接格式不正确。'), 404);
  }

  const record = await getShare(token, env);
  const now = unixSeconds();

  if (!record) {
    return htmlResponse(renderMessagePage('链接不存在', '这个分享链接不存在或已经被清理。'), 404);
  }

  const unavailable = getUnavailableReason(record, now);
  if (unavailable) {
    return htmlResponse(renderMessagePage('链接不可用', unavailable), 410);
  }

  if (record.password_hash) {
    const password = await readPassword(request);
    if (!password) {
      return htmlResponse(renderPasswordPage(token));
    }

    const inputHash = await hashPassword(password, env);
    if (!constantTimeEqual(inputHash, record.password_hash)) {
      return htmlResponse(renderPasswordPage(token, '密码不正确。'), 403);
    }
  }

  const update = await env.DB.prepare(
    `UPDATE shares
     SET download_count = download_count + 1, last_downloaded_at = ?
     WHERE token = ?
       AND revoked_at IS NULL
       AND expires_at > ?
       AND (max_downloads IS NULL OR download_count < max_downloads)`,
  )
    .bind(now, token, now)
    .run();

  const changes = Number((update.meta as { changes?: number } | undefined)?.changes ?? 0);
  if (changes < 1) {
    return htmlResponse(renderMessagePage('链接不可用', '这个分享链接已经过期或超过下载次数。'), 410);
  }

  const object = await env.BUCKET.get(record.object_key);
  if (!object) {
    return htmlResponse(renderMessagePage('文件不存在', '文件对象不存在，可能已经被清理。'), 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, no-store');
  headers.set('content-type', record.content_type || 'application/octet-stream');
  headers.set('content-disposition', contentDisposition(record.filename));

  return new Response(object.body, { headers });
}

async function cleanupExpiredShares(env: Env): Promise<void> {
  const now = unixSeconds();
  const result = await env.DB.prepare(
    `SELECT token, object_key
     FROM shares
     WHERE expires_at <= ? OR revoked_at IS NOT NULL
     LIMIT 100`,
  )
    .bind(now)
    .all<{ token: string; object_key: string }>();

  for (const row of result.results ?? []) {
    await env.BUCKET.delete(row.object_key);
    await env.DB.prepare('DELETE FROM shares WHERE token = ?').bind(row.token).run();
    await env.SHARE_CACHE?.delete(`share:${row.token}`);
  }
}

async function getShare(token: string, env: Env): Promise<ShareRecord | null> {
  return env.DB.prepare(
    `SELECT token, object_key, filename, content_type, size, expires_at,
      max_downloads, download_count, password_hash, created_at,
      revoked_at, last_downloaded_at
     FROM shares
     WHERE token = ?`,
  )
    .bind(token)
    .first<ShareRecord>();
}

function requireAdmin(request: Request, env: Env): Response | null {
  const auth = request.headers.get('authorization') ?? '';
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }
  return null;
}

async function readPassword(request: Request): Promise<string | null> {
  const headerPassword = request.headers.get('x-share-password');
  if (headerPassword) return headerPassword;

  if (request.method !== 'POST') return null;

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('form')) return null;

  const form = await request.formData();
  return stringField(form.get('password'));
}

function getUnavailableReason(record: ShareRecord, now: number): string | null {
  if (record.revoked_at !== null) return '这个分享链接已经被撤销。';
  if (record.expires_at <= now) return '这个分享链接已经过期。';
  if (record.max_downloads !== null && record.download_count >= record.max_downloads) {
    return '这个分享链接已经达到最大下载次数。';
  }
  return null;
}

function jsonResponse<T extends UploadResponse | ErrorResponse | Record<string, unknown>>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(),
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-share-password',
  };
}

function parseConfigInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalInt(value: FormDataEntryValue | string | null, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function parseNullableInt(value: FormDataEntryValue | null, min: number, max: number): number | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function stringField(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomToken(bytes = 18): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  let binary = '';
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'file';
}

function buildObjectKey(token: string, filename: string, date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `tmp/${yyyy}/${mm}/${dd}/${token}/${filename}`;
}

function getBaseUrl(request: Request, env: Env): string {
  const configured = env.SHARE_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return new URL(request.url).origin;
}

function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function hashPassword(password: string, env: Env): Promise<string> {
  const pepper = env.PASSWORD_PEPPER || env.ADMIN_TOKEN || 'files-sharing';
  const data = new TextEncoder().encode(`${pepper}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
