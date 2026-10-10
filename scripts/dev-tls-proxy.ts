/**
 * 开发/真机 smoke 用的临时 TLS 反向代理。
 *
 * 生产请用 Caddy/Nginx（deploy/harness-caddy.example / deploy/harness-nginx.example）。
 * 这个脚本只用于没有 Caddy/Nginx、又想验证 HTTPS → Master → Broker → microVM 全链路的场景。
 *
 * 环境变量：
 *   TLS_PROXY_PORT（默认 8443）
 *   TLS_PROXY_UPSTREAM（默认 http://127.0.0.1:3100）
 *   TLS_PROXY_CERT / TLS_PROXY_KEY（必填，PEM 路径）
 *
 * 生成自签证书（仅测试）：
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
 *     -keyout /tmp/harness-tls/key.pem -out /tmp/harness-tls/cert.pem \
 *     -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"
 */

const port = Number(process.env.TLS_PROXY_PORT ?? "8443");
const upstream = (process.env.TLS_PROXY_UPSTREAM ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const certPath = process.env.TLS_PROXY_CERT ?? "";
const keyPath = process.env.TLS_PROXY_KEY ?? "";

if (!certPath || !keyPath) {
    throw new Error("必须设置 TLS_PROXY_CERT 与 TLS_PROXY_KEY（PEM 路径）");
}
if (Number.isInteger(port) === false || port <= 0 || port > 65535) {
    throw new Error("TLS_PROXY_PORT 必须是 1-65535 的整数: " + process.env.TLS_PROXY_PORT);
}

const cert = await Bun.file(certPath).text();
const key = await Bun.file(keyPath).text();

const server = Bun.serve({
    port,
    hostname: process.env.TLS_PROXY_HOST ?? "127.0.0.1",
    tls: { cert, key },
    async fetch(request) {
        const url = new URL(request.url);
        const target = upstream + url.pathname + url.search;
        const headers = new Headers(request.headers);
        headers.set("x-forwarded-proto", "https");
        headers.set("x-forwarded-host", url.host);

        const init: RequestInit = { method: request.method, headers, redirect: "manual" };
        if (request.method !== "GET" && request.method !== "HEAD") {
            init.body = await request.arrayBuffer();
        }

        const response = await fetch(target, init);
        const out = new Headers(response.headers);
        // Bun 会自动解压；避免把上游的压缩/长度头原样带回浏览器。
        out.delete("content-encoding");
        out.delete("content-length");
        out.delete("transfer-encoding");
        return new Response(response.body, { status: response.status, headers: out });
    },
});

console.log("DEV_TLS_PROXY_OK url=https://" + (process.env.TLS_PROXY_HOST ?? "127.0.0.1") + ":" + server.port + " upstream=" + upstream);
