# IMPLEMENTATION_PLAN.md — 重建实现计划(草案 v0)

- 日期:2026-11-21。状态:Phase 0 草案,待用户确认 §3 决策后生效。
- 需求来源:`SPEC.md`(v0.1,提交 638a723)。本文件回答"怎么建、按什么顺序、怎么验证"。
- 重大方案变化:更新本文件 + 在 `platform/docs/decisions/` 写 ADR;不静默改动。

## 1. 已核实事实(2026-11-21,均来自实际命令,非假设)

仓库与分支:
- 当前分支 `codex/rebuild-from-zero` = 远程同分支 = `638a723`(SPEC 提交),无后续提交;`git ls-remote` 逐分支比对,本地远程视图一致。
- `master`(896db64)的全部提交已包含在 rebuild 分支内,无 rebuild 之外的隐藏变更;其余分支(feat/microvm-sandbox / refactor/slim-core / refactor/user-scope)同为其祖先链。
- 旧 CI:`.github/workflows/ci.yml` = bun typecheck + `bun test ./tests` + platform soak + scheduler benchmark。新代码落地后需更新 CI(Phase 1 任务)。
- 运行约束:本工作区是主仓库 `~/Desktop/resume_proj/VRAM-Aware-Harness` 的 git worktree;当前执行环境对主仓库 `.git` 只读(fetch/add/commit 均报 `Operation not permitted`),worktree 内嵌套自包含 git 仓库则完全可写(已实测)。解法见 §3 D9。

旧项目(参考资产,不是交付):
- 技术栈:Bun + TypeScript + SQLite;沙箱 = jailer + Firecracker(生产)/ Docker+runsc(开发);引擎 = `@earendil-works/pi-coding-agent`(Pi)经 `src/runtime/pi-adapter.ts` 适配;模型 = 外部 OpenAI 兼容服务。
- 可复用知识:Firecracker rootfs 构建(`scripts/microvm/`)、快照预热(旧实测热启动 498ms→176ms)、VM 分相埋点、调度基准与浸泡测试脚本、工具记账模型(PREPARED→SUCCEEDED/FAILED)、宿主 systemd 单机部署文档。
- 旧测试基线 675 pass(旧项目自报,未在本环境复跑;与新平台验收无关)。

本机环境(macOS 26.4.1,Apple arm64):
- 可用:bun 1.3.13、node 23.11、python3 3.13、sqlite3 3.51、Docker CLI 29.2(守护进程当前未运行)、jq、git。
- 不存在:firecracker、qemu、lima、podman、runsc。Firecracker 需 Linux KVM,无法在 macOS 运行。
- 结论:本机承担 T0–T2 与 Docker dev 档;真实 VM 层级(T3)必须在外部 Linux 宿主执行。

外部依赖核实:
- `@earendil-works/pi-coding-agent`:npm 最新 1.6.0(MIT);旧项目锁 0.80.10。接入版本 Phase 2 冒烟对比后锁定(AGT-05 要求记录配置版本)。
- Terminal-Bench:经 GitHub 搜索 API 核实现属 `harbor-framework` org,Apache-2.0;相关仓库:terminal-bench(-1,经典版)、terminal-bench-2、terminal-bench-science、harbor 评测框架。任务与版本未冻结(SPEC §2);Phase 6 前完成选型、许可与环境复现检查。

安全:
- 密钥卫生(2026-11-21 核查后修正早前误报):`deploy/a6000-harness.env` 曾被直接入库且非 `.example` 命名——初判"真实密钥泄漏"是**误报**。全历史核查:该文件自入库(0b04409)起仅含占位符 `change-me-to-a-long-random-value`,从未有真实值;全 223 提交密钥格式泛扫零命中。已于同日在 5 个远程分支(master/codex/rebuild-from-zero/feat/microvm-sandbox/refactor/slim-core/refactor/user-scope)提交卫生修复:改名 `.env.example` + `.gitignore` 增加 `deploy/*.env`,提交区间 50b6356..9b9b418 已推送验证。结论:无泄漏 → 无需轮换、无需历史重写(重写会导致全部公开 SHA 变化,包括 SPEC 提交 638a723,不建议)。除非怀疑 git 之外渠道暴露,才需在部署服务器侧换 `HARNESS_AGENT_API_KEY` 值并重启服务。

