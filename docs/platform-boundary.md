# 个人版多租户 Agent 任务服务：定位与系统边界（v1.2-frozen；个人项目裁剪定档，2026-10-10 冻结）

> 本文档是项目的**唯一权威边界定义**；个人项目裁剪边界见 §9。实现、评审、测试以此为对齐基准；
> 与本文件冲突的代码视为缺陷。实现完成后更新 README 指向本文。
>
> 定档结论（2026-10-10 个人项目裁剪；详见 §9）：
> - 产品形态：**个人版多租户 Agent 任务服务**——每任务一台 ephemeral microVM，不做 Grok/Manus 式完整平台；
> - 部署形态：单台 Linux + KVM，systemd 管理，SQLite 本地持久化；不做多节点、高可用、公网 SaaS 与计费结算；
> - 模型推理：外部 OpenAI 兼容服务（opencode-go / 自建 vLLM 等）；平台不承载模型、不做路由、不做显存调度；
> - Agent 运行时：沿用 Pi；Agent 无网络权限，工具执行进 jailer + Firecracker microVM。
>
> 冻结结论（2026-10-10）：§9 边界已冻结；解冻必须显式记录（见 §9.6）。

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

## 9. 个人项目裁剪边界（v1.2-frozen，2026-10-10 定档并冻结）

> 本节是项目范围的最终裁决：新增需求先对照本节，不在范围内的默认不做。
> 本文档已于 2026-10-10 冻结；变更流程见 §9.6。

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
- 不做共享 / 协作 / 团队空间：产品定位是单用户个人云端 Agent 助手（类 Grok bot / Manus cue / Muse）；多租户隔离是让每个人用自己的账号，不是多人协作平台。

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
- 外部模型服务 observer；M4 删除 VRAM/GPU 观测与预热池（提交 7684287）；
- 队列 pump 连续并发：submit 后 kick 独立抢 slot，drain 批次不再串行化后提交（src/scheduling/run-scheduler.ts）。
- §9.4.4 中断清理真机复验：Run `b0751de3-acaf-49e7-abbd-c597c69efe31` 在 `SANDBOX_ACQUIRED` 后收到 `USER_REQUEST` 中断，终态 `INTERRUPTED`；结束后无 firecracker/jailer/worker 进程，`vm-runtime` 为空（工作区按数据资产保留）。
- B2 联网 fail-closed：修复请求级 `runPolicy.allowNetwork=true` 在 strict/microVM 下被平台层 `allowNetwork:false` 交集吞掉、静默降级为无网运行的问题（`src/policies/effective-policy.ts` 的 `assertNetworkRequestAllowed` + `src/runtime/run-executor.ts` 在创建 VM 前断言）；真机 Run `157c79d8-6838-43f7-8157-f581996b5a3e` 以 `INTERRUPTED` 终态失败，事件消息为“allowNetwork=true 被平台策略拒绝…”，未创建 sandbox；`scripts/p0-e2e-smoke.ts` 复跑通过 `P0_E2E_SMOKE_OK label=249754dd`。

剩余 P0（达到个人可用 Demo）：

- 已无未完成项。2026-10-10 收口：
  - M4 已同步 172.17.43.193，远程 `bun test ./tests` = 464 pass / 0 fail；
  - 单机 systemd 部署文档 `docs/deployment-single-node-systemd.zh-CN.md`，部署示例 `deploy/harness-broker.service.example`、`deploy/harness.service.example`、`deploy/harness-worker-launcher.sudoers.example`；
  - `scripts/p0-e2e-smoke.ts` 真机通过：串行 maxActive=1；并发 maxActive=2 且事件重叠；跨租户 GET run/events/output + interrupt + 在对方 workspace 提交全部 404；
  - README 已对齐外部模型边界与测试基线。

实验室接入维护记录（2026-10-10，不新增 §9.2 能力）：

