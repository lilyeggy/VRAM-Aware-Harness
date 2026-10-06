import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { FirecrackerVsockBridge } from "../../src/sandbox/microvm/firecracker-vsock-bridge";

describe("FirecrackerVsockBridge", () => {
    const testSocketPath = resolve(`/tmp/test-vsock-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    let server: Server | null = null;
    let serverSocket: Socket | null = null;

    beforeEach(async () => {
        if (existsSync(testSocketPath)) {
            unlinkSync(testSocketPath);
        }
    });

    afterEach(async () => {
        if (serverSocket) {
            try { serverSocket.destroy(); } catch {}
            serverSocket = null;
        }
        if (server) {
            await new Promise<void>((r) => server!.close(() => r()));
            server = null;
        }
        if (existsSync(testSocketPath)) {
            try { unlinkSync(testSocketPath); } catch {}
        }
    });

    function setupMockServer(onClientMessage?: (msg: string, socket: Socket) => void): Promise<Server> {
        return new Promise<Server>((res) => {
            const s = createServer((sock) => {
                serverSocket = sock;
                let buffer = "";

                sock.on("data", (chunk) => {
                    buffer += chunk.toString("utf8");
                    while (true) {
                        const idx = buffer.indexOf("\n");
                        if (idx === -1) break;
                        const line = buffer.slice(0, idx).trim();
                        buffer = buffer.slice(idx + 1);

                        if (line.startsWith("CONNECT")) {
                            sock.write("OK 5000\n");
                        } else {
                            try {
                                const frame = JSON.parse(line);
                                if (frame.type === "ping") {
                                    sock.write(JSON.stringify({ v: 1, type: "pong", id: frame.id }) + "\n");
                                } else if (onClientMessage) {
                                    onClientMessage(line, sock);
                                }
                            } catch {
                                // raw line
                                if (onClientMessage) onClientMessage(line, sock);
                            }
                        }
                    }
                });
            });

            s.listen(testSocketPath, () => {
                server = s;
                res(s);
            });
        });
    }

    it("握手连接成功并可发送 ping/pong 完成就绪检测", async () => {
        await setupMockServer();
        const bridge = new FirecrackerVsockBridge(testSocketPath, 5000);
        await bridge.connect();
        bridge.close();
    });

    it("行缓冲测试：半帧到达不解析、两帧粘连正确拆出两条", async () => {
        await setupMockServer((msg, sock) => {
            const req = JSON.parse(msg);
            if (req.type === "exec") {
                const id = req.id;
                // 1. 发送拆分半帧: 先发一部分
                const frame1Full = JSON.stringify({
                    v: 1,
                    type: "exec_output",
                    id,
                    stream: "stdout",
                    data: Buffer.from("hello ").toString("base64"),
                }) + "\n";

                const half1 = frame1Full.slice(0, 15);
                const half2 = frame1Full.slice(15);

                sock.write(half1);

                setTimeout(() => {
                    // 2. 发送后半段，并粘连第二帧与结果帧
                    const frame2 = JSON.stringify({
                        v: 1,
                        type: "exec_output",
                        id,
                        stream: "stdout",
                        data: Buffer.from("world!\n").toString("base64"),
                    }) + "\n";

                    const resFrame = JSON.stringify({
                        v: 1,
                        type: "exec_result",
                        id,
                        exitCode: 0,
                    }) + "\n";

                    sock.write(half2 + frame2 + resFrame);
                }, 20);
            }
        });

        const bridge = new FirecrackerVsockBridge(testSocketPath, 5000);
        await bridge.connect();

        const chunks: string[] = [];
        const result = await bridge.execute(["echo", "hello world!"], {
            onStdoutChunk: (c) => chunks.push(c),
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello world!\n");
        expect(chunks).toEqual(["hello ", "world!\n"]);

        bridge.close();
    });

    it("未知 id 帧被静默丢弃，不影响正常响应", async () => {
        await setupMockServer((msg, sock) => {
            const req = JSON.parse(msg);
            if (req.type === "exec") {
                // 注入伪造的未知 ID 帧
                sock.write(JSON.stringify({
                    v: 1,
                    type: "exec_output",
                    id: "unknown-alien-id",
                    stream: "stdout",
                    data: Buffer.from("evil").toString("base64"),
                }) + "\n");

                // 发送合法响应
                sock.write(JSON.stringify({
                    v: 1,
                    type: "exec_output",
                    id: req.id,
                    stream: "stdout",
                    data: Buffer.from("valid").toString("base64"),
                }) + "\n");

                sock.write(JSON.stringify({
                    v: 1,
                    type: "exec_result",
                    id: req.id,
                    exitCode: 0,
                }) + "\n");
            }
        });

        const bridge = new FirecrackerVsockBridge(testSocketPath, 5000);
        await bridge.connect();

        const result = await bridge.execute(["test"]);
        expect(result.stdout).toBe("valid");
        expect(result.exitCode).toBe(0);

        bridge.close();
    });

    it("伪造与重复 exec_result：宿主只接受第一个匹配 id 的 result", async () => {
        let executionCount = 0;
        await setupMockServer((msg, sock) => {
            const req = JSON.parse(msg);
            if (req.type === "exec") {
                executionCount++;
                const id = req.id;
                // 先返回 exitCode: 0
                sock.write(JSON.stringify({
                    v: 1,
                    type: "exec_result",
                    id,
                    exitCode: 0,
                }) + "\n");

                // 紧接着又返回重复的伪造结果 exitCode: 99
                sock.write(JSON.stringify({
                    v: 1,
                    type: "exec_result",
                    id,
                    exitCode: 99,
                }) + "\n");
            }
        });

        const bridge = new FirecrackerVsockBridge(testSocketPath, 5000);
        await bridge.connect();

        const result = await bridge.execute(["test"]);
        expect(result.exitCode).toBe(0);
        expect(executionCount).toBe(1);

        bridge.close();
    });

    it("支持断开后 reconnect()", async () => {
        await setupMockServer();
        const bridge = new FirecrackerVsockBridge(testSocketPath, 5000);

        await bridge.connect();
        bridge.close();

        // 重新连接
        await bridge.connect();
        bridge.close();
    });
});
