#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

function printUsage() {
  console.error(`Usage:
  node scripts/upload.mjs <file> --endpoint <url> --token <admin-token> [--ttl 86400] [--max-downloads 5] [--password secret]

Examples:
  node scripts/upload.mjs ./demo.pdf --endpoint http://localhost:8787 --token "$ADMIN_TOKEN"
  node scripts/upload.mjs ./demo.pdf --endpoint https://files.example.com --token "$ADMIN_TOKEN" --ttl 3600 --max-downloads 2
`);
}

function parseArgs(argv) {
  const args = { file: null, endpoint: null, token: null, ttl: null, maxDownloads: null, password: null };
  const rest = [...argv];
  args.file = rest.shift() ?? null;

  while (rest.length > 0) {
    const key = rest.shift();
    const value = rest.shift();
    if (!key || !value) throw new Error(`Missing value for ${key}`);

    switch (key) {
      case '--endpoint':
        args.endpoint = value;
        break;
      case '--token':
        args.token = value;
        break;
      case '--ttl':
        args.ttl = value;
        break;
      case '--max-downloads':
        args.maxDownloads = value;
        break;
      case '--password':
        args.password = value;
        break;
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }

  if (!args.file || !args.endpoint || !args.token) {
    printUsage();
    process.exit(1);
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = resolve(args.file);
  const fileBuffer = await readFile(filePath);
  const form = new FormData();

  form.append('file', new Blob([fileBuffer]), basename(filePath));
  if (args.ttl) form.append('ttlSeconds', args.ttl);
  if (args.maxDownloads) form.append('maxDownloads', args.maxDownloads);
  if (args.password) form.append('password', args.password);

  const endpoint = args.endpoint.replace(/\/$/, '');
  const response = await fetch(`${endpoint}/api/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.token}`,
    },
    body: form,
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
