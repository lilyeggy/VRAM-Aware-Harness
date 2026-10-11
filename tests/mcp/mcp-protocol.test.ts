import { describe, expect, it } from "bun:test";
import { parseMcpServers, sanitizeMcpToolSegment } from "../../src/mcp/mcp-protocol.ts";

describe("parseMcpServers", () => {
    it("空值返回空数组", () => {
        expect(parseMcpServers(undefined)).toEqual([]);
        expect(parseMcpServers("   ")).toEqual([]);
    });

    it("解析合法配置", () => {
        const servers = parseMcpServers(JSON.stringify([
            {
                name: "echo",
                command: "bun",
                args: ["server.ts"],
                env: { A: "1" },
                requestTimeoutMs: 2000,
            },
        ]));
        expect(servers).toHaveLength(1);
        expect(servers[0]?.name).toBe("echo");
        expect(servers[0]?.args).toEqual(["server.ts"]);
        expect(servers[0]?.env).toEqual({ A: "1" });
        expect(servers[0]?.requestTimeoutMs).toBe(2000);
    });

    it("非法配置抛出明确错误", () => {
        expect(() => parseMcpServers("not-json")).toThrow("不是合法 JSON");
        expect(() => parseMcpServers(JSON.stringify({}))).toThrow("必须是数组");
        expect(() => parseMcpServers(JSON.stringify([{ name: "", command: "bun" }]))).toThrow("name");
        expect(() => parseMcpServers(JSON.stringify([{ name: "x", command: "" }]))).toThrow("command");
        expect(() => parseMcpServers(JSON.stringify([{ name: "x", command: "bun", args: [1] }]))).toThrow("args");
        expect(() => parseMcpServers(JSON.stringify([{ name: "x", command: "bun", env: { A: 1 } }]))).toThrow("env");
        expect(() => parseMcpServers(JSON.stringify([{ name: "x", command: "bun", requestTimeoutMs: 0 }]))).toThrow("requestTimeoutMs");
    });
});

describe("sanitizeMcpToolSegment", () => {
    it("替换非法字符并保底", () => {
        expect(sanitizeMcpToolSegment("a/b c")).toBe("a_b_c");
        expect(sanitizeMcpToolSegment("///")).toBe("___");
        expect(sanitizeMcpToolSegment("")).toBe("tool");
    });
});
