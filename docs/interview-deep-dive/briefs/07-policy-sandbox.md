# Module 7: 五层策略交集与 runsc 沙箱（深挖⑤）

## Teaching Arc
- **Metaphor:** 出国签证的联审。你能不能入境，不是某一关说了算——护照签发国（PLATFORM）、目的地移民局（TENANT）、航司规定（TEMPLATE）、入境卡（WORKSPACE）、本次行程（RUN）五方条件取**交集**：任何一方说不行，你就是不行。交集结果当场盖章封存（不可变快照），边检（沙箱）只认章不认人。
- **Opening hook:** 平台说允许联网、租户说禁止、模板说工具只有 read——最终这个 Run 能用什么？答案是先算交集，再把交集编译成 docker 命令行参数。
- **Key insight:** 策略是"计算出来的快照"而不是"查询出来的配置"：computeEffectivePolicy 把五层约束做交集运算，产出不可变 EffectivePolicySnapshot；Attempt 从创建起就绑定它——即使后续启动失败，拒绝记录也能完整解释。
- **Why should I care:** "策略怎么落地到容器"是把控制面和基础设施缝合的关键问题，也是本项目区别于"调 API 玩具"的核心深度。

## Code Snippets (pre-extracted)

### Snippet A — 交集算法核心（src/policies/effective-policy.ts）
```typescript
function intersectConstraints(
    left: PolicyConstraints,
    right: PolicyConstraints,
): PolicyConstraints {
    return {
        sandboxProfile: intersectSandboxProfiles(
            left.sandboxProfile ?? null,
            right.sandboxProfile ?? null,
        ),
        allowedTools: intersectValues(left.allowedTools, right.allowedTools),
        allowedSkills: intersectValues(left.allowedSkills, right.allowedSkills),
        allowedModels: intersectValues(left.allowedModels, right.allowedModels),
        workspaceRoots: intersectRoots(left.workspaceRoots, right.workspaceRoots),
        allowNetwork: left.allowNetwork && right.allowNetwork,
        allowProcess: left.allowProcess && right.allowProcess,
        allowedSecrets: intersectValues(left.allowedSecrets, right.allowedSecrets),
        resourceLimits: {
            cpuCores: minimum(left.resourceLimits.cpuCores, right.resourceLimits.cpuCores),
            memoryMiB: minimum(left.resourceLimits.memoryMiB, right.resourceLimits.memoryMiB),
            diskMiB: minimum(left.resourceLimits.diskMiB, right.resourceLimits.diskMiB),
        },
    };
}
```
讲解点：布尔权限 AND；列表取交集；资源上限取 min；workspaceRoots 取路径包含关系的并集收窄；sandboxProfile 冲突直接抛错（不允许含糊）。computeEffectivePolicy 先校验五层 PLATFORM/TENANT/TEMPLATE/WORKSPACE/RUN 缺一不可。

### Snippet B — OCI 编译产物（src/sandbox/oci-sandbox-spec.ts compile 的 args 节选）
```typescript
        const args: string[] = [
            "run", "--detach", "--rm", "--name", name,
            "--user", `${this.config.userId}:${this.config.userId}`,
            "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--pids-limit", "128",
            "--workdir", "/workspace", "--mount",
            `type=bind,src=${workspacePath},dst=/workspace`,
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
            "--network", networkMode === "none" ? "none" : "bridge",
        ];
```
逐条讲解（badge-list 形式）：`--user 65532` 非 root UID；`--read-only` 只读 RootFS；`--cap-drop ALL` 丢弃全部 Linux capabilities；`no-new-privileges` 禁止提权；`--pids-limit 128` 防 fork 炸弹；bind mount 只挂 workspace；tmpfs noexec+nosuid 64MB；默认 `--network none`。
前置守卫：diskMiB 非空直接抛错（"Container bind mount 无法强制磁盘配额，拒绝执行"）；restricted-egress + allowNetwork 抛错（尚未接入 egress proxy）。

### Snippet C — Secret 标记替换（同文件 + provider）
```typescript
        for (const name of secretNames) {
            // The caller replaces this marker with a value in the short-lived
            // Docker argv. It cannot accidentally be persisted as evidence.
            args.push("--env", `${name}=__HARNESS_SECRET_${name}__`);
        }
```
配合 ContainerSandboxProvider.withSecretValues：argv 组装时才把 `__HARNESS_SECRET_X__` 替换为真实值；Secret 值永不进入不可变 spec 或 runtime evidence；错误输出经 redact() 正则脱敏（`ENV_NAME=[REDACTED]`）。