- 注册收口（安全加固）：`HARNESS_REGISTRATION_MODE=open|invite|closed` 默认 `open` 保持旧部署兼容；`invite` 必须配置 `HARNESS_REGISTRATION_INVITE_CODE`，比较走 SHA-256 + `timingSafeEqual`；策略拒绝返回 403。交给实验室/他人使用前应显式设为 `invite` 或 `closed`。
- 单机运维脚本（部署兼容）：`src/ops/harness-maintenance.ts` + `scripts/harness-ops.ts` 提供 `disk-check`、`backup`（SQLite `VACUUM INTO`，保留最近 N 份）、`restore`（清理旧 WAL/SHM，覆盖需 `--force`）、`cleanup`（VM runtime 与快照池按年龄/条目数清理，默认 dry-run）。
- HTTP 入口限流（安全加固）：`src/http/rate-limiter.ts` + `HarnessHttpApi` 固定窗口限流；默认开启，每租户 600/分钟、每 IP 120/分钟（`HARNESS_RATE_LIMIT_*` 可调），超限 429 + `Retry-After`；`/health`、`/ready` 不参与；`HARNESS_TRUST_PROXY` 仅在可信反向代理后开启。
- 用户控制台美化（产品打磨）：`src/http/harness-user-console.ts` + `web/app.js` / `web/app.css` 保持 same-origin 无构建；本轮增加注册邀请码入口与样式改进。
- TLS / 反向代理（部署安全）：`docs/tls-reverse-proxy.zh-CN.md` + `deploy/harness-caddy.example` + `deploy/harness-nginx.example`；Master 继续只监听 loopback，外部入口由 Caddy/Nginx 终止 TLS，只放行 443（可选 80），不放行 3100。无 Caddy/Nginx 时可用 `scripts/dev-tls-proxy.ts` 做临时验证。
- 真机 HTTPS 全链路验证（2026-10-10）：在 172.17.43.193 用 `scripts/dev-tls-proxy.ts`（自签证书）反代 Master，`NODE_EXTRA_CA_CERTS=... HARNESS_BASE_URL=https://127.0.0.1:8443 bun run scripts/p0-e2e-smoke.ts` 通过 `P0_E2E_SMOKE_OK label=f3ac25a8`（serial maxActive=1、concurrent maxActive=2 overlap=true、跨租户 404）；随后清理 broker/master/proxy、`data/live-full-flow`、`snapshots-mt`、`/run/harness` 与 `/tmp/harness-tls`，无残留。
- 升级/回滚 runbook（部署兼容）：`docs/upgrade-rollback-runbook.zh-CN.md` + `deploy/harness-logrotate.example`；迁移向前执行，回滚必须先 `harness-ops.ts backup` 再 `restore`，并附升级后验收命令。
- 补充审查报告第一批修复（2026-10-11，安全/可靠性加固，不新增 §9.2 能力）：
  - F1 Firecracker API 超时：`src/sandbox/microvm/firecracker-sandbox-driver.ts` 的 `putSocket` 增加 `timeoutMs`（默认 10s，`/snapshot/load` 与 `/snapshot/create` 为 60s），API 卡死时 `req.destroy` 并 reject，create/terminate 不再无限挂起；新增 `tests/sandbox/firecracker-api-timeout.test.ts`。
  - F3 SQLite WAL/busy_timeout：`src/storage/database.ts` 的 `configureDatabase` 增加 `PRAGMA journal_mode = WAL` 与 `PRAGMA busy_timeout = 5000`，让 `harness-maintenance.ts` 的跨进程 `VACUUM INTO` 备份与 Master 写入不再互斥；新增数据库 PRAGMA 回归测试。
  - F6 Broker create 孤儿回收：`src/sandbox/broker/sandbox-broker-server.ts` 在 create 后 `readRecord` 为 null 时先 `provider.terminate(handle.id)` 再抛错，避免产生不可寻址孤儿 VM；新增 Broker 回归测试。
  - F10 HTTP 内部错误收口：`src/http/harness-http-api.ts` catch-all 由 409 + 原始 message 改为 500 + 通用文案 + requestId，原始异常只进服务端日志；`src/http/routes/auth.ts` 重复邮箱映射为 409 “该邮箱已被注册”，已知输入校验错误映射为 400；新增 HTTP/注册回归测试。
  - F12 三项小修：`src/auth/api-credential-store.ts` 新增 `pruneSessions`（启动时清理过期会话与超过 7 天保留期的已撤销会话）；`src/sandbox/broker/sandbox-broker-server.ts` control token / capability token 改为 SHA-256 + `timingSafeEqual` 恒时比较；`src/http/routes/system.ts` 审计分页 `limit`/`offset` 显式校验（1..500 / 0..1,000,000），非法值返回 400。
  - 本地 `bun test ./tests` = 524 pass / 7 skip / 0 fail；typecheck 保持既有 9 条基线错误。
  - 真机验证（2026-10-11，172.17.43.193）：rsync 后远程 `bun test ./tests` = 531 pass / 0 fail；重启 `harness-broker.service`/`harness.service` 后 `/health` 200；`/data/harness/live-full-flow/harness.sqlite-wal`/`-shm` 出现；重复注册 `lab@demo.local` 返回 409 “该邮箱已被注册”；`/audit?limit=abc` 与 `/audit?offset=-1` 返回 400、`/audit?limit=1&offset=0` 返回 200；`scripts/p0-e2e-smoke.ts` 带 `HARNESS_SMOKE_INVITE_CODE=lab-harness-2026` 通过 `P0_E2E_SMOKE_OK label=61c8ab85`（serial maxActive=1、concurrent maxActive=2 overlap=true、跨租户 404）。
  - F4 宿主侧输出截断（2026-10-11）：`src/sandbox/microvm/firecracker-vsock-bridge.ts` 新增 `boundedAppend`，按 `maxOutputBytes`（默认 1 MiB）在宿主侧硬截断 stdout/stderr，guest 谎报 `truncated:false` 时仍置 `truncated:true`；新增 `tests/sandbox/firecracker-vsock-bridge.test.ts` 回归。
  - F9 workspace 快照/artifact 限额（2026-10-11）：`src/workspaces/workspace-snapshot.ts` 新增 `WorkspaceSnapshotOptions`/`WorkspaceSnapshotLimitError`，默认 `maxFiles=20000`、`maxDepth=32`，超限 fail-closed；`src/workspaces/run-artifact-store.ts` 默认每 Run `maxFiles=200`、`maxBytes=50 MiB`，超限停止捕获并 warning；`src/ops/harness-maintenance.ts` 新增 `pruneArtifacts`，`scripts/harness-ops.ts cleanup --artifacts <目录> --database <sqlite>` 按年龄清理 artifact 目录与索引行（默认 dry-run）；配置项 `HARNESS_WORKSPACE_SNAPSHOT_MAX_FILES`、`HARNESS_WORKSPACE_SNAPSHOT_MAX_DEPTH`、`HARNESS_ARTIFACT_MAX_FILES_PER_RUN`、`HARNESS_ARTIFACT_MAX_BYTES_PER_RUN`；新增快照/artifact/prune 回归测试。
  - F4/F9 本地 `bun test ./tests` = 530 pass / 7 skip / 0 fail；typecheck 保持既有 9 条基线错误。
  - F4/F9 真机验证（2026-10-11，172.17.43.193）：rsync 后远程 `bun test ./tests` = 537 pass / 0 fail；重启 `harness.service` 后 `/health` 200；`scripts/p0-e2e-smoke.ts` 带 `HARNESS_SMOKE_INVITE_CODE=lab-harness-2026` 通过 `P0_E2E_SMOKE_OK label=ace9c14b`（serial maxActive=1、concurrent maxActive=2 overlap=true、跨租户 404）；`harness-ops.ts cleanup --artifacts /data/harness/live-full-flow/artifacts --database /data/harness/live-full-flow/harness.sqlite --max-age-hours 24` 输出 `HARNESS_OPS_CLEANUP_OK ... artifactsRemoved=0`。
