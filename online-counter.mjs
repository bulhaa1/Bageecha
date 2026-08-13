const clients = new Set()
const MAX_CLIENTS = 200
const pingInterval = 25000

function broadcast() {
  const count = clients.size
  const payload = `data: ${JSON.stringify({ count })}\n\n`
  for (const client of clients) {
    try {
      client.res.write(payload)
    } catch {
      /* connection already closed */
    }
  }
}

export function onlineCounterMiddleware(req, res, next) {
  const pathname = req.url?.split("?")[0] ?? ""

  // Match the endpoint at the site root or behind a base path
  // (e.g. /Bageecha/api/online in dev/preview deployments).
  if (!pathname.endsWith("/api/online")) return next()

  // Reject before writing any headers: calling writeHead after the 200 below
  // throws ERR_HTTP_HEADERS_SENT, and a heartbeat interval created earlier
  // would leak and keep running forever.
  if (clients.size >= MAX_CLIENTS) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })

    res.end("Online counter at capacity")

    return
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
  res.flushHeaders?.()

  const client = {
    res,
    heartbeat: setInterval(() => {
      try {
        res.write(": ping\n\n")
      } catch {
        /* ignore */
      }
    }, pingInterval),
  }

  clients.add(client)
  broadcast()

  req.on("close", () => {
    clearInterval(client.heartbeat)
    clients.delete(client)
    broadcast()
  })
}