### 1.1 执行宿主实测(2026-11-21,`ssh server-desktop`,即 172.17.43.193 / 100.109.218.52)

- 系统:Linux 6.8.0-136-generic(Ubuntu 22.04),192 vCPU,251 GiB 内存,根分区 3.5T 已用 92%(可用 **291 GiB**)。
- GPU:**2 × NVIDIA RTX PRO 6000 Blackwell Server Edition,各 97,887 MiB**(旧的 RTX A6000 已下线,用户确认最新部署在此机)。
- 虚拟化:`/dev/kvm` 存在;`cxr` 属 `sudo,kvm,docker` 组,**可读写 /dev/kvm**;`sudo` **需要密码**(无法免密自动化)。
- Firecracker 资产已在位:`/home/cxr/microvm-test/bin/{fc117,firecracker,jailer,jailer117,vmlinux}`(fc117 = **Firecracker v1.17.0**;`jailer` 为 v1.10.1,`jailer117` 版本未取到),镜像 `rootfs.ext4`(256M)、`workspace-template.ext4`(128M)。`firecracker`/`jailer` 均不在 PATH 中。
- 容器运行时:Docker 29.1.3 运行中。
- **旧系统仍在生产运行**:`harness.service`(bun,0.0.0.0:3100,`/health` 200)、`harness-broker.service`、另一个 bun 应用占 3000;数据库 `/data/harness/live-full-flow/harness.sqlite`(144 users / 255 agent_runs / 15.5MB)。
- 该库 `api_credentials` 表**只有 1 条记录**:tenant `bootstrap`、scopes `["*"]`、创建于 2026-10-10、未撤销;`key_digest` 长度 64(仅存摘要,不存明文)。**运行进程中不存在 `HARNESS_AGENT_API_KEY`**(所有 HARNESS_ 变量名已核对),说明本部署从未启用 agent-runtime 凭证;`HARNESS_BOOTSTRAP_API_KEY` 存在。

### 1.2 密钥轮换结论(2026-11-21)

- git 侧:无真实密钥,无需轮换(见下条)。
- 生产侧:`HARNESS_AGENT_API_KEY` 未设置 → 没有可轮换对象。真正在用的是 `HARNESS_BOOTSTRAP_API_KEY`(DB 中 `bootstrap` 凭证)。若要做卫生轮换,应针对它:改 `/etc/harness/master.env`(root 0600)→ 重启 `harness.service` → 在 DB 中把旧 `api_credentials` 行 `revoked_at` 置位 → 更新持有该 key 的客户端。该操作需要 sudo 密码,由用户执行或提供一次性授权方式;执行前须确认不影响正在运行的生产服务。

## 2. 目标架构(v1 提案)

控制面(身份、准入、调度、持久化、恢复决策)与执行面(驱动引擎、工具授权与执行、VM 生命周期)逻辑分离;v1 允许同进程部署,但模块边界与数据流先定义清楚。

```
HTTP API ── auth ── RunService ── SQLite(users/sessions/runs/attempts/events/ledger/artifacts)
                     │
                Scheduler(准入 / 公平 / 超时)
                     │
                RunExecutor ── HarnessAdapter(Pi SDK;Run↔底层 session 映射落库)
                     │
                ToolGateway(授权、PREPARED 记账、结果留痕)
                     │
                SandboxProvider(接口;能力差异显式声明,不满足策略时明确失败)
                 ├─ docker 档(开发,macOS 本机)
                 └─ firecracker 档(生产,Linux 宿主;复用旧 rootfs 构建知识)
```

核心对象按 SPEC §4:User / Session / Run / Attempt / Workspace / Execution Environment / Tool Invocation / Artifact。执行环境物理实例可替换,不是任务状态唯一载体。

## 3. 关键决策

已确认(来自 SPEC 与用户指示):VM 为确定的执行隔离方向;先完整接入一个引擎;平台评测与 Agent 任务评测分离并建独立对照;保留旧代码不动;小规模可验证部署优先;评测看实际证据不看自述。

待用户确认(均已附建议,否决即改):

