// Live reload client: listens to the server's SSE endpoint and reloads the page
// when a watched file changes or the server restarts. Served and added to HTML
// pages by the dev server (src/livereload.ts); the endpoint is this script's
// URL without ".js".
;(() => {
  const source = new EventSource(document.currentScript.src.replace(/\.js$/, ''))
  let bootId

  // Sent on every (re)connect. A different id means the server was restarted,
  // possibly with new code, so reload to pick it up.
  source.addEventListener('hello', (e) => {
    if (bootId && bootId !== e.data) location.reload()
    bootId = e.data
  })

  source.addEventListener('reload', (e) => {
    console.info('[livereload] changed:', JSON.parse(e.data))
    location.reload()
  })

  // EventSource reconnects on its own after errors; nothing else to do here.
})()
