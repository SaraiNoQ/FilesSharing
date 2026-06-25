function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FilesSharing</title>
  <style>
    :root { color-scheme: light dark; }
    body { max-width: 880px; margin: 48px auto; padding: 0 20px; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; }
    h1 { margin-bottom: 4px; }
    .muted { color: #666; }
    form, .panel { border: 1px solid #ddd; border-radius: 14px; padding: 20px; margin: 20px 0; }
    label { display: block; margin: 12px 0 6px; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px; border: 1px solid #bbb; }
    button { margin-top: 16px; padding: 10px 14px; border-radius: 10px; border: 1px solid #888; cursor: pointer; }
    code, pre { white-space: pre-wrap; word-break: break-all; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 720px) { .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>FilesSharing</h1>
  <p class="muted">R2 私有对象存储 + Worker 分享网关 + D1 元数据。</p>

  <form id="uploadForm">
    <label>Admin Token</label>
    <input id="token" type="password" placeholder="Authorization Bearer token" required />

    <label>File</label>
    <input id="file" name="file" type="file" required />

    <div class="row">
      <div>
        <label>TTL Seconds</label>
        <input id="ttlSeconds" name="ttlSeconds" type="number" min="1" value="86400" />
      </div>
      <div>
        <label>Max Downloads</label>
        <input id="maxDownloads" name="maxDownloads" type="number" min="1" placeholder="empty means unlimited" />
      </div>
    </div>

    <label>Password Optional</label>
    <input id="password" name="password" type="password" placeholder="optional share password" />

    <button type="submit">Upload and Create Share</button>
  </form>

  <div class="panel">
    <strong>Result</strong>
    <pre id="result">No upload yet.</pre>
  </div>

  <script>
    const form = document.querySelector('#uploadForm');
    const result = document.querySelector('#result');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      result.textContent = 'Uploading...';

      const data = new FormData();
      data.append('file', document.querySelector('#file').files[0]);
      data.append('ttlSeconds', document.querySelector('#ttlSeconds').value || '86400');
      const maxDownloads = document.querySelector('#maxDownloads').value;
      if (maxDownloads) data.append('maxDownloads', maxDownloads);
      const password = document.querySelector('#password').value;
      if (password) data.append('password', password);

      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + document.querySelector('#token').value },
        body: data,
      });

      const json = await response.json();
      result.textContent = JSON.stringify(json, null, 2);
    });
  </script>
</body>
</html>`;
}

export function renderPasswordPage(token: string, error?: string): string {
  const safeToken = escapeHtml(token);
  const safeError = error ? `<p style="color:#b00020">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Password Required</title>
  <style>
    :root { color-scheme: light dark; }
    body { max-width: 560px; margin: 80px auto; padding: 0 20px; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; }
    form { border: 1px solid #ddd; border-radius: 14px; padding: 20px; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px; border: 1px solid #bbb; }
    button { margin-top: 16px; padding: 10px 14px; border-radius: 10px; border: 1px solid #888; cursor: pointer; }
  </style>
</head>
<body>
  <h1>需要密码</h1>
  <p>这个分享链接设置了访问密码。</p>
  ${safeError}
  <form method="post" action="/s/${safeToken}">
    <input name="password" type="password" placeholder="Password" autofocus required />
    <button type="submit">下载文件</button>
  </form>
</body>
</html>`;
}

export function renderMessagePage(title: string, message: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { max-width: 640px; margin: 80px auto; padding: 0 20px; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}
