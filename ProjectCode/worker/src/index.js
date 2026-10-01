/**
 * Public, read-only image server for the Water Sample Image Catalog.
 *
 *   GET / HEAD /<key>   the R2 object, where <key> is images.relative_path
 *                       ("<folder>/<filename>") with each segment URL-encoded
 *   ?download=1         adds Content-Disposition: attachment, so the browser
 *                       saves the file (a cross-origin <a download> is ignored)
 *   Range: bytes=...    a single byte range -> 206 Partial Content
 *   OPTIONS             CORS preflight
 *   anything else       405 -- this Worker never writes to the bucket
 */

const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';
const CACHE_CONTROL = 'public, max-age=86400';
const CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers':
    'Content-Length, Content-Range, Content-Disposition, ETag, Accept-Ranges',
};

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error(err);
      return text(500, 'Internal error');
    }
  },
};

async function handle(request, env) {
  const { method } = request;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        'Access-Control-Allow-Methods': ALLOWED_METHODS,
        'Access-Control-Allow-Headers':
          request.headers.get('Access-Control-Request-Headers') || 'Range',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return text(405, 'Method not allowed', { Allow: ALLOWED_METHODS });
  }

  const url = new URL(request.url);
  let key;
  try {
    key = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return text(400, 'Bad URL encoding');
  }
  if (!key) return text(404, 'Not found');

  if (method === 'HEAD') {
    const object = await env.IMAGES.head(key);
    if (!object) return text(404, 'Not found');
    const headers = objectHeaders(object, key, url);
    headers.set('Content-Length', String(object.size));
    return new Response(null, { status: 200, headers });
  }

  let range = parseRange(request.headers.get('Range'));
  let object;
  try {
    object = await env.IMAGES.get(key, { onlyIf: request.headers, range: range ?? undefined });
  } catch (err) {
    if (!range) throw err;
    // R2 rejects ranges that run past the end of the file; clamp to the real
    // size and retry, or answer 416 if the range starts beyond the end.
    const head = await env.IMAGES.head(key);
    if (!head) return text(404, 'Not found');
    range = resolveRange(range, head.size);
    if (range.length <= 0) return rangeNotSatisfiable(head.size);
    object = await env.IMAGES.get(key, { onlyIf: request.headers, range });
  }
  if (!object) return text(404, 'Not found');

  const headers = objectHeaders(object, key, url);
  if (!('body' in object)) {
    // A conditional header failed: If-None-Match / If-Modified-Since mean the
    // browser's copy is current (304); If-Match / If-Unmodified-Since don't hold (412).
    const notModified =
      request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since');
    return new Response(null, { status: notModified ? 304 : 412, headers });
  }

  if (range) {
    const { offset, length } = resolveRange(range, object.size);
    if (length <= 0) return rangeNotSatisfiable(object.size);
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

function objectHeaders(object, key, url) {
  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata(headers); // Content-Type stored at upload
  if (!headers.has('Content-Type')) headers.set('Content-Type', contentTypeFor(key));
  headers.set('ETag', object.httpEtag);
  headers.set('Last-Modified', object.uploaded.toUTCString());
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (url.searchParams.get('download') === '1') {
    headers.set('Content-Disposition', attachment(key.split('/').pop()));
  }
  return headers;
}

function contentTypeFor(key) {
  const ext = key.split('.').pop().toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

// Plain filename for old browsers plus an RFC 5987 UTF-8 version for the rest.
function attachment(filename) {
  const plain = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

// One range only: "bytes=start-end", "bytes=start-" or "bytes=-suffix".
// Anything else is ignored and the whole file is sent, as HTTP allows.
function parseRange(header) {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    return suffix > 0 ? { suffix } : null;
  }
  const offset = Number(match[1]);
  if (match[2] === '') return { offset };
  const end = Number(match[2]);
  return end >= offset ? { offset, length: end - offset + 1 } : null;
}

// Turn an R2 range into concrete bytes, clamped to the object's size.
function resolveRange(range, size) {
  if (range.suffix != null) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  const length = Math.min(range.length ?? size - offset, size - offset);
  return { offset, length };
}

function rangeNotSatisfiable(size) {
  return text(416, 'Range not satisfiable', { 'Content-Range': `bytes */${size}` });
}

function text(status, message, extraHeaders = {}) {
  return new Response(message + '\n', {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders },
  });
}