- 以上均属 §9.6 允许的 bug/安全修复、测试与文档维护、部署兼容性修复，不改变 §9.2/§9.3 的范围划分。

暂缓的增强（不在当前边界内）：

- 已在 §9.7 v1.3 解冻并实现：Broker SO_PEERCRED、worker seccomp/Landlock/只读 rootfs、控制面 egress ACL、不可变审计存储、租户成本账单；
- 五项均已实现（真机证据见 §9.7）。

### 9.6 边界冻结与变更流程

- 本文档 §9 自 2026-10-10 起冻结（v1.2-frozen）：不新增 §9.2 范围内能力，§9.3 范围外默认不做。
- 任何范围变更（新增或移出）必须先在本文档留下“解冻决策”记录：版本号、日期、变更条目、理由；对应的代码/文档变更必须引用该记录。
- 未记录解冻决策的需求/PR，默认按“不在边界内”拒绝。
- 冻结不阻碍：bug 修复、安全修复、测试与文档维护、部署兼容性修复。

### 9.7 解冻决策：v1.3（2026-10-10）

- 决策：用户要求开始 §9.5 的暂缓增强。按 §9.6，先将下列条目从 §9.3“范围外”移入 v1.3 范围，分阶段实施：
  1. Broker SO_PEERCRED 对端凭据校验（Linux；与现有 controlToken 叠加，不替代）；
  2. Worker seccomp/Landlock/只读 rootfs；
  3. 控制面 egress ACL；
  4. 不可变审计存储；
  5. 租户成本账单。
