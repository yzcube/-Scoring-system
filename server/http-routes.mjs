import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export function parseRequestUrl(requestUrl) {
  return new URL(requestUrl || "/", "http://localhost");
}

export function createHttpRoutes({ distDir, maxRequestBodyBytes, HttpError, ContestControlError, logAudit }) {
  function sendJson(response, status, payload) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(payload));
  }

  function sendBinary(response, status, payload, { contentType = "application/octet-stream", filename = "download.bin" } = {}) {
    const content = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const asciiFilename = String(filename).replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_") || "download.bin";
    const encodedFilename = encodeURIComponent(String(filename)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    response.writeHead(status, {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
      "Content-Length": content.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  }

  function sendApiError(response, error, audit) {
    if (error instanceof HttpError || error instanceof ContestControlError) {
      sendJson(response, error.status, { ok: false, error: error.message });
      return;
    }
    logAudit("error", "api_internal_error", {
      requestId: audit?.requestId,
      method: audit?.method,
      path: audit?.path,
      action: audit?.action,
      actor: audit?.actor,
      error,
    });
    sendJson(response, 500, { ok: false, error: "服务器内部错误" });
  }

  async function readJsonBody(request) {
    let body = "";
    let receivedBytes = 0;
    for await (const chunk of request) {
      receivedBytes += chunk.length ?? Buffer.byteLength(String(chunk));
      if (receivedBytes > maxRequestBodyBytes) throw new HttpError(413, "请求数据过大");
      body += chunk;
    }
    if (!body) return {};
    try {
      return JSON.parse(body);
    } catch {
      throw new HttpError(400, "请求数据不是合法 JSON");
    }
  }

  async function serveStatic(request, response, url) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400);
      response.end("Bad Request");
      return;
    }
    const safePath = pathname === "/" ? "/index.html" : pathname;
    const filePath = resolve(join(distDir, safePath));
    const fallbackPath = join(distDir, "index.html");
    const pathFromDist = relative(distDir, filePath);
    if (pathFromDist === ".." || pathFromDist.startsWith(`..${sep}`) || isAbsolute(pathFromDist)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    try {
      const content = await readFile(filePath);
      response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream" });
      response.end(content);
    } catch {
      const content = await readFile(fallbackPath);
      response.writeHead(200, { "Content-Type": mimeTypes[".html"] });
      response.end(content);
    }
  }

  return { readJsonBody, sendApiError, sendJson, sendBinary, serveStatic };
}
