// A local stand-in for Tailscale Serve: terminates TLS with a throwaway
// self-signed certificate and forwards HTTP and WebSocket traffic to the gateway.
//   node tls-front.mjs <listen-port> <gateway-port> <dir-for-cert>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";

const [listenPort, gatewayPort, dir] = process.argv.slice(2);
const key = join(dir, "front-key.pem");
const cert = join(dir, "front-cert.pem");
if (!existsSync(cert)) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
}
const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const upstream = http.request({ host: "127.0.0.1", port: gatewayPort, method: req.method, path: req.url, headers: req.headers }, (reply) => {
    res.writeHead(reply.statusCode, reply.rawHeaders);
    reply.pipe(res);
  });
  upstream.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(gatewayPort, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => { socket.destroy(); upstream.destroy(); };
  upstream.on("error", close);
  socket.on("error", close);
});
server.listen(Number(listenPort), "127.0.0.1", () => console.log(`tls-front https://127.0.0.1:${listenPort} -> 127.0.0.1:${gatewayPort}`));