- D1 新代码位置。备选:`platform/` 子目录(旧目录不动、边界清晰)vs 直接替换根目录(违反"先定迁移再动旧代码")vs 独立仓库(失去参考与历史关联)。建议:`platform/`。
- D2 后端语言。备选:TypeScript+Bun(Pi SDK 原生 TS、旧代码可对照学习、单语言全栈)vs Python(评测生态强、但长驻服务与 Pi 接入需子进程桥)vs Go(部署最简、但全部重写且 Pi 需协议桥)。建议:TS+Bun;Python 仅用于 Terminal-Bench 评测驱动。
- D3 数据库。备选:SQLite(单机 v1 匹配、旧项目已验证 1000 Run/20 用户浸泡能力)vs Postgres(多机才需要)。建议:SQLite,存储层留替换缝。
- D4 VM 组件与档位。生产 Firecracker(复用旧项目经验)+ 本机 Docker dev 档 + 外部 Linux 宿主跑 T3。macOS 无 KVM,lima/UTM 无法承载 Firecracker(不做无效尝试)。建议:两档 SandboxProvider,能力差异显式声明(ISO-05:不满足即失败,不静默回退)。
- D5 引擎版本。Pi 0.80.10(旧代码已知可用)vs 1.6.0(当前最新)。建议:Phase 2 双版本冒烟对比后锁定。
- D6 模型服务。**已确认(用户 2026-11-21):继续用模型 API(托管),不自建 vLLM。** 具体厂商/模型/额度在 Phase 2 开工前确认,不影响 Phase 1。
- D7 T3 宿主。**已确认(用户 2026-11-21):用 server-desktop(172.17.43.193 / 100.109.218.52),2×RTX PRO 6000,`/dev/kvm` 可用。** 实测见 §1.1。约束:sudo 需密码;根分区仅余 291 GiB;同机跑着旧生产服务,**T3 实验必须用独立数据目录 + 独立端口 + 独立 systemd 单元名**,不得重启或改动 `harness.service`/`harness-broker.service`。
- D8 benchmark 选择。terminal-bench-1(经典、任务格式稳定)vs terminal-bench-2 / harbor 框架。建议:Phase 6 前小型试跑(环境可复现 + 参考结果可通过 + 已知错误可识别)后定。
- D10 VM 栈复用方式。备选:A 整包搬入 / B 驱动层原样搬 + 适配层重写 / C 仅参考重写。建议 **B**,理由与证据见 §3.5。若否决,请指明希望保留或替换的具体部分。
- D9 git 工作流修复。**已确认(用户 2026-11-21,按建议执行)**:改用自包含 clone 作为唯一工作区,**路径 `repo/`(位于本目录内)**;原 worktree 降级为只读参考。所有 add/commit/push 在 `repo/` 内进行,远程为 GitHub。

## 3.5 VM 档位复用审计(2026-11-21,基于实际读码与实跑,不是估计)

结论先行:旧项目的 microVM 栈**可复用性很高,但只能按"驱动层原样搬 + 适配层重写"的方式复用**,不能整包搬入。这也是 D10。

### 3.5.1 资产清单(实测)

| 资产 | 位置 | 规模 | 复用判断 |
|---|---|---|---|
| Firecracker 驱动 | `src/sandbox/microvm/firecracker-sandbox-driver.ts` | 1,322 行 | 原样搬 |
| 驱动接口缝 | `src/sandbox/microvm/microvm-types.ts`(`MicrovmDriver`/`MicrovmCreateOptions`/`MicrovmExecutionResult`) | 113 行 | 原样搬,作为新平台唯一依赖面 |
| vsock 桥 | `src/sandbox/microvm/firecracker-vsock-bridge.ts` | 436 行 | 原样搬 |
| 运行目录/UID/CID/并发闸/孤儿回收/快照管理/工作区盘导出/串口桥 | `src/sandbox/microvm/{vm-run-directory,vm-uid-allocator,vm-cid-allocator,vm-concurrency-gate,vm-orphan-reaper,vm-snapshot-manager,workspace-disk-exporter,firecracker-serial-bridge,shared-base-files,jailer-prereq-check}.ts` | 约 1,400 行 | 原样搬 |
| Provider 适配层 | `src/sandbox/microvm/microvm-sandbox-provider.ts` | 446 行 | **重写**(它绑定旧 `SandboxStore`/`EffectivePolicySnapshot`/`WorkspaceCommitCoordinator`) |
| guest agent | `guest/agent/main.ts`(181)/`guest/agent/agent.c`(1047) | 双实现 | 原样搬;协议 v1 冻结 |
| rootfs 构建与补丁脚本 | `scripts/microvm/{build-guest-rootfs,preflight-microvm,patch-guest-rootfs-bootmarks,patch-guest-rootfs-c-agent,patch-guest-rootfs-tmpfs}.sh` | 5 个 | 原样搬(Linux 侧执行) |
| 回归测试 | `tests/sandbox/microvm-*.test.ts`、`firecracker-vsock-bridge.test.ts`、`tests/sandbox/vm-allocators.test.ts` | 5+ 文件 | 随代码一起搬 |