### Snippet D — runtime evidence：声称 ≠ 事实（src/sandbox/container-sandbox-provider.ts create 节选）
```typescript
        const verifiedEvidence = await this.adapter.verify(
            this.commands, this.docker, `agent-harness-${input.id}`,
        );
        if (!verifiedEvidence.verified) {
            await this.commands.run([this.docker, "rm", "--force", `agent-harness-${input.id}`]);
            const reason = verifiedEvidence.verificationReason
                ?? `实际 runtime 不是 ${this.runtime}`;
            const failed = {
                ...record, status: "FAILED" as const, updatedAt: new Date().toISOString(),
                failureReason: reason, runtimeEvidence: freezeRuntimeEvidence(verifiedEvidence),
            };
            this.store.update(failed, "PROVISIONING");
            this.emit(failed, "FAILED", reason);
            throw new Error(`Sandbox runtime 证据校验失败：${reason}`);
        }
```
讲解点：创建后用 `docker inspect` 验证实际 runtime 是否真是 runsc；不是就删容器、记 FAILED、抛错。"OCI 兼容镜像不能证明哪个内核/runtime 执行了它"。default/restricted-egress profile 构造函数里就禁止 runc 回退。

### Snippet E — ManagedAgentRuntime.execute 关键顺序（src/runtime/managed-agent-runtime.ts 注释原文+流程）
```typescript
        // Attempt 从创建时就绑定不可变策略快照。这样即使能力校验、策略编译或
        // Sandbox 创建在真正启动 Runtime 前失败，拒绝记录仍可完整解释。
```
完整顺序：归属四元组校验 → computeEffectivePolicy → saveSnapshot → 创建 Attempt(PENDING) → validateRuntimeCapabilities（缺强制能力→REJECTED+编译记录 REJECTED）→ compilePiPolicy（APPLIED/DEGRADED/REJECTED 全落库）→ sandbox.create → startRunAttempt(RUNNING) → inner.start(managedRequest 带 execution context) → finally: terminate sandbox + instance 回 READY。onSandboxFailure 订阅：容器 LOST → Attempt INTERRUPTED + 发 agent_interrupted 事件 + inner.interrupt 兜底。

### Snippet F — 证据三元组（src/evidence/isolation-triple.ts 注释原文）
```typescript
 *   intent  ──compile──►  product  ──observe──►  fact
 *   policy    (specFingerprint)    runtimeEvidence
 *   fingerprint
 *
 * A run is only "as advertised" if the recorded spec really is what this
 * policy compiles to *and* the runtime actually observed matches it.
```
verifyIsolationTriple fail-closed：任何一环缺失/冲突 → consistent=false；支持 recompiledSpecFingerprint 漂移检测（策略或编译器被改过就能发现）。真机 tripleConsistent=true。

## P0.5 分级表
| 等级 | 手段 | 能防 | 不能防 |
|---|---|---|---|
| P0 | 无沙箱 | — | — |
| **P0.5 当前** | runsc gVisor + 默认 seccomp | 文件/网络/进程隔离 | 共享内核漏洞 |
| P1 | Kata/Firecracker | 独立内核 | 需 KVM、成本高 |
strict profile → UnavailableStrictSandboxProvider fail-closed（无 KVM 不假装通过）。

## 真机证据
9 项攻击 smoke 全 PASS（跨租户 Workspace/Secret、宿主路径、穿越、默认无网络、PID 上限、tmpfs noexec、kill→LOST）；runc vs runsc 冷启动 1.22x。

## Interactive Elements
- [ ] **Layer toggle / step 可视化** — 五层策略逐层叠加演示：PLATFORM(allowNetwork:true) → TENANT(allowNetwork:false) → 最终 false。用 flow-steps 或自绘卡片序列。
- [ ] **Code↔English translation ×2** — Snippet A（交集）、Snippet B（docker args）。
- [ ] **Badge list** — docker 参数逐条含义（Snippet B 后面）。
- [ ] **Quiz** — 3 题：(1) 场景：平台层 allowNetwork=true、租户层 false、模板未声明——最终？为什么用 AND 而不是 OR；(2) 为什么 diskMiB 有值就直接拒绝执行而不是忽略；(3) 为什么创建容器后还要 docker inspect 验证 runtime（答：配置声明≠实际执行，证据链要闭环）。
- [ ] **Callout** — "策略即代码"：策略不是 if-else 散落各处，而是数据（五层）→ 纯函数（交集）→ 不可变产物（快照）→ 编译目标（OCI argv），每一步可测试可审计。

## Reference Files to Read
- `references/content-philosophy.md` → 全文
- `references/gotchas.md` → 全文
- `references/interactive-elements.md` → Code↔English, Permission/Config Badges, Multiple-Choice Quizzes, Flow Diagrams, Callout Boxes, Glossary Tooltips

## Connections
- **Previous:** Module 6 的身份决定"你是谁"；本模块决定"你能做什么、在哪做"。
- **Next:** Module 8——基础闭环之上的三个差异化深化方向。
