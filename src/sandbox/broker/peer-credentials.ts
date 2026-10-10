import { dlopen, FFIType } from "bun:ffi";
import type { Socket } from "node:net";

/** Linux `struct ucred`（SO_PEERCRED）在用户态看到的最小字段。 */
export interface PeerCredentials {
    readonly pid: number;
    readonly uid: number;
    readonly gid: number;
}

export type PeerCredentialsReader = (socket: Socket) => PeerCredentials | null;

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
const UCRED_SIZE = 12;

type Getsockopt = (
    fd: number,
    level: number,
    option: number,
    value: Uint8Array,
    length: Int32Array,
) => number;

let cachedGetsockopt: Getsockopt | null | undefined;

function loadGetsockopt(): Getsockopt | null {
    if (cachedGetsockopt !== undefined) {
        return cachedGetsockopt;
    }
    if (process.platform !== "linux") {
        cachedGetsockopt = null;
        return null;
    }
    // glibc / musl 的 libc 名称不同；逐个尝试，全部失败则视为不支持。
    const candidates = [
        "libc.so.6",
        "libc.so",
        "libc.musl-x86_64.so.1",
        "libc.musl-aarch64.so.1",
    ];
    for (const candidate of candidates) {
        try {
            const libc = dlopen(candidate, {
                getsockopt: {
                    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
                    returns: FFIType.i32,
                },
            });
            cachedGetsockopt = libc.symbols.getsockopt as unknown as Getsockopt;
            return cachedGetsockopt;
        } catch {
            // 尝试下一个 libc 名称。
        }
    }
    cachedGetsockopt = null;
    return null;
}

function socketFd(socket: Socket): number | null {
    const handle = (socket as unknown as { _handle?: { fd?: number } })._handle;
    return typeof handle?.fd === "number" ? handle.fd : null;
}

/**
 * 读取 Unix domain socket 对端的 SO_PEERCRED（Linux）。
 * 不支持或读取失败时返回 null；调用方必须把 null 当作 fail-closed 处理。
 */
export function createPeerCredentialsReader(): PeerCredentialsReader {
    return (socket) => {
        const fd = socketFd(socket);
        if (fd === null) {
            return null;
        }
        const getsockopt = loadGetsockopt();
        if (getsockopt === null) {
            return null;
        }
        const value = new Uint8Array(UCRED_SIZE);
        const length = new Int32Array([UCRED_SIZE]);
        const result = getsockopt(fd, SOL_SOCKET, SO_PEERCRED, value, length);
        if (result !== 0 || length[0] !== UCRED_SIZE) {
            return null;
        }
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        return {
            pid: view.getInt32(0, true),
            uid: view.getUint32(4, true),
            gid: view.getUint32(8, true),
        };
    };
}

export function peerCredentialsSupported(): boolean {
    return loadGetsockopt() !== null;
}