### 3.5.2 可搬性的硬证据

- `src/sandbox/microvm/*` 的全部 import 只有两类:`node:*` 内置模块 与 同目录 `./*`。唯一越界导入集中在 `microvm-sandbox-provider.ts` 的 4 行(`../../workspaces/workspace-commit-coordinator.ts`、`../../policies/effective-policy.ts`、`../sandbox-store.ts`、`../sandbox-profile.ts`)。**驱动与全部机制文件零外部耦合。**
- 旧 `package.json` 运行时依赖只有 1 个(`@earendil-works/pi-coding-agent@0.80.10`)——microVM 栈完全建立在内置模块上,搬入新平台不引入依赖债。
- 本机(macOS,无 KVM)实跑:`bun test` 4 个 microvm 测试文件 → **30 pass / 0 fail / 96 expect / 601ms**。说明失败闭锁语义(fail-closed)、warmHit 回传、Provider 终止顺序、网络策略拒绝等逻辑可在 T0 层持续回归。

### 3.5.3 真机验证证据(docs/microvm-live-validation.md,宿主 172.17.43.193,官方 Firecracker v1.17.0 + jailer v1.17.0,真实 KVM)

- jailer 模式 **23/23 通过**;快照恢复到 agent 可执行 **368ms**,对比冷启动 2519ms,提速 **6.9 倍**;裸 API 层 `/snapshot/load` 恢复延迟 3ms。
- 端到端 agent 执行闭环(jailer 与非 jailer 各一轮)**20/20 通过**,含 secret 经 env 注入、创建耗时 1467/1524ms、`evidence.verified=true`。
- 攻击烟测 **37/37 通过**;隔离证据从"目录不存在"升级到**块设备层 + cgroup 层**;资源耗尽损失止于 guest 边界,宿主零副作用。
- 冷启动调优:内核参数 `i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd` 使 guest userspace 从 uptime 0.85s 提前到 0.05s,冷启动 1338ms → **539ms**;事件循环抖动从 212ms 降到 **20.99ms**(导出/删除改异步)。
- 已修复的真实缺陷(只列会影响重写判断的):Alpine minirootfs 符号链接被 debugfs 填充丢弃导致 kernel panic 找不到 `/sbin/init`;vsock 握手应重试而非单次 3s;`SnapshotLoadParams` 在 v1.17/v1.18 均无块设备覆盖字段 → 块设备路径必须固化。

### 3.5.4 已知限制(搬迁时一并承接,写入边界文档)

1. vsock 协议 v1 对伪造 `exec_result` 的防护是"先到者生效"——防护目标是宿主编排正确性,不是 guest 内攻击者;guest 是信任域,由 KVM 边界兜底。
2. 工作区盘未加密(dm-crypt 需特权),v1 以 0700 私有目录 + 终止销毁替代。
3. jailer 与快照组合需要 root;非 jailer 模式不支持多用户快照隔离。
4. E2B 驱动是 fail-closed 桩,不得计入能力。
5. 驱动只在 Linux + `/dev/kvm` 上提供真实隔离;macOS 上只能跑 mock 与失败路径。

### 3.5.5 三个方案与取舍

- **A 整包搬入** `src/sandbox/`(含旧 Provider/Store/Policy)。快,但会把旧平台的 `SandboxRecord`、`EffectivePolicySnapshot`、`WorkspaceCommitCoordinator` 语义一起带进来;新平台的 Run/Attempt/归属/核算模型要再拆一次,而且"旧接口已存在"最容易被误当成交付证据。否。
- **B 驱动层原样搬 + 适配层重写**(建议)。边界就是 `microvm-types.ts` 的 `MicrovmDriver`:新平台定义自己的 `SandboxProvider`(按 VM-01~06 的语义),写一个 adapter 做映射;驱动、vsock 桥、guest agent、rootfs 脚本、回归测试全部原样带过来。旧 Provider 只作为参考实现读,不搬。
- **C 只参考、全部重写**。会丢掉上表中全部真机踩坑修复(符号链接、握手重试、异步导出、chroot socket 可见性、块设备路径固化),这些恰恰是纯靠文档无法复现的部分。否。

