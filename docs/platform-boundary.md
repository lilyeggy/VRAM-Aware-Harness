# 个人版多租户 Agent 任务服务：定位与系统边界（v1.2；个人项目裁剪定档）

> 本文档是项目的**唯一权威边界定义**；个人项目裁剪边界见 §9。实现、评审、测试以此为对齐基准；
> 与本文件冲突的代码视为缺陷。实现完成后更新 README 指向本文。
>
> 定档结论（2026-10-10 个人项目裁剪；详见 §9）：
> - 产品形态：**个人版多租户 Agent 任务服务**——每任务一台 ephemeral microVM，不做 Grok/Manus 式完整平台；
> - 部署形态：单台 Linux + KVM，systemd 管理，SQLite 本地持久化；不做多节点、高可用、公网 SaaS 与计费结算；
> - 模型推理：外部 OpenAI 兼容服务（opencode-go / 自建 vLLM 等）；平台不承载模型、不做路由、不做显存调度；
> - Agent 运行时：沿用 Pi；Agent 无网络权限，工具执行进 jailer + Firecracker microVM。

---

## 1. 产品一句话

为个人 / 小团队提供一个多租户 Agent 任务服务：每个任务（Run）获得一台**临时的、硬件隔离的虚拟机**作为执行环境，Agent（Pi）在其中跑代码、操作文件，产出文件与结果，任务结束虚拟机即销毁。

对标参考：Manus 的 ephemeral 任务沙箱形态；不追求 Grok/Devin 式完整云桌面。

---

## 2. 核心模型

```
用户 (User)
 └── 租户 (Tenant)          —— 与 user 1:1（私有部署，注册即租户）
      ├── 工作区 (Workspace) —— 持久文件归属地，租户可见
      ├── 会话 (Session)    —— 对话上下文容器
      │    └── 任务 (Run)   —— 一次执行
      │         └── 沙箱 VM —— ephemeral，随 Run 生灭 ★隔离单元
      └── Secret            —— 租户命名空间下的凭据
```

**关键约束：隔离单元是 Run 级 VM，不是用户级常驻 VM。** 同一用户的多个任务获得各自独立的 VM；持久性由"工作区"提供，而不是由"VM 常驻"提供。VM 是消耗品，工作区是资产。

---

## 3. 八条系统边界（本项目的"宪法"）

### B1 隔离边界：硬件虚拟化，fail-closed
- 每个 Run 一台独立 Firecracker microVM，独立 Guest 内核；guest 内 root 不构成越权。
- 任何无法验证隔离成立的链路必须拒绝执行（Phase 0 已落实），**禁止**静默降级到宿主或容器执行。
- 例外：显式的 `development` profile（单租户本地开发），且该 profile 在多租户部署中禁用。

### B2 网络边界：VM 一律无网卡（2026-10-06 定档）
- **MicroVM 不提供网卡服务**：guest 内不存在任何网络设备（不挂 `network-interfaces`、不建 netns/tap）。
- `allowNetwork=true` 的请求在 Provider 与驱动两层都被 **fail-closed 拒绝**，且拒绝发生在创建 VM 之前（不留下实例、记录）。
- 因此不存在"内网可达 / 元数据可达 / DNS 重绑定 / 白名单绕过"这类攻击面——它们随网卡一起不存在。
- **代价与补偿**：VM 内的 agent 无法自主访问任何网络服务（含 LLM 网关）。宿主能力必须经 **vsock 受控通道**或本地套接字转发提供（该通道为后续设计项，尚未实现）。
- 容器链路（runsc）的 `restricted-egress` 能力不受本边界约束，仅约束 microVM strict 档。

### B3 凭据边界：Secret 最小注入
- Secret 按租户命名空间解析；只有策略显式允许的 Secret 注入 VM；宿主凭据（vLLM key、平台 master key）**永不**进 VM（已有测试保障）。
- Secret 值不落盘、不入库、不出现在日志与审计（只记名称）。

### B4 认证与权限边界：凭据即身份
- 用户经邮箱+密码登录获得会话 token；API key 按租户绑定；tenantId 只允许来自凭据，**禁止**客户端自报（已有实现）。
- 用户会话 scope 当前为 `["*"]`——属已知债务，私有化部署可接受，公开化前必须细化。

### B5 资源边界：限额强制、租户公平
- 每 VM 的 CPU/内存由宿主侧 cgroup 强制（VM 外侧，guest root 改不了）。
- 租户并发、全局并发、排队 TTL、调度老化已有（`run-scheduler`/`tenant-run-scheduler`），microVM 路径必须接入同一套准入。
- 磁盘：每 Run 工作区盘有上限；平台总配额（租户存储）为 v1 目标。

