import http from "node:http"
import { readFile } from "node:fs/promises"
import { existsSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { onlineCounterMiddleware } from "./online-counter.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, "dist")
const port = parseInt(process.env.PORT || "8443", 10)

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
}

const server = http.createServer((req, res) => {
  onlineCounterMiddleware(req, res, async () => {
    try {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0])
      if (urlPath === "/") urlPath = "/index.html"

      let filePath = path.normalize(path.join(distDir, urlPath))
      if (!filePath.startsWith(distDir)) {
        res.writeHead(403)
        res.end("Forbidden")
        return
      }

      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = path.join(distDir, "index.html")
      }

      const content = await readFile(filePath)
      res.writeHead(200, {
        "Content-Type":
          MIME[path.extname(filePath).toLowerCase()] ||
          "application/octet-stream",
        "Cache-Control":
          path.extname(filePath) === ".html"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
      })
      res.end(content)
    } catch {
      res.writeHead(500)
      res.end("Internal Server Error")
    }
  })
})

server.listen(port, "0.0.0.0", () => {
  console.log(`Bageecha running on http://0.0.0.0:${port}`)
})