### 3.5.6 复用能省什么、不能省什么

- 省:内核/rootfs 构建、vsock 协议与握手、jailer 权限模型、快照创建与恢复、孤儿进程回收、磁盘导出、资源核算的底层实现。预计 Phase 3 中"VM 机制"部分工作量下降 60–70%,并消灭最大的技术未知。
- 不省(必须在 Phase 3 按 SPEC 重做):VM 生命周期的**记账与对账**(状态落库、崩溃后残留对账)、**可用性语义**(VM-02:以"验证工具可执行"为准,而非进程存在)、**归属与配额**、**故障注入与有界恢复**、**停止/清理分离的可观测三段**。旧的 `evidence.verified` 自证不构成新平台的完成证据。
- 不省:**T3 宿主**(D7)。复用不改变"必须在 Linux + KVM 上跑"这一事实。

## 4. 测试分级映射(层级定义见 AGENTS.md §4)

- T1 支撑:持久化、状态机、准入、归属检查、取消语义、恢复对账。
- T2 支撑:AGT-01~05、ISO-03/04(进程级)、REC-01/02。
- T3 支撑:ISO-05、VM-01~05。
- T4 支撑:SPEC §7 全部指标。SPEC §7.8 的"确定性模式"≙ T1(脚本驱动真实平台),"真实 Agent 模式"≙ T2/T4;两者不可互替。

## 5. 分阶段计划

每阶段结构固定:目标 / 范围(含 SPEC 覆盖)/ 交付物 / 验证与出口标准 / 明确不主张 / 前置依赖。阶段完成 = 独立提交 + 阶段报告(追加到本文件 §9)。

### Phase 0 — 文档与决策(当前阶段)
- 目标:冻结协作规则与关键决策,建立可执行的 git 工作流。
- 交付:AGENTS.md、本文件、D1–D9 确认结果、密钥卫生修复(已完成并推送)、`platform/` 骨架(仅目录与 README,可选)。
- 出口:用户确认关键决策;文档定稿并形成第一个提交;git 工作流(D9)可用。
- 不主张:任何平台能力。

### Phase 1 — 核心对象与持久化地基("已接受的任务经得起崩溃")
- 范围:User/Session/Run/Attempt/Workspace 对象与 SQLite schema + 向前迁移;追加式事件表;Run 状态机(accepted→queued→running→终态);API Key→User 认证;read/cancel/download 的归属检查;全局 + 单用户并发上限与排队(等待原因可见);接受持久化边界;确定性模拟 executor(脚本推进状态与事件,明确标注 T1)。
- SPEC 覆盖:ISO-01、ISO-02(对象级)、SCH-01、SCH-03(基础)、SCH-05(超时雏形)、REC-01/02(部分)。
- 验证出口(全 T1):(a) accepted 后进程崩溃→重启→任务与事件可对账,无已接受任务丢失;(b) 用户 B 对用户 A 的 run 做 read/cancel/download 全部拒绝并留审计;(c) 并发超额时排队且原因可见;(d) 取消/完成/重启后的配额与状态核算一致(SCH-04 雏形)。
- 不主张:模型、引擎、VM、ISO-03 全量、执行自动恢复。

### Phase 2 — 单引擎真实接入(Pi)
- 范围:HarnessAdapter:提交输入→事件流→结束判定→取消传播;Run↔底层 session 映射落库;工具调用经平台账本与策略(本阶段宿主目录围栏,无 VM);配置版本记录(模型/Harness/工具/权限,AGT-05)。
- SPEC 覆盖:AGT-01、AGT-02、AGT-03、AGT-05(部分)、ISO-03/04(进程级)、REC-01/02(引擎维度)、REC-06(雏形)。
- 验证出口(全 T2,模型经托管 API):真实模型端到端 Run(输入→事件→产物);取消传播实测;映射与事件归属不因崩溃丢失;并行双用户事件不串扰(ISO-03 进程级)。
- 不主张:VM 隔离。工具仍在宿主受围栏目录执行——记录为临时风险,Phase 3 消除。

