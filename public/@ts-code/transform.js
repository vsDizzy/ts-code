// Fetch a source, transform it, cache the output; revalidated by the source's ETag.

/**
 * @typedef {{ body: string, contentType: string } | { error: string }} TransformResult
 *
 * @param {object} options
 * @param {URL} options.url
 * @param {string} options.cacheName
 * @param {string} [options.variant] Extra cache key part, e.g. a config hash.
 * @param {(source: string) => TransformResult} options.transform
 * @returns {Promise<Response>}
 */
export async function serveTransformed({ url, cacheName, variant, transform }) {
  const key = new URL(url)
  if (variant) key.searchParams.set('__variant', variant)

  const cache = await caches.open(cacheName)
  const cached = await cache.match(key)

  const headers = new Headers()
  const etag = cached?.headers.get('x-source-etag')
  if (etag) headers.set('if-none-match', etag)
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