### B6 数据边界：工作区是资产，VM 磁盘是消耗品
- 持久数据只有两类：SQLite 平台库 + 租户工作区目录。
- Run 结束：VM 磁盘中的用户产物**导回工作区**后才算完成；VM 磁盘副本随即销毁（目标：一次性密钥加密盘，丢钥即清零）。
- 禁止在 `/tmp` 等共享位置留存任何租户数据（P1 jailer 改造解决）。

### B7 生命周期边界：生灭必须闭环
- VM 由 Run 创建、随 Run 终止销毁；启动协调器在进程重启后回收孤儿（已有机制，microVM 需补齐同名文件/进程清理）。
- 禁止"半销毁"：进程死了但磁盘/socket 残留，或磁盘删了但记录显示 ACTIVE。

### B8 能力边界：本平台明确不做什么
- 不做常驻云桌面（无 always-on per-user VM；升级方向留接口不实现）；
- 不做公开计量计费（私有部署，配额按租户管理即可）；
- 不做 Agent 能力深度定制（沿用 Pi，平台负责编排/隔离/审计）；
- 不保证 VM 内实时持久（落盘语义是"任务结束时导出"）。

---

## 4. 推理服务的边界澄清（针对"能不能包装成 API"）

vLLM 本身就是 OpenAI 兼容 HTTP API。正确架构是**三层**：

```
Pi/Worker (宿主侧) ──HTTP──> LLM 网关 ──HTTP──> vLLM (GPU 服务)
                              ↑
VM 内工具（未来） ──白名单──> 出口网关 ──> LLM 网关（同一个入口，鉴权+计量）
```

- LLM 网关是唯一入口：鉴权（`models:generate` scope）、负载均衡、健康探测、上下文预算（均已实现）。
- GPU 服务对除网关外的所有主体不可达（网络层 ACL / 防火墙，不只是约定）。
- "包装成 API"这一步已经完成；要做的是把它**围起来**，而不是再包一层。

---

## 5. 系统架构（目标态）

```
HTTP API ──> Master (调度/审计/策略/LLM网关)
               │
               ├─ Worker（进程隔离）── Pi 运行时
               │     │
               │     └─ SandboxProviderRouter
               │          ├─ strict  ──> MicrovmSandboxProvider ──> jailer ──> Firecracker VM ★
               │          │                                            ├ vsock agent（命令通道）
               │          │                                            ├ 工作区盘（CoW 副本）
               │          │                                            └ snapshot/restore（预热）
               │          └─ default ──> ContainerSandboxProvider (runsc)  ★迁移期双轨
               │
               └─ SQLite（平台库）+ workspaces/（租户文件）+ snapshots/（VM 快照池）
```

迁移期策略：**strict=microVM 与 default=runsc 双轨并行，按租户灰度**；每步可回退。

---

## 6. 实现路线（Phase 0–4 全部完成）

| 阶段 | 内容 | 对应边界 | 状态 |
|---|---|---|---|
| ✅ Phase 0 | 封死假执行/假证据，fail-closed | B1 | 已完成 |
| ✅ Phase 1 | vsock guest agent + jailer（含 /tmp→私有目录） | B1、B6、B7 | 已完成 |
| ✅ Phase 2 | 工作区导出 + 磁盘限额 + microVM 接入租户准入 | B5、B6 | 已完成 |
| ✅ Phase 3 | microVM 快照加速池（jailer）+ 异步复制（去阻塞）+ CoW 盘；预热池已由 M4 删除 | B5（性能） | 已完成 |
| ✅ Phase 3b | snapshot/restore 加速 | B5（性能） | 已完成（jailer 模式真机 23/23：恢复 368ms vs 冷启动 2519ms）。**无需自建 Firecracker**——此前"官方未编译 pause/resume"的结论基于错误探测信号（grep 了从不存在的 `InstancePause`），已推翻；官方 v1.17.0 二进制实测可用。详见验收报告 §3.1、§5 |
| 🚫 Phase 4（作废） | ~~出口网关 + controlled-egress~~ | — | **产品决策取消**：VM 一律无网卡（B2），相关代码已删除 |

每个 Phase 以"边界测试全绿"作为验收：隔离证据真实、逃逸面实测、生命周期无残留。

---

## 7. v1 成功标准

1. 两租户并发跑任务，A 无法以任何手段读到 B 的文件/进程/网络（**已验证**：`scripts/microvm-attack-smoke.ts` 在 jailer 模式真机 37/37 通过，覆盖容器版 9 项等价攻击 + 11 项 microVM 特有逃逸面，见 `microvm-live-validation.md` §6）；
2. 单租户 10 并发 Run，P95 启动延迟 < 3s（snapshot restore 后目标 < 500ms）；
3. Run 结束 60s 内，宿主无该 Run 的进程、socket、磁盘、内存残留（启动协调器 + 巡检脚本验证）；
4. 宿主进程崩溃重启后，平台自动收敛到一致状态，无需人工清理；
5. 所有 sandboxes 表记录的 `runtimeEvidence` 可由巡检脚本独立复验为真；
6. **（2026-10-08 新增）每台 VM 位于独立 cgroup 且限额真实生效**（实测 `memory.max=(256+64)MiB`、`cpu.max=2 核`）——容量准入不超卖的物理基础，不得仅凭配置代码断言。