### Phase 3 — VM 执行环境生命周期
- 前置:D10 定案。
- 范围:SandboxProvider 接口(新平台自有,按 VM-01~06 语义)+ docker dev 档 + firecracker 生产档;按 D10-B 搬入驱动层(`src/sandbox/microvm/` 除旧 Provider 外)+ guest agent + rootfs 脚本 + 回归测试,新写 adapter;工作区准备/产物回收;VM-02 可用性验证(以"验证工具可执行"为准,非进程启动);工具经 VM 执行(ISO-05);创建失败/运行中退出/健康异常/清理失败处理与平台重启残留对账;持久产物与临时环境分离(VM-05);VM 资源核算。
- SPEC 覆盖:ISO-05、VM-01~05(VM-06 仅"能用"级)、REC-03(停止/清理分离)、SCH-03(执行中等待 VM)。
- 验证出口:T1 docker 档全链路 + 有限故障注入(创建失败、运行中退出、清理失败);T3 真实 VM(宿主已确认为 server-desktop):可用性验证通过、残留对账通过、取消→停止→清理三段可见。
- 不主张:快照/预热优化对比(Phase 6)、任意故障自动恢复。

### Phase 4 — 调度公平、取消语义与有界恢复
- 范围:用户间公平策略(声明式:轮转 + 老化一类);等待/执行两类状态可视化端点;超时强制边界(SCH-05);取消请求→执行停止→清理完成三段语义(REC-03);声明支持的故障集并阶段化注入(REC-04/07);防双活执行(租约或单写者约束,REC-05);工具重试按效果账本契约(REC-06)。
- 验证出口:T1 故障套件(工具执行前 / 副作用已产生未保存等阶段注入);调度基准脚本(§7.3 方法论:均匀/突发/长短混合/单用户大量提交);核算不变量在混乱重启下保持(SCH-04)。
- 不主张:大规模生产能力。

### Phase 5 — 用户入口与管理视图
- 范围:最小用户 UI(提交、状态、时间线、产物、取消、等待原因);管理视图(队列、执行实例、资源、故障定位);管理员内容权限边界(SPEC §3:admin ≠ 全内容访问,范围显式定义);工作区显式提交协议(冲突可见、产物保留、不自动合并)。
- SPEC 覆盖:ISO-02/06(视图与冲突)、SCH-02/03(可视化)、AGT-04(持续助手语义与底层进程常驻解耦)。
- 验证出口:T1/T2 双用户 + 管理员端到端;越权路径(前端隐藏按钮不替代后端检查);冲突状态可解释、产物未静默覆盖。
- 不主张:多引擎、长期记忆、插件生态、自动合并。

### Phase 6 — 评测体系(SPEC §7 全面落地)
- 范围与出口:
  - §7.2 平台正确性套件:多用户标记数据、非法访问、并行变更与竞态;检查实际文件与外部测试服务,不只查返回码。出口:违规数 = 0 的声明附覆盖范围说明。
  - §7.3 调度基准:固定负载档案,报告排队/等待/吞吐/并发减速比。出口:策略修改前后可比一轮。
  - §7.4 VM 生命周期基准:申请→可执行验证耗时、占用、残留数;冷启动 vs 快照、按需 vs 预热 A/B。出口:含后台维护成本的完整一轮。
  - §7.5 故障与恢复套件:阶段化注入,报告取消时延、恢复时间、重复副作用、丢失数。出口:规定场景通过率 + 故障正确处理率。
  - §7.6 Agent 任务评测与对照:Terminal-Bench 子集(依赖 D8)+ 独立 Harness 基线 + 两类对照(独立执行 vs 平台管理;原环境 vs VM 环境)。出口:独立验证器判定的通过率 + 差异归因说明。
  - §7.7/7.8 数据与记录:每用例关联来源/版本/输入/初始环境/权限/预算/判定;回归用例入库;结果含版本与原始数据。
- 不主张:官方完整榜单名次;子集冒充完整结果(明确标注)。

### Phase 7+(v1 之后)
长期记忆、授权共享深化、多引擎、多机与高可用(SPEC §6 明确排除在 v1 之外)。

## 6. SPEC 追踪矩阵(每阶段更新;状态 ∈ 未开始/进行中/已验证(层级)/部分)