- 理由：Agent 平台即使只做个人 Demo，控制面与执行面的凭据/进程/网络边界仍需要纵深防御；先补安全项，再做审计与计费。
- 边界影响：上述条目不再按 §9.3 默认拒绝；§9.3 其余条目仍默认不做。
- 验收要求：每一项必须有单元/集成测试，并在 172.17.43.193 真机留下验证记录；未完成前该项仍视为暂缓。
- 代码引用：涉及代码/文档变更必须在提交信息或注释中引用“§9.7 v1.3”。
- 实施进度（2026-10-10）：
  - 1) Broker SO_PEERCRED：已实现。`src/sandbox/broker/peer-credentials.ts` 用 `bun:ffi` 读 Linux `SO_PEERCRED`；`SandboxBrokerServer` 新增 `allowedPeerUids` / `masterPeerUid` / `workerPeerUid`，create/terminate 只认 Master UID、execute 只认 Worker UID，白名单外或读不到凭据一律 fail-closed；`broker-main.ts` 读取 `HARNESS_SANDBOX_BROKER_PEER_UIDS` / `MASTER_UID` / `WORKER_UID`，生产环境至少配置一项。
  - 真机 172.17.43.193 验证（broker root pid 2170523，master cxr pid 2170704）：`scripts/p0-e2e-smoke.ts` 通过 `P0_E2E_SMOKE_OK label=0d6ae207`（serial maxActive=1；concurrent maxActive=2 overlap=true；跨租户 404）；直接探针：uid=1004 发 execute 被拒“要求 uid=998”，uid=0 发 create/ping 被拒“不在 SO_PEERCRED 白名单内”。
  - 2) Worker seccomp/Landlock/只读 rootfs：已实现。`scripts/harness-worker-run.sh` 增加 `PrivateDevices`、`ProtectKernelTunables/Modules/ControlGroups/Clock/Hostname`、`ProtectProc=invisible`、`ProcSubset=pid`、`RestrictRealtime`、`RestrictSUIDSGID`、`RemoveIPC`、`LockPersonality`、`SystemCallFilter=@system-service` 并显式放行三个 Landlock syscall、`SystemCallErrorNumber=EPERM`；Worker 内 `src/worker/worker-landlock.ts` 以 `HARNESS_WORKER_LANDLOCK=required` 调 `landlock_create_ruleset` / `landlock_add_rule` / `landlock_restrict_self`，根目录只读、仅 `/tmp`、`$HOME`、`/run/harness` 与 `/dev/null` 等可写，失败即退出 78。
  - 真机 172.17.43.193 验证：`scripts/p0-e2e-smoke.ts` 通过 `P0_E2E_SMOKE_OK label=c21abe78`（serial maxActive=1、concurrent maxActive=2 overlap=true、跨租户 404）；Worker stderr 打印 `[worker] landlock=on abi=4`；`systemctl show harness-worker-<runId>.service` 确认 UID=998、MemoryMax=2G、CPUQuota=200%、TasksMax=256、ProtectSystem=strict、ProtectHome=read-only、SystemCallFilter 含三个 Landlock syscall、ReadWritePaths=/var/lib/harness-worker；中断后无 firecracker/jailer/worker 残留。
  - 3) 控制面 egress ACL：已实现。`deploy/harness-broker.service.example` 加 `IPAddressDeny=any`；`deploy/harness.service.example` 加 `IPAddressDeny=any` + `IPAddressAllow=127.0.0.0/8`；`scripts/harness-worker-run.sh` 用 `IPAddressDeny=any` + `IPAddressAllow=$WORKER_EGRESS_ALLOW`（默认 `127.0.0.0/8`，配置文件可放行模型服务 CIDR，opencode.ai 的 Cloudflare 段为 `172.64.0.0/13`），并把 Worker 限制为 `RestrictAddressFamilies=AF_UNIX AF_INET`（不创建 IPv6 套接字）。`tests/deploy/control-plane-egress.test.ts` 覆盖单元/launcher/配置示例。
  - 真机 172.17.43.193 验证：`scripts/p0-e2e-smoke.ts` 通过 `P0_E2E_SMOKE_OK label=59e3ed52`（serial maxActive=1、concurrent maxActive=2 overlap=true、跨租户 404）；Worker 单元 `systemctl show` 显示 `IPAddressDeny=::/0 0.0.0.0/0`、`IPAddressAllow=172.64.0.0/13 127.0.0.0/8`、`RestrictAddressFamilies=AF_INET AF_UNIX`、UID/GID=998；同 ACL 的探针单元连接 `opencode.ai:443` 成功，连接 `1.1.1.1:443` 超时（被 ACL 丢弃）。
  - 4) 不可变审计存储：已实现。`src/storage/migrations.ts` 新增 v2 `immutable_audit_chain`：给 `access_audit_events` 增加 `prev_hash`/`hash` 列，并创建 `BEFORE UPDATE`/`BEFORE DELETE` 触发器（`RAISE(ABORT, 'access_audit_events 是只追加审计存储，禁止 UPDATE/DELETE')`）。`src/audit/access-audit-store.ts` 写入时计算 SHA-256 hash 链（`prev_hash` 取上一行 `hash`，链首为 `GENESIS_HASH = "0".repeat(64)`），新增 `verifyChain()` 返回 `{ok,checked,legacy,brokenAt?,reason?}`；旧库中 hash 为 NULL 的历史行作为 pre-chain legacy 跳过，链开始后出现 NULL 或 `prev_hash`/`hash` 不匹配即失败。`tests/audit/access-audit-store.test.ts` 新增 3 用例覆盖只追加、内容篡改检测、删除中间行检测；`scripts/audit-chain-smoke.ts` 支持内存自检与 `--database <path>` 校验真实库。
  - 真机 172.17.43.193 验证：master 重启后 migration v2 生效；`scripts/p0-e2e-smoke.ts` 通过 `P0_E2E_SMOKE_OK label=f6a94cd4`（serial maxActive=1、concurrent maxActive=2 overlap=true、跨租户 404）。`bun run scripts/audit-chain-smoke.ts` 输出 `AUDIT_CHAIN_SMOKE_OK`（updateRejected=true、deleteRejected=true、tamperDetected=true）；对 live `data/live-full-flow/harness.sqlite` 运行 `bun run scripts/audit-chain-smoke.ts --database data/live-full-flow/harness.sqlite` 输出 `{"ok":true,"checked":95,"legacy":1591}` 与 `AUDIT_CHAIN_VERIFY_OK`。直连 live 库探针确认触发器 `access_audit_events_no_update`/`access_audit_events_no_delete` 存在，`UPDATE`/`DELETE` 分别被拒绝为 `access_audit_events 是只追加审计存储，禁止 UPDATE` / `...禁止 DELETE`。
  - 5) 租户成本账单：已实现。新增 `src/billing/tenant-billing.ts`：`TenantBillingStore.summarize(tenantId)` 只读聚合 `run_events`（`MODEL_COMPLETED` 的 `usage.inputTokens`/`outputTokens`/`totalTokens`/`cost.total`）、`sandboxes`（`TERMINATED`/`LOST`/`FAILED` 的 `julianday` 时长）与 `tool_executions`（`SUCCEEDED`/`FAILED` 计数），默认金额等于 Provider 上报成本，不凭空定价；平台可用 `HARNESS_BILLING_CURRENCY`、`HARNESS_BILLING_MODEL_INPUT_PER_MTOK`、`HARNESS_BILLING_MODEL_OUTPUT_PER_MTOK`、`HARNESS_BILLING_SANDBOX_SECOND`、`HARNESS_BILLING_TOOL_CALL` 叠加 token/沙箱秒/工具调用费用。`GET /billing` 要求 `billing:read`，按 Principal Tenant 收口，未装配时返回 501。`tests/billing/tenant-billing.test.ts` 覆盖租户隔离、金额、token 单价、空租户与非法环境变量；`tests/http/tenant-boundary.test.ts` 覆盖 `GET /billing` 的租户收口与 scope 拒绝；`scripts/tenant-billing-smoke.ts` 支持内存自检与 `--database <path> [--tenant <id>]` 校验真实库。
  - 真机 172.17.43.193 验证：master 重启 pid 2202461；`bun run scripts/tenant-billing-smoke.ts` 输出 `TENANT_BILLING_SMOKE_OK`；`bun run scripts/tenant-billing-smoke.ts --database data/live-full-flow/harness.sqlite` 输出前 5 个租户账单（providerCost 0.00036~0.00068、sandboxSeconds 8.635~287.65、toolCalls 2）与 `TENANT_BILLING_VERIFY_OK`；`curl -H "Authorization: Bearer live-flow-key-2026" http://127.0.0.1:3100/billing` 返回 200 与 `tenantId=bootstrap` 账单；`scripts/p0-e2e-smoke.ts` 通过 `P0_E2E_SMOKE_OK label=00453468`（serial maxActive=1、concurrent maxActive=2 overlap=true、跨租户 404）。

### 9.8 解冻决策：v1.4（2026-10-11）

