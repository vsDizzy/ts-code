// Live reload client: reloads on file changes and server restarts.
;(() => {
  const source = new EventSource(document.currentScript.src.replace(/\.js$/, ''))
  let bootId

  // A new boot id after reconnect means the server restarted.
  source.addEventListener('hello', (e) => {
    if (bootId && bootId !== e.data) location.reload()
    bootId = e.data
  })

  source.addEventListener('reload', (e) => {
    console.info('[livereload] changed:', JSON.parse(e.data))
    location.reload()
  })
})()
