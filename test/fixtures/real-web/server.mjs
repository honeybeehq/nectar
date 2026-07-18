import http from "node:http";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ fixture: "nectar-real-smoke", ok: true }));
});

server.listen(Number(process.env.PORT), "127.0.0.1", () => {
  console.log(`nectar acceptance fixture ready on ${process.env.PORT}`);
});