- 决策：用户要求把项目从“可运行的个人 Agent 平台”推进到“面试可讲的生产级 Agent 基础设施”，并明确 12 项 agent infra 的取舍：
  - 做：8 Sandbox 与执行环境（项目核心，继续深化）；3 任务队列与 Worker；5 Durable Execution；6 Retry/Timeout/幂等；9 工具基础设施与 MCP。
  - 不做：1 Agent Runtime（Pi Agent 已提供）；2 上下文与状态管理（Pi Agent 已提供）；4 多 Agent 编排；7 分布式状态与一致性；10 权限/安全/Secrets（已有）；12 Evaluation 与 Replay。
  - 11 可观测性不作为独立方向，但降级为 3/5/6 的验证工具：最小 `/metrics`、结构化日志与 traceId，用于证明 lease/recovery/retry 生效。
- 理由：项目已具备 microVM/jailer/快照、Broker capability token + SO_PEERCRED、systemd worker + seccomp/Landlock、egress ACL、审计 hash 链、限流、单机部署等基础；继续补队列/持久执行/重试/MCP，能让面试叙事从“会写 sandbox”扩展到“会做生产级 Agent 基础设施”。不做 1/2 是因为 Pi Agent 已提供，重复造轮子收益低；不做 4/7/12 是因为单机个人项目没有分布式/评测的规模与需求。
- 边界影响：上述 3/5/6/8/9 与“最小可观测性”不再按 §9.3 默认拒绝；§9.3 其余条目仍默认不做。
- 验收要求：每一项必须有单元/集成测试；涉及真机能力的（队列/恢复/重试/MCP）需在 172.17.43.193 留下验证记录；未完成前该项仍视为暂缓。
- 代码引用：涉及代码/文档变更必须在提交信息或注释中引用“§9.8 v1.4”。
- 实施顺序：
  - Phase 1：8 的生产级 benchmark（`scripts/vm-lifecycle-benchmark.ts` + `docs/vm-lifecycle-benchmark.zh-CN.md`）+ 最小 `/metrics`；
  - Phase 2：3 的 lease/heartbeat/优先级/backpressure；
  - Phase 3：5 的崩溃恢复 + 6 的 retry/backoff/Run 幂等键 + artifact 一致性窗口；
  - Phase 4：9 的 MCP 接入。
- 进度（2026-10-11）：
  - Phase 1 VM benchmark 已完成：真机 172.17.43.193（jailer + Firecracker v1.17.0）冷启动 median 1477ms、快照热恢复 median 513ms、10 并发热恢复墙钟 766ms；同时修复 `warmHit` 恒 false 的可观测性缺陷（`src/sandbox/microvm/*`）。本地 `bun test ./tests` = 533 pass / 7 skip / 0 fail，typecheck 保持既有 9 条基线错误；远程 172.17.43.193 `bun test ./tests` = 540 pass / 0 fail。
- Phase 1 补：**VM 创建分阶段耗时埋点**（`HARNESS_VM_PHASE_TRACE=1`，默认关闭零开销；提交 `35c4b42`）。真机 172.17.43.193（jailer + Firecracker v1.17.0，6 次热恢复）实测：热恢复端到端 **~490ms**，其中 `copy-snapshot`（把 `vm.snap` 26KB + `mem.snap` 512MB 拷进该 VM 的 jail chroot）**~298ms（61%）**、`copy-disks`（kernel 21MB + rootfs 256MB + workspace 128MB 拷进 chroot）**~110ms（22%）**、`vsock-handshake` 53ms、`api-socket-wait` 20ms、**`snapshot-load`（Firecracker `/snapshot/load` + resume 本身）仅 6~7ms**、`spawn-process` 1~3ms、`chown-chroot` 1~2ms。冷启动首建（含制作快照）总计 2776ms，其中 `vsock-handshake` 1325ms（guest 内核启动 + agent 就绪）、`make-snapshot` 1290ms。结论：Firecracker 侧恢复已在毫秒级，端到端延迟主要来自 jailer 隔离要求的**每 VM 私有文件拷贝**；`/data` 为 ext4（无 reflink，`cp --reflink=auto` 退化为全量拷贝），`mem.snap` 512MB 无空洞（`du --apparent-size` 与实占一致），硬链接内存镜像不安全（Firecracker 以可写方式 mmap，共享 inode 会造成多租户串写）。优化路径：只读文件硬链接（省 ~80ms）、COW 文件系统（xfs reflink=1 / btrfs）让内存镜像拷贝近 0（端到端 ~190ms）、**预热池**（后台预恢复待命 VM，交接给 Run 只剩握手 ~50ms）、socket 轮询粒度 20ms→2ms、workspace 模板 128MB→32MB。
  - 提交：`aab6b10`（warmHit + VM benchmark）、`5b3b83c`（并发矩阵脚本）。
