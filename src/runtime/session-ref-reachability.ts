/**
 * N18：运行时会话引用的可达性校验。
 *
 * 背景（真机实证 R10）：Pi 的 `runtime_session_ref` 是会话 JSONL 的文件路径，
 * 而 Pi 的 `loadEntriesFromFile` 对**不存在的文件返回空数组**，
 * `SessionManager.open` 因此静默得到一个空会话——于是"恢复"悄悄变成了
 * "开一个新会话"，Run 照常 COMPLETED、日志零告警，用户却以为续上了上下文。
 * 这与"不确定副作用不得自动重放"是同一条原则：宁可拒绝，不要假装成功。
 *
 * 这里把"引用还在不在"做成恢复决策的一等输入。
 *
 * 为什么必须显式注入而不是默认开启：只有真实 Pi 运行时才把引用当文件路径，
 * demo/测试运行时用的是合成引用（如 `demo-session-<runId>`），默认开启会把
 * 它们全部误判成损坏。
 */

import { statSync } from "node:fs";

/**
 * 生成一个"会话引用是否可达"的判定函数：文件存在、是普通文件、且非空。
 *
 * 空文件同样判为不可达——它等价于"没有历史"，继续下去就是 N18 想避免的
 * 那种静默降级。
 */
export function createFileSessionRefReachability():(ref:string)=>boolean {
    return (ref:string):boolean => {
        try {
            const stat = statSync(ref);
            return stat.isFile() && stat.size > 0;
        } catch {
            // 路径不存在、无权限、父目录不可达等一律视为不可达（fail closed）。
            return false;
        }
    };
}
