import { createHash } from "node:crypto";
import http from "node:http";

function frame(payload) {
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, payload]);
}

function unmask(buffer) {
  let length = buffer[1] & 127;
  let offset = 2;
  if (length === 126) {
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  const mask = buffer.subarray(offset, offset + 4);
  const data = buffer.subarray(offset + 4, offset + 4 + length);
  return { opcode: buffer[0] & 15, payload: Buffer.from(data.map((byte, index) => byte ^ mask[index % 4])) };
}

const server = http.createServer((request, response) => {
  if (request.url === "/stream") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      response.write(`data: tick ${count}\n\n`);
      if (count === 3) {
        clearInterval(timer);
        response.end();
      }
    }, 200);
    return;
  }
  if (request.method === "POST") {
    const hash = createHash("sha256");
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ size, sha256: hash.digest("hex") }));
    });
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>ws fixture</title><h1>Hello from ${process.env.NECTAR_ENV ?? "ws fixture"}</h1>`);
});

server.on("upgrade", (request, socket) => {
  const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on("data", (buffer) => {
    const { opcode, payload } = unmask(buffer);
    if (opcode === 8) {
      socket.end(Buffer.from([0x88, 0]));
      return;
    }
    if (opcode === 1) socket.write(frame(Buffer.from(`echo: ${payload.toString()}`)));
  });
  socket.on("error", () => socket.destroy());
});

server.listen(Number(process.env.PORT ?? 4100), "127.0.0.1");