| 需求 | 计划阶段 | 验证载体 | 状态 |
| --- | --- | --- | --- |
| ISO-01 认证可信 | P1 | 归属与认证测试 | 未开始 |
| ISO-02 对象级权限 | P1(对象)/P5(视图) | 越权负路径测试 | 未开始 |
| ISO-03 不跨用户串用 | P2(进程级)/P6 | 事件归属测试 + §7.2 套件 | 未开始 |
| ISO-04 Agent 不越权控制面 | P2/P3 | 策略拒绝记录测试 | 未开始 |
| ISO-05 VM 内执行,不静默回退 | P3 | T3 隔离探针 | 未开始 |
| ISO-06 显式共享与冲突 | P5 | 冲突可见性测试 | 未开始 |
| ISO-07 拒绝与执行留痕 | P2/P4 | 审计事件检查 | 未开始 |
| SCH-01 准入与限制 | P1 | 排队/拒绝测试 | 未开始 |
| SCH-02 用户公平 | P4 | 调度基准 | 未开始 |
| SCH-03 等待状态区分 | P1/P3 | 状态端点测试 | 未开始 |
| SCH-04 核算一致 | P1/P4 | 混乱重启核算 | 未开始 |
| SCH-05 超时边界 | P1/P4 | 超时强制测试 | 未开始 |
| VM-01 生命周期 | P3 | T1+T3 全链路 | 未开始 |
| VM-02 可用性=工具验证 | P3 | 可用性探针 | 未开始 |
| VM-03 绑定与权限可追踪 | P3 | 复用/恢复后状态检查 | 未开始 |
| VM-04 故障与残留处理 | P3/P4 | 注入与对账测试 | 未开始 |
| VM-05 产物与临时分离 | P3 | 回收后产物保留检查 | 未开始 |
| VM-06 优化策略(候选) | P6 | A/B 基准 | 未开始 |
| REC-01 接受持久化边界 | P1 | 崩溃对账 | 未开始 |
| REC-02 状态与事件保存 | P1/P2 | 崩溃对账 | 未开始 |
| REC-03 取消三段语义 | P3/P4 | 取消时延测试 | 未开始 |
| REC-04 有界故障处理 | P4 | 故障套件 | 未开始 |
| REC-05 防双活执行 | P4 | 恢复竞态测试 | 未开始 |
| REC-06 工具重试语义 | P4 | 幂等/未知效果测试 | 未开始 |
| REC-07 支持故障范围声明 | P4 | 声明文档 + 套件对应 | 未开始 |
| AGT-01 单引擎完整接入 | P2 | T2 端到端 | 未开始 |
| AGT-02 Run↔底层映射 | P2 | 映射持久化测试 | 未开始 |
| AGT-03 工具经平台授权 | P2/P3 | 账本与策略测试 | 未开始 |
| AGT-04 助手语义解耦 | P5 | 并行映射验证 | 未开始 |
| AGT-05 配置版本记录 | P2 | 版本快照检查 | 未开始 |
| §7.2 平台正确性评测 | P6 | 套件报告 | 未开始 |
| §7.3 调度评测 | P6 | 基准报告 | 未开始 |
| §7.4 VM 评测 | P6 | 基准报告 | 未开始 |
| §7.5 故障评测 | P6 | 套件报告 | 未开始 |
| §7.6 任务评测与对照 | P6 | 评测报告 + 基线 | 未开始 |
| §7.7/7.8 数据与记录规范 | P6 | 用例登记表 | 未开始 |

## 7. 阶段报告模板

每阶段结束追加到 §9:实际执行的命令与结果摘要 / 达到的最高测试层级 / 未覆盖项 / 已知限制 / 下一步计划。

## 8. 风险与未决

- T3 依赖外部 Linux 宿主(D7);未落实前 ISO-05/VM 系列只能以 docker dev 档 + 能力声明推进,不得声称真实 VM 验证。
- T2 依赖模型服务(D6);未落实前 Phase 2 只能停在 T1(模拟引擎事件)。
- Terminal-Bench 任务在 VM 内的适配量未知;Phase 6 第一步是环境可复现检查,失败任务明确标注而非剔除。
- ~~旧项目密钥泄漏~~ 已核实为误报并处置完毕(见 §1):占位符模板已改名 `.example` 并 gitignore `deploy/*.env`,历史干净,开源宣传无此阻塞。
- 主仓库 `.git` 写受限(D9):不解决则无法形成阶段提交,违反交付纪律。

## 9. 阶段报告(逐阶段追加)

_(Phase 0 报告将在决策确认后追加)_
