const clients = new Set()
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
  if (req.url?.split("?")[0] !== "/api/online") return next()

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