---

## 8. 附录：已知限制（Known Limitations，不视为缺陷）

1. **vsock 协议 v1 对伪造 exec_result 的防护**：当前机制为"先到者生效"（guest 是信任域内，防护目标是宿主编排正确性，不是 guest 内攻击者）；guest 内威胁由 KVM 硬件虚拟化边界兜底。
2. **工作区盘形态**：因 dm-crypt 需要宿主额外特权，v1 以 `0700` 私有运行目录隔离 + 任务终止物理销毁替代，加密盘列为 v2 候选。
---

## 9. 个人项目裁剪边界（v1.2，2026-10-10 定档）

> 本节是项目范围的最终裁决：新增需求先对照本节，不在范围内的默认不做。

### 9.1 产品定位

个人 / 小私有部署的多租户 Agent 任务服务：用户通过 HTTP API（可选最小控制台）提交任务；平台负责租户身份、排队与配额、Run 生命周期、工具治理、jailer + Firecracker microVM 隔离执行、结果与产物导出、事件审计。模型推理由外部 OpenAI 兼容服务提供；平台不承载模型、不做路由、不做显存调度。

不是：Grok / Manus 式完整平台，不是公网 SaaS，不是多节点集群，不是模型训练/推理平台。

### 9.2 范围内（In scope）

1. 多租户身份与隔离：API Key 派生 Tenant；Run/Workspace/Sandbox 归属校验；跨租户操作 fail-closed。
2. 任务生命周期：提交、排队、Run/Attempt、状态与事件查询、中断/恢复、输出与产物导出。
3. 调度与配额：全局/每租户并发上限、Queue TTL、会话串行、执行超时强杀。
4. 执行隔离：jailer + Firecracker microVM，无网卡，工作区盘独立，Broker 只暴露 create/execute/terminate。
5. 工具治理：bash/file 等工具、路径围栏、副作用账本、崩溃/中断后安全重放。
6. 外部模型接入：OpenAI 兼容 endpoint（opencode-go / 自建 vLLM 等）经 Pi runtime；平台只调用。
7. 可审计：Run events、策略决策、工具执行记录写入本地 SQLite。
8. 部署形态：单台 Linux + KVM，systemd 管理 Master/Broker/Worker，SQLite 本地持久化。

### 9.3 范围外（Out of scope，明确不做）

- 不做 Grok / Manus 完整产品：浏览器自动化、多智能体市场、公网 SaaS、计费结算。
- 不做模型训练 / 微调 / 推理托管；不做 GPU/VRAM 观测、模型路由、显存感知调度。
- 不做多节点集群、跨区域、高可用、分布式数据库。
- 不做 Agent 网络访问：microVM 无网卡；allowNetwork=true 一律拒绝。
- 不做企业身份（SSO/SCIM）、合规认证、复杂 RBAC 后台。
- 不做完整插件生态、GUI 工作流编排、成本结算系统。

### 9.4 验收标准（裁剪版）

1. 两个租户并发提交任务：无法读/写/终止对方 sandbox/workspace，跨租户操作被 Broker 拒绝。
2. 一条真实 Run 走通 HTTP -> 调度 -> Worker -> Broker -> jailer microVM -> 外部模型 -> 工具执行 -> 输出/产物导出，事件完整。
3. Agent 内无网络；allowNetwork 请求 fail-closed。
4. 中断/超时/崩溃后无 sandbox 残留，Run 进入终态；安全操作可恢复。
5. 单机重启后队列与 RunStore 可从 SQLite 恢复。
6. 每租户并发上限与 Queue TTL 生效；不依赖预热池或 GPU 观测。

### 9.5 当前状态与剩余 P0

已完成：

- 多租户 microVM 隔离与 jailer + 快照并发真机验证；
- Broker 租户隔离 + capability token；systemd worker 专用 UID/cgroup；
- 外部模型服务 observer；M4 删除 VRAM/GPU 观测与预热池（提交 7684287）。

剩余 P0（达到个人可用 Demo）：

- 把 M4 同步到 172.17.43.193 并复跑测试；
- 补单机 systemd 部署/启动文档；
- 补 3 条端到端 smoke：串行、并发、跨租户拒绝；
- 确保 README 与本文档一致。

暂缓的增强（不在当前边界内）：

- Broker SO_PEERCRED 密码学校验、worker seccomp/Landlock/只读 rootfs；
- 控制面 egress ACL、租户成本账单、不可变审计存储。
