// Shared plumbing for handlers that turn a source file into something else
// (TypeScript -> JS, etc.): fetch the source, transform it, cache the output.
//
// The output is revalidated against the server on every request using the
// source's validators (If-None-Match / If-Modified-Since). On 304 the cached
// output is served without transforming again. Errors are cached the same way:
// same source + same settings = same errors.

/**
 * @typedef {{ body: string, contentType: string } | { error: string }} TransformResult
 *
 * @param {object} options
 * @param {URL} options.url Source URL.
 * @param {string} options.cacheName Cache Storage name for the output.
 * @param {string} [options.variant] Anything else the output depends on (e.g. a
 *   hash of the compiler config); outputs for different variants are cached apart.
 * @param {(source: string) => TransformResult} options.transform
 * @returns {Promise<Response>} The output (200), the error as text/plain (500),
 *   or the server's own response if fetching the source failed (404 etc.).
 *   The `x-transform-cache: hit|miss` header tells a 304 reuse from a fresh run.
 */
export async function serveTransformed({ url, cacheName, variant, transform }) {
  const key = new URL(url)
  if (variant) key.searchParams.set('__variant', variant)

  const cache = await caches.open(cacheName)
  const cached = await cache.match(key)

  // Manual conditional headers + no-store: the HTTP cache stays out of it and
  // the server's 304 reaches us as is.
  const headers = new Headers()
  const etag = cached?.headers.get('x-source-etag')
  const lastModified = cached?.headers.get('x-source-last-modified')
  if (etag) headers.set('if-none-match', etag)
  if (lastModified) headers.set('if-modified-since', lastModified)
  const source = await fetch(url, { headers, cache: 'no-store' })

  if (source.status === 304 && cached) {
    const hit = new Headers(cached.headers)
    hit.set('x-transform-cache', 'hit')
    return new Response(cached.body, { status: cached.status, headers: hit })
  }
  if (!source.ok) return source

  const result = transform(await source.text())
  const ok = !('error' in result)
  if (!ok) console.error(`[sw] ${url.pathname}:\n${result.error}`)

  const response = new Response(ok ? result.body : result.error, {
    status: ok ? 200 : 500,
    headers: {
      'content-type': ok ? result.contentType : 'text/plain; charset=utf-8',
      'x-source-etag': source.headers.get('etag') ?? '',
      'x-source-last-modified': source.headers.get('last-modified') ?? '',
      'x-transform-cache': 'miss',
    },
  })
  await cache.put(key, response.clone())
  return response
}

/** Short hex SHA-256 of `text`, for cache keys. */
export async function sha256(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

/** Deletes caches named `${prefix}...` except `keep` (outputs of older versions). */
export async function deleteOldCaches(prefix, keep) {
  for (const name of await caches.keys()) {
    if (name.startsWith(prefix) && name !== keep) await caches.delete(name)
  }
}
