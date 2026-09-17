import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 临时数据库测试专用的工作区根目录。
 *
 * 为什么必须显式给：`harness-config.ts` 里的
 * assertWorkspaceRootMatchesDatabaseLifetime 会在「数据库临时 / 工作区持久」
 * 或反过来的组合上直接拒绝启动。那条断言来自一次真实事故——测试把数据库
 * 放在内存或临时目录，却让 `HARNESS_WORKSPACE_ROOT` 回落到仓库里的
 * `./data/workspaces`，于是每次跑测试都往仓库写一批工作空间目录；进程退出
 * 后库连同归属记录一起消失，这些目录再没有任何记录引用，累计留下 1339 个
 * 无主空目录。
 *
 * 每次调用都返回一个**全新的**临时目录，顺带带来两个好处：
 * - 同一个测试文件里的多个用例不会共用目录，避免互相看到对方留下的文件；
 * - 断言失败时路径可读，排查时能直接定位到是哪个用例产生的。
 */
export function tempWorkspaceRoot(): string {
    return mkdtempSync(join(tmpdir(), "harness-test-ws-"));
}

/**
 * 展开进 loadHarnessConfig 的 env，与临时的 `HARNESS_DATABASE_PATH` 配对使用
 *（`:memory:` 或临时目录下的文件库都可以）。
 *
 *     loadHarnessConfig({
 *         VLLM_MODEL_ID: "fake-model",
 *         HARNESS_DATABASE_PATH: ":memory:",
 *         ...tempWorkspaceEnv(),
 *     })
 */
export function tempWorkspaceEnv(): { HARNESS_WORKSPACE_ROOT: string } {
    return { HARNESS_WORKSPACE_ROOT: tempWorkspaceRoot() };
}