- Phase 1 最小 `/metrics` 已完成：新增 `src/observability/metrics.ts` 与 `GET /metrics`（需 `metrics:read` scope），暴露 `harness_up`、`harness_uptime_seconds`、`harness_runs_queued`、`harness_runs{status}`、`harness_sandbox_acquisitions_total{warm}`、`harness_sandbox_acquire_duration_ms_sum`、`harness_http_requests_total{status}`；数据来自 `RunStore.countByStatus()`、`RunStore.sandboxAcquisitionStats()` 与进程内 HTTP 状态计数。本地 `bun test ./tests` = 536 pass / 7 skip / 0 fail；远程 172.17.43.193 `bun test ./tests` = 543 pass / 0 fail。真机 `harness.service` 重启后 `GET /metrics` 返回 200，`harness_up 1`、`harness_runs{status="COMPLETED"} 24`、`harness_http_requests_total` 正常累计。提交 `4d4f1e1`。
- Phase 2 队列与 Worker 已完成（本地）：migration v3 `queue_priority_and_run_lease`（`agent_runs.priority`、`run_attempts.lease_owner/lease_expires_at/heartbeat_at`）；`TenantRunScheduler` 支持 priority（跨租户优先于轮转/老化，同优先级 FIFO）；`RunScheduler` 增加 `maxQueuedRuns`/`maxQueuedRunsPerTenant` backpressure，超限抛 `QueueBackpressureError` 并由 HTTP 映射 429 + Retry-After；新增 `RunLeaseManager`（acquire/heartbeat/release/reapExpired）接入 `RunExecutor` 与 `RunScheduler`，过期租约回收为 INTERRUPTED 并释放 slot。本地 `bun test ./tests` = 544 pass / 7 skip / 0 fail，typecheck 9 条既有基线错误。 远程 172.17.43.193：`bun test ./tests` = 553 pass / 0 fail；`harness.service` 重启后 migration v3 生效（`agent_runs.priority`、`run_attempts.lease_owner/lease_expires_at/heartbeat_at`），`p0-e2e-smoke` 通过 `label=f88ea967`（serial maxActive=1、concurrent maxActive=2 overlap=true、跨租户 404）；真实 Run 的 `run_attempts` 显示 `heartbeat_at` 已写入、`lease_owner` 结束后清空（acquire/release 生效）。提交 `c6f620e`。
- Phase 3 Durable Execution / Retry / 幂等（本地完成，待真机复验）：migration v4 `run_idempotency_and_retry`（`agent_runs.idempotency_key` + 租户内部分唯一索引、`retry_count`、`retry_at`）；`RunStore.findByTenantIdempotencyKey` 与 `RunService.createQueuedRun` 幂等返回既有 Run；`POST /runs` 与会话消息接受可选 `idempotencyKey`（>200 字符 400）；无任何 PREPARED 工具副作用时可重试失败按指数退避回到 QUEUED（事件 `RUN_QUEUED` reason `RETRY`），达到 `HARNESS_RUN_MAX_ATTEMPTS` 或有副作用证据时保持 INTERRUPTED；确定性策略拒绝（`PolicyRejectionError`）不重试；`RunScheduler.reconcileQueuedRuns` 跳过未到 `retryAt` 的 QUEUED Run；`RecoveryService.planForInterruptedRun` + 组合根租约过期处理器把 Worker 崩溃的 Run 交给 `RecoveryExecutor`（AUTO_RESUME / MANUAL_REVIEW）；终态后追加 `RUN_ARTIFACTS_READY` 事件消除 artifacts 读取一致性窗口。本地 `bun test ./tests` = 558 pass / 7 skip / 0 fail，typecheck 9 条既有基线错误。 真机 172.17.43.193 已复验：migration 版本 `[1,2,3,4]`、`agent_runs` 含 `idempotency_key/retry_count/retry_at`、部分唯一索引存在；`POST /runs` 同 `idempotencyKey` 重放两次均 202 且返回同一 Run id（修复重复入队 500）；Run `26fcc090-d1ad-4637-8161-6856711e3f56` COMPLETED，事件尾部含 `RUN_ARTIFACTS_READY`；远程 `bun test ./tests` = 565 pass / 0 fail；p0 smoke `P0_E2E_SMOKE_OK label=d3af9012`。
- Phase 4 MCP 接入已完成（真机复验）：新增 `src/mcp/mcp-protocol.ts`（`McpServerConfig` / `McpToolDescriptor` / `parseMcpServers` / `sanitizeMcpToolSegment`）、`src/mcp/mcp-stdio-client.ts`（stdio JSON-RPC：initialize / notifications/initialized / tools/list / tools/call，默认 10s 超时）、`src/mcp/mcp-tool-registry.ts`（多 server 启动、单个失败跳过、`callTool` fail-closed）、`src/mcp/mcp-pi-tools.ts`（工具名 `mcp__<server>__<tool>`，`readOnlyHint` → `READ_ONLY` 否则 `UNKNOWN_EFFECT`，经 `ToolGateway.execute` 记账）；`HarnessConfig.mcpServers` 解析 `HARNESS_MCP_SERVERS`，in-process 路径由 Master 持有注册表并传给 `PiAdapterConfig.mcpTools`，process/systemd 路径随 `WorkerRuntimeConfig.mcpServers` 下发、由 Worker 拉起并继承其 seccomp/Landlock/egress ACL。测试：`tests/mcp/mcp-protocol.test.ts`、`tests/mcp/mcp-stdio-client.test.ts`、`tests/mcp/mcp-tool-registry.test.ts`、`tests/mcp/mcp-pi-tools.test.ts`、`tests/app/create-harness-application.test.ts`（in-process 启动 MCP）、`tests/deploy/mcp-phase4.test.ts`；烟测 `scripts/mcp-smoke.ts` 输出 `MCP_SMOKE_OK servers=1 tools=2 call=echo:smoke`。本地 `bun test ./tests` = 577 pass / 7 skip / 0 fail，typecheck 9 条既有基线错误。 真机 172.17.43.193（production systemd worker + jailer，`HARNESS_MCP_SERVERS` 指向 fixture）：`scripts/mcp-smoke.ts` 输出 `MCP_SMOKE_OK servers=1 tools=2 call=echo:smoke`；Run `f1dc66c9-cddc-4a7b-9d18-be64963a3a98` COMPLETED，事件 `TOOL_STARTED {"toolName":"mcp__echo__echo","arguments":{"text":"mcp-live"}}` → `TOOL_COMPLETED {"content":[{"type":"text","text":"echo:mcp-live"}],"isError":false}`，finalText `echo:mcp-live`；远程 `bun test ./tests` = 585 pass / 0 fail。真机发现并修复缺陷：Pi SDK `agent-session.js` 的 `_refreshToolRegistry` 用 `allowedToolNames` 过滤 customTools，而 `PiAdapter` 原只传 `tools:[...config.tools]`，导致 MCP 工具对模型不可见（首轮 Run `06cf4e7e-a3c8-49d6-8514-fc1371189185` 模型只看到 read/bash/edit/write/grep/find/ls）；修复为 `tools:[...new Set([...config.tools, ...customTools.map((tool) => tool.name)])]`（两处 `createAgentSession` 调用），并以 `tests/deploy/mcp-phase4.test.ts` 守卫。

