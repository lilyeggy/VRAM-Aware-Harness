/**
 * Runtime 层共用的异步等待工具。
 *
 * 原先 deferredTimeout / settlesWithin 在 supervised-agent-runtime 与
 * worker-process-runtime 各有一份实现（中断宽限、两级强杀阶梯都依赖
 * 它们），行为漂移风险高——这里收敛为唯一实现。
 */
export function deferredTimeout(ms: number) {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
    });
    return { promise, cancel: () => clearTimeout(timer!) };
}

/** promise 在 ms 内 settle（无论成败）返回 true，超时返回 false。 */
export async function settlesWithin(
    promise: Promise<unknown>,
    ms: number,
): Promise<boolean> {
    const timeout = deferredTimeout(ms);
    try {
        return await Promise.race([
            promise.then(() => true, () => true),
            timeout.promise.then(() => false),
        ]);
    } finally {
        timeout.cancel();
    }
}
