# 完成度对账（Completion Status）

> 记录日期：2026-08-18。用途：面试/验收时逐条自证"哪些做完了、证据在哪、诚实边界是什么"。
> 对应 `docs/multi-tenant-agent-task-service-roadmap.zh-CN.md` 的「§9 完成定义」。

## 1. 逐条对账「完成定义」

| # | 完成定义 | 状态 | 证据位置 |
|---|---|---|---|
| 1 | 端到端：Workspace→任务→过程→结果 | ✅ 真机 | `docs/implementation-log/2026-08-p0-tenant-sandbox.zh-CN.md`（真实 Pi+外部模型+runsc HTTP 闭环，Run 事件链 COMPLETED→workspace diff→finalText） |
| 2 | Tenant 身份来自认证上下文（非客户端自报） | ✅ | `src/auth/api-credential-store.ts`、`src/http/harness-http-api.ts`（requirePrincipal：密钥→哈希→租户身份） |
| 3 | Agent 文件/Shell 操作真实发生在独立 Sandbox | ✅ 真机 | runsc + `/workspace` bind mount；`smoke:container` 非 root/只读 rootfs；端到端文件 `hello-real-pi.txt` 落盘 |
| 4 | 两租户数据/Workspace/进程/Secret/权限攻击通过 | ✅ 真机 | `scripts/container-sandbox-attack-smoke.ts` 9 项全 PASS（跨租户、宿主路径、穿越、Secret、网络、PID、tmpfs、kill→LOST） |
| 5 | 共享 GPU 压力真实改变执行、公平性可查询可复现 | ✅ 真机（2026-08-18） | `scripts/e2e-gpu-pressure.ts` + AutoDL T4 16G vLLM；120 并发→running=120 kv62→CRITICAL→QUEUE 落库；见 `docs/gpu-completion-runbook.zh-CN.md` |
| 6 | Sandbox/Agent 故障后状态/slot/副作用安全收敛 | ✅ 真机 | markLost→LOST→Attempt INTERRUPTED；slot 释放；Checkpoint 恢复不重复已完成工具；`_footer` 用例见 attack-smoke sandbox_lost |
| 7 | 用户拿到最终回答+Diff/Artifact | ✅ 真机 | workspace diff 捕获 + Artifact store + 最终文本 |
| 8 | README 明确保证/威胁模型/非目标 | ✅ | roadmap §5.3/§8/§9 + README |

## 2. 差异化三块（面试可深挖的亮点）

| 编号 | 能力 | 状态 | 证据 |
|---|---|---|---|
| C | 隔离证据闭环：spec 指纹 + 环境指纹 + fail-closed 断言 | ✅ 真机 | `src/evidence/*`、`scripts/isolation-evidence-report.ts`（真机 PASS，microVM 诚实标注 INFO） |
| A | 证据三元组：策略意图↔编译边界↔观测事实 | ✅ 真机 | `src/evidence/isolation-triple.ts`（真机 tripleConsistent=true） |
| B | 租户资源预算 + Fair-Share + 核算账本 | ✅ 真机 | `src/resources/{tenant-budget,resource-ledger,budget-aware-policy}.ts`、`scripts/server-budget-control.ts`（TENANT_BUDGET_EXCEEDED 落库） |

## 3. 质量与测试

- git 跟踪测试 **238 全绿，0 fail**（204 基底 → 证据 13 → 三元组 9 → 预算 10 → GPU 指标兼容 2）。
- 真机证据链：隔离攻击（runsc 9 项）、性能 benchmark（runc vs runsc 1.22x 冷启动）、真实 Pi 端到端、租户预算落库、真实 GPU 压力→QUEUE。

## 4. 诚实边界（陈述时不越界）

- **strict/microVM（Kata、Firecracker）**：无 KVM 环境，未实现、未声明通过（`UnavailableStrictSandboxProvider` fail-closed）。
- **显存 MiB 维度**：本机 T4 经 nvidia-smi 可读；准入走 vLLM 的 running/kv-cache 压力路径（真实），块调度与超大并发下的绝对公平份额仍属估算。
- **不是生产级**：单机、无 K8s/多机/高可用、无计费/SSO——均属 roadmap「§8 当前不做」。
- 外部 OpenAI 兼容模型的 demo 用 Fake observer 是**有意标注**，非 VRAM 证据；真机证据来自本份文档所述真实 vLLM 链路。

## 5. 结论

作为**里程碑 + 差异化 + 面试展示**：完成，且有真机背书（roadmap 完成定义 8 条全部命中/自证）。
作为**生产级产品**：未完成——但那不在本项目定义内。

Git 交付与运维：本套真机全部已推 `master`；GPU 实例使用后已停进程（实例释放需平台侧操作），ECS 控制面保持常驻，可按 `docs/gpu-completion-runbook.zh-CN.md` 随时复现。