### 9.9 解冻决策：v1.5（2026-10-11）

- 决策：在 §9.8 v1.4 的 Phase 1-4 之后，用户确认追加 Phase 5「生产级故障注入与恢复验收」。这不是新增产品能力，而是对既有能力（§9.8 的 3/5/6/8 + 最小可观测性）做对抗性验收：在真实故障下证明租约回收、恢复决策、重试退避、幂等、backpressure、备份一致性、跨租户隔离不退化。
- 范围（仅用于验收，不新增产品能力）：
  - F1 Worker 崩溃：kill systemd worker 后，RunAttempt 租约过期 → reaper 回收 → Run INTERRUPTED → `RecoveryService.planForInterruptedRun` → AUTO_RESUME（无副作用）或 MANUAL_REVIEW（UNKNOWN_EFFECT / NO_CHECKPOINT）→ scheduler slot 释放、无孤儿 microVM/worker。
  - F2 Broker 不可达：停止 Broker 后提交 Run → fail-closed INTERRUPTED，无孤儿 sandbox 记录与残留 VM；Broker 恢复后新 Run 正常。
  - F3 模型调用失败：注入失败 ModelRuntime → 退避重试（`RUN_QUEUED` reason `RETRY`、`retryAt` 递增）到 `HARNESS_RUN_MAX_ATTEMPTS` 后保持 INTERRUPTED；`PolicyRejectionError` 与存在 PREPARED 副作用时不重试。
  - F4 幂等键并发重放：同 `idempotencyKey` 并发 N 次 `POST /runs` → 只创建 1 个 Run，全部返回同一 runId，无 500。
  - F5 队列 backpressure：超过 `HARNESS_MAX_QUEUED_RUNS` → 429 + `Retry-After`/`x-queue-limit`/`x-queue-current`；被拒请求不落库。
  - F6 运行中备份一致性：Run 执行中 `harness-ops backup` → 备份可打开、`audit-chain-smoke` 校验通过、无 `SQLITE_BUSY`。
  - F7 故障态跨租户隔离：F1/F2 故障期间跨租户 run/events/output/artifacts/interrupt/workspace 提交仍全部 404。
- 理由：§9.8 的验收只证明「正常路径可用」；面试叙事需要「故障下仍可解释、可恢复、不重复副作用」。不做 1/2/4/7/10/12 的结论不变。
- 边界影响：仅新增验收脚本与测试，不新增产品能力；不改变 Agent 无网络（B2）与单机定位（§9.3）。
- 验收要求：F1-F7 每项必须有测试；F1/F2/F4/F5/F6/F7 需在 172.17.43.193 留下验证记录；未完成前该项视为暂缓。
- 代码引用：涉及代码/文档变更必须在提交信息或注释中引用「§9.9 v1.5」。
- 交付物：
  - `scripts/phase5-fault-injection.ts`：HTTP 层故障注入（F4/F5/F7 + 汇总）。
  - `scripts/phase5-worker-crash.ts`：F1/F2 真机编排（杀 worker / 停 broker + 轮询恢复 + 残留检查）。
  - `tests/recovery/lease-expiry-recovery.test.ts`：租约过期 → 恢复决策接线（AUTO_RESUME / MANUAL_REVIEW）。
  - `tests/http/idempotency-concurrency.e2e.test.ts`：并发同键重放。
  - `tests/ops/backup-consistency.test.ts`：WAL 运行中备份 + 审计链校验。

- 已落地（本地，2026-10-11）：
  - F1：`tests/recovery/lease-expiry-recovery.test.ts` 两个用例——过期租约经 `tick()` 回收为 INTERRUPTED 且落 `MANUAL_REVIEW_REQUIRED`（无 Checkpoint）；有安全 READ_ONLY Checkpoint 时 `AUTO_RESUME` 续跑至 COMPLETED（`runtime.resumeRequests` 长度 1，事件 `RUN_QUEUED` reason `AUTO_RECOVERY`）。
  - F2：`tests/runtime/broker-unreachable.test.ts`——Broker socket 缺失时 Run fail-closed 为 INTERRUPTED（`START_FAILED`），`SandboxStore.listUnsettled()` 为空、队列为空。
  - F3：沿用 Phase 3 的 `tests/runs/run-service-retry.test.ts`（无副作用退避重试、PREPARED 副作用不重试、maxAttempts 后 INTERRUPTED）、`tests/scheduling/run-scheduler-retry-at.test.ts`（retryAt 门控）与 `tests/app/create-harness-application.test.ts`（PolicyRejectionError 不重试，Run 直接 INTERRUPTED）。
  - F4：`tests/http/idempotency-concurrency.e2e.test.ts`——同 idempotencyKey 并发 8 次提交只创建 1 个 Run，全部返回同一 id。
  - F5：`tests/scheduling/queue-backpressure-fault.test.ts`——占满 active slot 并排队 1 个 Run 后，第三个提交抛 `QueueBackpressureError` 且 `listForTenant` 为空（被拒请求不落库）。
  - F6：`tests/ops/backup-consistency.test.ts`——另一连接持写事务（WAL）时 `VACUUM INTO` 备份成功；备份 `schema_migrations` = [1,2,3,4]、`access_audit_events` 非空且 `AccessAuditStore.verifyChain()` ok。
  - F7：`tests/http/fault-isolation.e2e.test.ts`——故障态 Run（租约过期 INTERRUPTED）对其它租户的 run/events/output/artifacts/interrupt 与「在对方 workspace 提交」全部 404。
  - 本地 `bun test ./tests` = 585 pass / 7 skip / 0 fail；typecheck 9 条既有基线错误。真机 172.17.43.193 验证记录见提交与部署文档。

