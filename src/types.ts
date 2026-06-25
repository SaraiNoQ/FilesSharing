export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  SHARE_CACHE?: KVNamespace;
  ADMIN_TOKEN: string;
  PASSWORD_PEPPER?: string;
  SHARE_BASE_URL?: string;
  DEFAULT_TTL_SECONDS?: string;
  MAX_FILE_BYTES?: string;
}

export interface ShareRecord {
  token: string;
  object_key: string;
  filename: string;
  content_type: string;
  size: number;
  expires_at: number;
  max_downloads: number | null;
  download_count: number;
  password_hash: string | null;
  created_at: number;
  revoked_at: number | null;
  last_downloaded_at: number | null;
}

export interface UploadResponse {
  ok: true;
  token: string;
  url: string;
  objectKey: string;
  filename: string;
  size: number;
  expiresAt: number;
  maxDownloads: number | null;
  passwordProtected: boolean;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}
