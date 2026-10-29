import { createConnection } from "node:net";
const request = JSON.parse(await Bun.stdin.text()) as { socket: string; payload: unknown };
const socket = createConnection(request.socket);
const response = await new Promise<string>((resolve, reject) => {
    let data = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(request.payload)}\n`));
    socket.on("data", (chunk) => { data += chunk.toString(); if (data.includes("\n")) resolve(data.slice(0, data.indexOf("\n"))); });
    socket.on("error", reject);
});
socket.destroy();
console.log(response);