- 真机 172.17.43.193 发现（2026-10-11，Phase 5 验收期间）：
  - Worker egress 双栈修复：§9.7 v1.3 第 3 项曾把 Worker 限制为 `RestrictAddressFamilies=AF_UNIX AF_INET`（仅 IPv4），以规避 IPv6 被 `IPAddressDeny=::/0` 丢弃导致的挂起。本次真机遇到「宿主 IPv4 到 opencode.ai 的 Cloudflare 段 172.65.90.0/24 不可达、IPv6 2606:4700:78:: 可用」，Worker 因只建 IPv4 套接字而全部 SYN-SENT 挂起。修复：`scripts/harness-worker-run.sh` 恢复 `AF_INET6`，`WORKER_EGRESS_ALLOW` 同时放行 IPv4 与 IPv6 CIDR（`127.0.0.0/8,172.64.0.0/13,2606:4700:78::/48`）；`scripts/harness-worker-launcher.conf.example`、`docs/deployment-single-node-systemd.zh-CN.md`、`tests/deploy/control-plane-egress.test.ts` 同步更新。
  - 外部模型服务不可达时的故障形态（真实观察）：TCP SYN 被黑洞丢弃时，Run 长时间停在 `RUNNING`（事件停在 `SESSION_INITIALIZED` 或 `MODEL_STARTED`），Worker 心跳持续续租，租约回收器不会触发；唯一兜底是 `HARNESS_EXECUTION_TIMEOUT_MS`（默认 30 分钟）。平台侧没有模型服务健康探测/告警，也没有单次模型调用超时。实验室部署建议把 `HARNESS_EXECUTION_TIMEOUT_MS` 下调到 5 分钟，并把模型服务可达性纳入外部监控。
  - 该现象同时说明：F3「模型调用失败」在真实网络下更可能是**挂起**而非快速报错，退避重试（Phase 3）覆盖的是抛错路径。

- 真机 172.17.43.193 验收记录（2026-10-11，jailer + Firecracker v1.17.0 + systemd Worker + 外部 opencode-go）：
  - F4/F5/F7：`scripts/phase5-fault-injection.ts` → `PHASE5_FAULT_INJECTION_OK label=4ab31c49 f4=COMPLETED f5=skipped f7=ok`；再以 backpressure 配置（`HARNESS_MAX_ACTIVE_RUNS=1`、`HARNESS_MAX_ACTIVE_RUNS_PER_TENANT=1`、`HARNESS_MAX_QUEUED_RUNS=2`）复跑 → `label=516e858a f4=COMPLETED f5=accepted=2 f7=ok`（第 3 个提交 429 + `Retry-After`）。
  - F1/F2：`scripts/phase5-worker-crash.ts` → `PHASE5_WORKER_CRASH_OK label=7b664a2e f1=path=supervisor unit=harness-worker-98fb75a9-997a-4ca6-bb9a-8532cc02d44d.service run=98fb75a9-997a-4ca6-bb9a-8532cc02d44d f2=recoveredRun=be6e832b-d5d6-4e0d-9772-ba009b6a95f7`。
    - F1 真实有两条路径：systemd/process 隔离下 Master 能观察到 Worker 进程退出，走 supervisor 路径收尾为 `FAILED`（`WORKER_CRASHED`）；租约回收路径（`LEASE_EXPIRED` + `MANUAL_REVIEW_REQUIRED`/`AUTO_RECOVERY`）只在 Master 观察不到 Worker 之死时生效（例如 Master 自身重启）。两条路径都验证了「不残留 microVM 进程」与「故障态对其它租户 404」。
    - F2 要求 Master 单元用 `Wants=harness-broker.service` 而不是 `Requires=`：`Requires=` 会让 `systemctl stop harness-broker` 连带停掉 Master，F2 场景无法成立。已改为 `Wants=`（`deploy/harness.service.example`、单机部署文档与线上单元同步）。
  - F6：真机在 Run 处于 `RUNNING` 时执行 `harness-ops.ts backup`（产物 `/data/harness/backups/harness-20261011T124518Z.sqlite`，3,616,768 bytes），再用 `audit-chain-smoke.ts --database <备份>` 校验 → `AUDIT_CHAIN_VERIFY_OK`（`ok:true, checked:2461, legacy:0`）。
  - 回归：`p0-e2e-smoke` → `P0_E2E_SMOKE_OK label=4aa71edd`（serial maxActive=1、concurrent maxActive=2 overlap=true、跨租户 run/events/output/interrupt/对方 workspace 提交全部 404）；远程 `bun test ./tests` = 592 pass / 0 fail。
  - 环境备注：校园网到 opencode.ai 的 IPv4 Cloudflare 段（172.65.90.0/24）不可达而 IPv6 可达，线上 `/etc/hosts` 临时固定 `2606:4700:78::90:0:141` / `...:143 opencode.ai`（注释 `harness-model-pin`），并在 Worker egress 放行 `2606:4700:78::/48`；IPv4 恢复后可移除该固定。
