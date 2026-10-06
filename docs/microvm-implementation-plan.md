# microVM 平台详尽实施方案（Phase 1–4）

> **读者**：负责写代码的 AI 实现者。
> **前置阅读**：`docs/platform-boundary.md`（八条边界，不可违背）、`docs/microvm-migration-explainer.md`（概念背景）。
> **本方案的性质**：这是施工图纸，不是讨论稿。凡是标注【硬约束】的条目，实现时必须逐字遵守；
> 遇到方案与现有代码冲突，停下来报告，不要自行变通。
>
> **实现者守则（违反即视为失败）**：
> 1. 禁止伪造执行结果、隔离证据、指标数据。任何"做不到"必须抛错，禁止静默降级。
> 2. 每完成一个 § 小节，运行该小节列出的测试命令，全绿才能进入下一节。
> 3. 禁止改动【不要动】清单里的文件。
> 4. 新代码必须过 `npx tsc --noEmit`（基线已有错误清单见附录 D，不得新增错误）。
> 5. 测试用 `bun test`，全部测试路径下不得跳过用例。
> 6. 涉及 shell 命令拼接的地方，一律用参数数组（Bun.spawn([...])），禁止字符串模板拼命令。

---

## 0. 总览

| 阶段 | 目标 | 预计交付物 | 验收 |
|---|---|---|---|
| Phase 1 | jailer + vsock agent + 私有运行目录 | §1.1–§1.5 全部新文件 + 改造清单 | §1.6 测试清单全绿 |
| Phase 2 | 工作区导出 + 磁盘限额 + 租户准入接入 | §2 全部 | §2.4 验收 |
| Phase 3 | snapshot/restore + CoW + microVM 预热池 | §3 全部 | §3.4 验收 |
| Phase 4 | 出口网关 + controlled-egress + GPU ACL | §4 全部 | §4.4 验收 |

**代码仓库基线**：分支 `feat/microvm-sandbox`，Phase 0 已完成（fail-closed）。
关键现状文件（实现前必须通读）：
- `src/sandbox/microvm/firecracker-sandbox-driver.ts` — 将被大幅重写
- `src/sandbox/microvm/microvm-sandbox-provider.ts` — 将被部分修改
- `src/sandbox/microvm/firecracker-serial-bridge.ts` — Phase 1 后仅保留作为"镜像未装 agent 时的启动探测"
- `src/sandbox/sandbox-startup-reconciler.ts` — 启动孤儿回收，需要扩展
- `tests/sandbox/microvm-sandbox-provider.test.ts`、`tests/sandbox/microvm-boundary-isolation.test.ts` — 现有测试，不得删除，只能按新行为更新断言

【不要动】清单：`src/sandbox/container-*`、`src/auth/**`、`src/storage/**`、`src/scheduling/**`、`src/llm-gateway/**`、`src/http/**`（Phase 4 的网关 ACL 例外，见 §4.3）。

---

# Phase 1：jailer + vsock agent + 私有运行目录

## 1.1 私有运行目录（vm-run-directory.ts）

### 目标
消灭 `/tmp` 下的可预测路径。每台 VM 的所有宿主侧文件（socket、rootfs 副本、工作区盘、vsock UDS）放在一个 `0700` 私有目录里。

### 新建文件 `src/sandbox/microvm/vm-run-directory.ts`

```ts
// 功能与实现要点（按此实现，接口签名照抄）：
import { mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

export interface VmRunDirectory {
    readonly root: string;        // 本 VM 私有目录绝对路径
    socketPath(): string;         // <root>/firecracker.socket
    vsockUdsPath(): string;       // <root>/vsock.sock
    rootfsPath(): string;         // <root>/rootfs.ext4
    workspaceDiskPath(): string;  // <root>/workspace.ext4
    dispose(): void;              // 递归删除 root（best-effort，不得抛错）
}

export interface VmRunDirectoryManagerConfig {
    /** 运行根目录。默认：HARNESS_VM_RUNTIME_ROOT 或 /var/lib/harness/vm（需可写） */
    readonly runtimeRoot?: string;
}

export class VmRunDirectoryManager {
    constructor(config: VmRunDirectoryManagerConfig = {});
    /** 创建 <runtimeRoot>/<sandboxId>，mode 0700。sandboxId 只允许 [a-zA-Z0-9-]，长度 ≤ 64，否则抛错。 */
    allocate(sandboxId: string): VmRunDirectory;
    /** 供启动协调器调用：列出 runtimeRoot 下所有现存目录名。不存在 runtimeRoot 返回 []。 */
    listOrphans(): string[];
    /** 删除指定 sandboxId 的目录；不存在时静默成功。 */
    dispose(sandboxId: string): void;
}
```

【硬约束】
- 目录权限必须显式 `mkdirSync(root, { recursive: true, mode: 0o700 })`，并在创建后 `chmodSync(root, 0o700)`（umask 可能清位）。
- sandboxId 校验失败必须抛错（路径注入防护）。
- `dispose` 内部 try/catch，永不抛错（协调器不能因为它崩）。

### 配置接入
在 `src/app/harness-config.ts` 的 `HarnessConfig` 增加字段并解析（照抄现有 `firecrackerWorkspaceDiskTemplatePath` 的模式）：

| 环境变量 | 配置字段 | 默认 |
|---|---|---|
| `HARNESS_VM_RUNTIME_ROOT` | `vmRuntimeRoot?: string` | `/var/lib/harness/vm` |

### 启动协调器扩展
修改 `src/sandbox/sandbox-startup-reconciler.ts` 不动；在 `MicrovmSandboxProvider.cleanupStale()` 内部调用 `VmRunDirectoryManager.dispose(record.id)`（Phase 0 的 provider 已有 cleanupStale，往里加一行即可）。另在 `create-harness-application.ts` 应用启动处、reconciler 运行之后，调用 `manager.listOrphans()` 与 `sandboxes` 表比对：凡是不在 ACTIVE/PROVISIONING 记录里的目录，全部 dispose。

---

## 1.2 jailer 集成

### 概念（实现者必须理解）
Firecracker 官方 `jailer` 二进制负责把 Firecracker 进程关进笼子：专用 UID/GID 降权、chroot、netns、cgroup、seccomp。命令形态（照抄，不要自创参数）：

```bash
/usr/local/bin/jailer \
  --id <sandboxId> \
  --node 0 \
  --exec-file /usr/local/bin/firecracker \
  --uid <分配的UID> \
  --gid <分配的GID> \
  --chroot-base-dir <runtimeRoot>/<sandboxId>/jailer \
  --cgroup-version 2 \
  --cgroup cpu.max="<quota> <period>" \
  --cgroup memory.max="<bytes>"
# jailer 启动后，Firecracker 的 --api-sock 等参数追加在后面：
#   -- --api-sock /run/firecracker.socket
```

jailer 实际 chroot 根 = `<chroot-base-dir>/firecracker/<id>/root/`。Firecracker 在这个 chroot 里运行，所以 **kernel/rootfs/工作区盘/镜像内用到的所有文件都必须先复制进 chroot**，Firecracker API 里引用的路径必须是 **chroot 内路径**（如 `/rootfs.ext4`）。

### 前置条件检测（fail-closed）
新建 `src/sandbox/microvm/jailer-prereq-check.ts`：

```ts
export interface JailerPrereqResult {
    readonly ok: boolean;
    readonly failures: readonly string[];
}
export async function checkJailerPrereqs(config: {
    jailerBinaryPath: string;
    firecrackerBinaryPath: string;
    kvmDevicePath: string;
}): Promise<JailerPrereqResult>;
```

检查项（全部满足才 ok）：
1. jailer 与 firecracker 二进制存在且可执行（`accessSync(X_OK)`）；
2. `/dev/kvm` 可读写；
3. jailer 需要 root 权限或 `CAP_SYS_ADMIN`（检查 `process.geteuid() === 0` 或尝试 `capsh --print`；**实现简化：若 euid≠0，直接报告失败并提示"需要 root 运行 Harness 或给 jailer 配置 setuid"**）。

`FirecrackerSandboxDriver.isAvailable()` 改为：KVM 可访问 **且** jailer 前置全部通过（Phase 0 只查了 KVM）。

### UID/GID 分配
新建 `src/sandbox/microvm/vm-uid-allocator.ts`：

```ts
export class VmUidAllocator {
    /** base 默认 20000，上限 29999。分配 = base + (activeCount 扫描) 的最小未用值。 */
    constructor(private readonly baseUid = 20000);
    allocate(activeIds: readonly string[]): { uid: number; gid: number };
    // 实现：从 base 起找第一个未被 activeIds 对应分配占用的编号。
    // 驱动内部维护 Map<sandboxId, {uid,gid}>，terminate 时释放。
    // uid === gid === base + n。
}
```

【硬约束】UID 范围必须避开系统用户（< 1000）与宿主普通用户（通常 1000 起），用 20000+ 段；分配冲突时抛错而不是复用。

### 驱动改造 `firecracker-sandbox-driver.ts`（重写 create/terminate）

新的 `create()` 流程（严格按顺序）：

1. 前置校验：KVM + kernel/rootfs 存在（Phase 0 已有，保留）+ jailer 前置通过。
2. `manager.allocate(id)` 创建私有目录（§1.1）。
3. 复制文件到 jailer chroot 内（**异步**，禁止 copyFileSync 阻塞事件循环）：
   - 用 `Bun.spawn(["cp", "--reflink=auto", src, dst])`（不支持 reflink 的文件系统自动退化为普通复制）；
   - kernel → `<chroot>/kernel.bin`；rootfs 模板 → `<chroot>/rootfs.ext4`；workspace 模板 → `<chroot>/workspace.ext4`；
   - chroot 路径 = `<runtimeRoot>/<id>/jailer/firecracker/<id>/root/`。
4. 分配 UID/GID（§1.2.3），`chown -R uid:gid <chroot>`（用 spawn 执行 chown）。
5. 启动 jailer：`Bun.spawn(["jailer", "--id", id, "--node", "0", "--exec-file", firecrackerPath, "--uid", u, "--gid", g, "--chroot-base-dir", jailerBase, "--cgroup-version", "2", ...cgroupArgs, "--", "--api-sock", "/run/firecracker.socket"])`。
   - cgroup 换算：`cpu.max = "${cpuCores * 100000} 100000"`；`memory.max = ${memoryMb * 1024 * 1024}`（无策略限额则不下发对应参数，但 Phase 2 要求默认下发，见 §2.2）。
   - `detached: false`；把子进程句柄存入 `this.processes`。
6. 等 API socket 就绪（轮询 `<chroot>/run/firecracker.socket`，上限 1500ms，逻辑沿用现有）。
7. Firecracker API 配置（全部用 **chroot 内路径**）：
   - `PUT /boot-source`：`{ kernel_image_path: "/kernel.bin", boot_args: "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/init" }`（init 改为 busybox init，见 §1.3.4 镜像；不再用 `init=/bin/sh`）。
   - `PUT /drives/rootfs`：`{ drive_id: "rootfs", path_on_host: "/rootfs.ext4", is_root_device: true, is_read_only: false }`。
   - `PUT /drives/workspace`：`{ drive_id: "workspace", path_on_host: "/workspace.ext4", is_root_device: false, is_read_only: false }`。
   - `PUT /vsock`：`{ guest_cid: <分配的CID>, uds_path: "/run/vsock.sock" }`（见 §1.3.2 CID 分配）。
   - `PUT /machine-config`：沿用。
   - `PUT /actions`：InstanceStart。
8. 等 vsock agent 就绪（§1.3.5 握手），**不再**用串口 ready 检测。
9. 任何一步失败：清理（terminate 该 id）并抛错。

新的 `terminate()` 流程：先关 vsock 连接 → SIGKILL jailer 进程（SIGKILL jailer 会连带清掉 firecracker）→ 等待 100ms → `manager.dispose(id)` → 释放 UID/CID。

【硬约束】terminate 必须幂等（重复调用不抛错）；terminate 必须在 provider/协调器任何路径都能完成清理，不依赖 create 走到了哪一步。

---

## 1.3 vsock guest agent（命令通道）

### 1.3.1 概念
vsock 是 host↔guest 的专用 socket。宿主侧是 Firecracker 创建的 Unix Domain Socket（UDS）；guest 里是 `/dev/vsock`。协议握手（Firecracker 规定，照抄）：

```
宿主 -> UDS:  "CONNECT <guestPort>\n"
UDS  -> 宿主: "OK <assignedPort>\n"   （或 "ERROR ..."）
此后这条连接就是双向数据通道，直到任一端关闭。
```

### 1.3.2 guest CID 分配
新建 `src/sandbox/microvm/vm-cid-allocator.ts`：与 UID 分配器同构，base 3，上限 40000（CID 0–2 保留：0=hypervisor, 1=local, 2=host）。active 期间持有，terminate 释放。

### 1.3.3 应用层协议（v1，冻结）

帧格式：**newline-delimited JSON**（每帧一行 UTF-8 JSON，`\n` 结尾；单帧 ≤ 1 MiB，超限对端必须断开并报协议错误）。

宿主 → agent：

```json
{"v":1,"type":"exec","id":"<16位hex随机>","argv":["bash","-lc","..."],"cwd":"/workspace","env":{"FOO":"bar"},"timeoutMs":60000,"maxOutputBytes":1048576}
```

agent → 宿主（同一连接按序回传）：

```json
{"v":1,"type":"exec_output","id":"...","stream":"stdout","data":"<base64 chunk>"}
{"v":1,"type":"exec_output","id":"...","stream":"stderr","data":"<base64 chunk>"}
{"v":1,"type":"exec_result","id":"...","exitCode":0,"timedOut":false,"truncated":false}
```

规则（硬约束）：
- `argv` 直接 `execvp` 执行，**绝不经过 shell**（调用方需要 shell 时显式传 `["bash","-lc", script]`）；这样命令注入在协议层被根除。
- `id` 由宿主生成，agent 必须原样回带；宿主对未知 id 的帧直接丢弃。
- `env` 全量替换子进程环境（不是合并）；secret 通过这里注入。
- 超时：agent 先发 SIGTERM，2 秒后 SIGKILL，回 `timedOut: true`。
- 输出超过 `maxOutputBytes`：停止缓存（子进程继续跑），回 `truncated: true`。
- 每个 exec 独立子进程、独立 cwd/env——不共享会话状态（这是与串口方案的本质区别）。

### 1.3.4 Guest agent 实现

新建目录 `guest/agent/`，用 **Bun 单文件 + `bun build --compile` 生成静态二进制**（团队全 TS 技术栈，不要引入 Go/C 工具链）：

- `guest/agent/main.ts`：核心逻辑（约 300 行）：
  - 打开 vsock 监听：Bun 不原生支持 AF_VSOCK，**用一个 30 行的 C 转发器或 `socat` 兜底**。推荐：镜像里装 `socat`，agent 启动命令为 `socat VSOCK-LISTEN:5000,fork EXEC:'/agent/main'`，agent 读写 stdin/stdout 即可（这样 agent 代码完全不用碰 vsock 系统调用）。
  - 按行读请求 → 校验协议（v===1、type、字段类型）→ `spawn(argv[0], argv.slice(1), {cwd, env})` → pipe 输出 base64 分块（64KB/块）回写 → 结束时回 exec_result。
  - 协议非法帧：回 `{"v":1,"type":"error","id":null,"reason":"protocol"}` 并继续（不断开）。
- 构建：`bun build guest/agent/main.ts --compile --outfile build/guest-agent`。

新建脚本 `scripts/microvm/build-guest-rootfs.sh`（完整可运行，照抄结构）：

```bash
#!/usr/bin/env bash
# 用法: build-guest-rootfs.sh <agentBinary> <outputRootfs.ext4> <outputWorkspaceTemplate.ext4>
# 依赖: mkfs.ext4、debugfs 或挂载权限。禁止 sudo 交互——检测不到权限直接退出码 2。
set -euo pipefail
# 步骤（必须实现并在脚本头注释说明每一步）：
# 1. 下载 Alpine minirootfs（版本固定，校验 sha256，URL 与哈希写在脚本顶部变量里）；
# 2. 创建 256MB ext4 rootfs 镜像（dd + mkfs.ext4），优先 loop mount；
#    无挂载权限时退化用 debugfs 写入（debugfs -w -R "write <local> <remote>"），
#    脚本必须两种路径都实现，不得假设 root；
# 3. 解包 alpine、放入 guest-agent 到 /agent/main（chmod 755）、安装 socat（静态
#    编译版或 apk add --root 方式）；
# 4. 写入 /etc/inittab 启动 agent（见下）；
# 5. 创建 64MB 空白 ext4 作为 workspace 模板（仅含空的 / 目录）。
# 6. 输出两个文件路径，并做基本自检（debugfs -R "ls /agent" 能看到 main）。
```

`/etc/inittab` 内容（写入镜像）：

```
::sysinit:/sbin/mdev -s
::respawn:/usr/bin/socat VSOCK-LISTEN:5000,fork EXEC:/agent/main
::ctrlaltdel:/sbin/reboot
::shutdown:/bin/umount -a -r
```

内核要求（在 `scripts/server-preflight.sh` 里加检查并写进文档）：guest 内核必须启用 `CONFIG_VIRTIO_VSOCK`（官方 firecracker 快速入门内核已开启）；宿主 `modprobe vhost_vsock`。

### 1.3.5 宿主侧桥 `src/sandbox/microvm/firecracker-vsock-bridge.ts`

```ts
export class FirecrackerVsockBridge {
    constructor(private readonly udsPath: string) {}
    /** 连接 UDS、发 CONNECT 5000、等 OK。上限 3000ms；失败抛错。 */
    connect(): Promise<void>;
    /** 发送 exec 请求，聚合 exec_output，返回结构化结果。options 同现有 MicrovmExecuteOptions（含 onStdoutChunk 流式回调）。 */
    execute(command: readonly string[], options?: MicrovmExecuteOptions): Promise<MicrovmExecutionResult>;
    close(): void;
}
```

实现要点：
- 用 `node:net` 的 `createConnection({ path: udsPath })`；
- 内部按行缓冲解析帧（注意一条 TCP 数据可能含多帧或半帧——**这是最容易写错的地方，必须写专门的行缓冲单元测试**）；
- 命令组装：为兼容现有工具语义，`execute(["bash","-lc", script])` 形态不变；驱动层的 `execute(sandboxId, command, options)` 包装为 `{argv: command, cwd: options.workdir ?? "/workspace", env: 由 provider 注入的 secrets}`——注意 env 注入点：driver 需要拿到 secret 值。改 `MicrovmDriver.execute` 签名为 `execute(vmId, command, options?: MicrovmExecuteOptions & { env?: Record<string,string> })`，provider 在调用时从 `secretValues` 传入（对照容器链路 N13 的做法：名字入 spec、值只在调用时传递）。
- `waitForAgentReady()`：连接后发送 `{"v":1,"type":"ping","id":...}`，等 `{"type":"pong"}`（协议加这一对），3000ms 超时即失败。

### 1.3.6 串口桥的降级定位
`firecracker-serial-bridge.ts` 保留文件不动，但从驱动的执行路径上摘除。仅保留 boot 日志用途：jailer 模式下 serial 不接管 stdin/stdout（jailer 用 `--daemonize` 或丢弃 stdio），boot 日志可选接到文件 `<runtimeRoot>/<id>/boot.log`（`--boot-tty-log-file`，若 jailer 版本支持；不支持则放弃，不阻塞）。

---

## 1.4 Provider 与配置接线清单

`microvm-sandbox-provider.ts` 修改（Phase 0 版本基础上）：
1. `create()` 里工作区盘逻辑改为：`VmRunDirectoryManager` 分配目录后，磁盘路径用 `dir.workspaceDiskPath()`，复制动作移交给驱动（§1.2 第 3 步统一在 chroot 里完成）——**provider 不再自己 copyFileSync**；`workspaceDisks` Map 删除，清理统一走 `manager.dispose`。
2. `runtimeEvidence.verificationReason` 文案改为：`"jailer 隔离的 Firecracker VM；kernel/rootfs 就绪、工作区盘已挂载、vsock agent 握手成功"`。
3. `enforcement.cpuLimitEnforced/memoryLimitEnforced`：jailer cgroup 已落实，保持 true 但注释指向 jailer cgroup；`networkPolicyEnforced` 逻辑不变（入口拒绝 allowNetwork）。
4. `execute()` 透传 env（§1.3.5 末段）。

`create-harness-application.ts`：`FirecrackerSandboxDriver` 构造参数扩展 `{ binaryPath, jailerPath, kernelPath, rootfsPath, vmRuntimeRoot, vsockPort }`，从 config 读取。

`harness-config.ts` 新增字段（含解析与校验）：

| 环境变量 | 字段 | 默认 | 校验 |
|---|---|---|---|
| `HARNESS_VM_RUNTIME_ROOT` | `vmRuntimeRoot` | `/var/lib/harness/vm` | 无 |
| `FIRECRACKER_JAILER_PATH` | `firecrackerJailerPath` | `jailer` | strict 时必须在 PATH 或可执行 |
| `HARNESS_VSOCK_PORT` | `vsockPort` | `5000` | 1024–65535 |

---

## 1.5 单元测试清单（逐条实现）

新文件 `tests/sandbox/vm-run-directory.test.ts`：
- 创建目录权限为 0700（stat mode & 0o777 === 0o700）；
- 非法 sandboxId（含 `..`、`/`、超长）抛错；
- dispose 幂等、listOrphans 返回实际目录。

`tests/sandbox/firecracker-vsock-bridge.test.ts`：
- 行缓冲：半帧到达不解析、两帧粘连正确拆出两条；
- 未知 id 帧被丢弃；
- 伪造 `exec_result`（id 正确但先于真实结果到达）——协议允许先到者生效，但必须在测试里固定"宿主只接受第一个匹配 id 的 result"语义并验证（此为已知限制，记入边界文档附录）；
- maxOutputBytes 截断标志；
- 超时帧语义（用假 agent 模拟）。

`tests/sandbox/vm-allocators.test.ts`：UID/CID 分配唯一性、释放后可复用、耗尽抛错。

`tests/sandbox/microvm-sandbox-provider.test.ts` 更新：
- 现有用例全部保持通过（mock 驱动路径）；
- 新增：provider.execute 将 secret 值经 env 传给驱动（用 MockMicrovmDriver 捕获断言，值不在 argv 里）。

【硬约束】全部测试不得依赖真实 KVM/jailer；真机验证走 §1.6 的 smoke。

## 1.6 Phase 1 验收（真机 smoke）

更新 `scripts/server-microvm-smoke.ts`：
1. 新增 `scripts/microvm/preflight-microvm.sh`：检查 KVM、jailer、firecracker、vhost_vsock 模块、镜像文件存在性；全过才允许跑 smoke；
2. smoke 全流程：构建 guest 镜像（或检测已存在）→ provider.create → `execute(["uname","-r"])` 断言输出含 "Linux" 且 **不等于宿主 `uname -r`**（证明独立内核）→ `execute(["bash","-lc","echo $TEST_SECRET"])`（经 env 注入）→ `execute(["bash","-lc","touch /workspace/probe.txt"])` → terminate → 断言 `<runtimeRoot>/<id>` 目录已不存在；
3. 攻击断言：`execute(["bash","-lc","ls / 2>/dev/null; cat /proc/1/cmdline"])` 输出与宿主无关；尝试 `curl http://169.254.169.254/` 必须失败（无网络）；
4. 通过标准：上述全部断言绿 + 无 `/tmp/fc-*` 残留。

---

# Phase 2：工作区导出 + 磁盘限额 + 租户准入

## 2.1 工作区导出（终止时回写）

新建 `src/sandbox/microvm/workspace-disk-exporter.ts`：

```ts
export interface ExportResult {
    readonly filesWritten: number;
    readonly bytesWritten: number;
    readonly skipped: readonly { path: string; reason: string }[];
}
export class WorkspaceDiskExporter {
    /**
     * 从 per-run workspace.ext4 抽取全部文件写入宿主 workspacePath。
     * 实现：优先 debugfs（无需 root）：
     *   debugfs -R "ls -l -r /" <disk> 列出清单；
     *   debugfs -R "dump <remote> <local>" 逐个抽取。
     * 备选（有 root/CAP_SYS_ADMIN）：loop mount 到 <runtimeRoot>/<id>/mnt（0700）后 cp -a。
     * 【硬约束】目标路径必须经 isWithin 校验落在 workspacePath 内（防镜像内
     * 恶意路径如 ../../etc 逃逸写入）；符号链接一律跳过并记入 skipped。
     */
    exportToHost(diskPath: string, workspacePath: string): Promise<ExportResult>;
}
```

接线：`MicrovmSandboxProvider.terminate()` → 先 `driver.flushFilesystem(sandboxId)`（驱动经 vsock 发 `sync` 命令并等结果）→ 导出 → 再销毁 VM 与目录。导出失败：Run 标记 FAILED（原因写清），磁盘副本**保留**在私有目录供人工排查，协调器按孤儿目录策略保留 24h（加时间戳目录名）。

## 2.2 磁盘限额与默认限额

- workspace 模板扩容到可配置大小：`HARNESS_VM_WORKSPACE_DISK_MIB`（默认 512）；构建脚本参数化；
- jailer cgroup 在策略无显式限额时也必须下发默认值（cpu 2 核、内存 512MB），防止无限制 VM；
- 磁盘用量观测：导出时统计，超配额（`HARNESS_TENANT_STORAGE_QUOTA_MIB`，Phase 2 可只做观测+审计，不强制）记 `policy_decisions` 或审计事件。

## 2.3 租户准入接入

`run-scheduler.ts` 与 `tenant-run-scheduler.ts` 已按 run 数准入；Phase 2 只需把 microVM 的**内存占用预估**纳入：`resource-admission-service.ts` 增加 `estimateSandboxMemoryMiB(profile)`——strict profile 返回 `memoryMb + 64`（VMM 开销），容器返回现状值。准入判定照常。【不要动】调度器其余逻辑。

## 2.4 Phase 2 验收

- smoke 扩展：VM 内写 3 个文件（含嵌套目录）→ terminate → 宿主 workspacePath 下原样出现；镜像内预置 `evil -> /etc/passwd` 符号链接的文件被跳过且记入 skipped；
- 磁盘超限：VM 内 `dd` 写满 → 写入失败、agent 正常返回非零码、Run 收敛为 FAILED 而非悬挂；
- 真机连续 20 个 Run：私有目录零残留、cgroup 无泄漏（`systemd-cgls` 或 /sys/fs/cgroup 比对）。

---

# Phase 3：snapshot/restore + CoW + 预热池

## 3.1 快照基线

新建 `src/sandbox/microvm/vm-snapshot-manager.ts`：
- 首次 create 完整开机 → agent 握手成功 → Firecracker `PATCH /vm {"state":"Paused"}` → `PUT /snapshot/create { snapshot_type: "Full", snapshot_path, mem_file_path }`（文件放 `<snapshotPoolDir>/<templateHash>/`，`sha256(kernel+rootfs+agent 版本)` 作 key）→ `PATCH /vm {"state":"Resumed"}`（失败路径也必须 resume，避免 VM 卡在 Paused）。注意：官方 Firecracker 从未提供 `InstancePause` 动作，pause/resume 的唯一官方途径是 `PATCH /vm`；
- 后续 create：`PUT /snapshot/load { snapshot_path, mem_file_path, enable_diff_snapshots: false, resume_vm: true }` → vsock **重连握手**（§1.3.5 的 connect 必须支持 reconnect）。
- 【硬约束】快照池目录 0700；同一 key 的快照在 agent/镜像版本变化后必须失效（key 里带版本哈希）。
- 预热池：参照 `src/sandbox/container-warm-pool.ts` 的语义（惰性 warm + 命中即补货 + TTL 5min + 启动清场），新建 `src/sandbox/microvm/microvm-warm-pool.ts`，池对象是"已 restore 且 vsock 就绪的 VM"。池化键 = 模板哈希 + 资源档位（与容器链路"剥离限额、租用时 update"不同，VM 限额由 jailer 启动参数决定——**因此池化 VM 必须按资源档位分桶**，档位集合固定为 S(1c/256M)、M(2c/512M)、L(4c/2048M)，策略限额映射到 ≥ 需求的最小档位）。
- rootfs 全量复制改 CoW：`cp --reflink=always` 失败时退化普通复制并记审计（不阻塞）；快照场景 rootfs 直接用 `enable_diff_snapshots` 的 base + diff 形态（以官方能力为准，实现时先做单模板 diff）。

## 3.2 异步化审计
全局 grep `copyFileSync|readFileSync|execSync` 在 `src/sandbox/microvm/**` 下清零（启动期一次性小文件除外，需注释说明）。

## 3.3 性能门禁
smoke 新增计时输出：冷启动（无快照）与 restore 启动分别打印 durationMs；验收阈值：restore P95 < 500ms（10 次采样）。

## 3.4 Phase 3 验收
- 10 并发 Run：事件循环阻塞 < 50ms（smoke 内用 setInterval 抖动测量）；
- 快照 key 在 agent 重编译后自动失效重建；
- 池 TTL 到期 VM 被完整回收（进程、目录、cgroup）。

---

# Phase 4：出口网关 + controlled-egress + GPU ACL

## 4.1 网络拓扑
- 每 VM：jailer netns 内创建 tap 设备 + 固定私网段 `10.200.<cid低8位>.0/30`，VM 侧 .2，netns 侧 .1；
- netns 默认路由 → 宿主出口网关进程（`src/egress/egress-gateway.ts`，独立进程，Bun 实现 HTTP CONNECT + SOCKS5 双协议，监听每 netns 的 Unix socket 或固定端口段）；
- nftables 规则（脚本 `scripts/microvm/setup-egress-netns.sh`）：netns 内 OUTPUT 仅允许目的为网关，其余 REJECT——**规则先于 VM 启动下发**。

## 4.2 白名单策略
- 策略模型扩展：`effective-policy.ts` 的 allowNetwork 细化暂不做；Phase 4 用部署级白名单文件 `config/egress-allowlist.json`：`{"allowed": [{"host": "127.0.0.1", "port": 3000, "purpose": "llm-gateway"}, ...]}`；
- 网关对每个连接记录审计事件（tenantId 经 netns ↔ VM ↔ sandboxId 反查）；
- 禁止名单（永远拒绝，代码常量）：`169.254.169.254`、`169.254.0.0/16`、宿主内网段（可配 `HARNESS_EGRESS_DENY_CIDRS`，默认 RFC1918 全段）。

## 4.3 GPU 服务 ACL（此节允许动 `src/llm-gateway` 之外的部署文件）
- 部署脚本 `deploy/` 新增 nftables/防火墙规则：vLLM 端口仅接受来自 LLM 网关进程的连接（按 UID 或源地址匹配）；
- 网关监听地址改为 `0.0.0.0` 仅在出口网关放行它时，否则保持 127.0.0.1；VM 经网关入口访问时用 netns 网关地址。
- provider 的 allowNetwork 拒绝逻辑改为：存在 egress 网关配置时放行（并在 evidence 写明 egress profile），否则保持拒绝。

## 4.4 Phase 4 验收
- allowNetwork=true 的 Run：VM 内 `curl https://白名单域名` 通、`curl https://其他域名` 被拒且有审计记录、`curl http://169.254.169.254` 被拒；
- vLLM 端口从 VM 直连（绕过网关）被拒；
- 断网关进程：VM 全部外联失败但 Run 不崩，错误可观测。

---

# 附录

## 附录 A：真机环境准备（一次性）

```bash
# 1. 依赖
sudo apt-get install -y e2fsprogs debugfs-tools socat nftables
sudo modprobe vhost_vsock && echo vhost_vsock | sudo tee -a /etc/modules
# 2. Firecracker + jailer（固定版本，校验 sha256；版本号写入 deploy/firecracker.version）
# 3. 运行用户
sudo usermod -aG kvm <harness-user>
sudo mkdir -p /var/lib/harness/vm && sudo chown <harness-user> /var/lib/harness/vm && chmod 700 /var/lib/harness/vm
# 4. jailer 权限：Harness 以 root 运行，或对 jailer 二进制 setuid（生产推荐前者 + 专用 systemd unit，见 deploy/harness.service.example）
# 5. 镜像
bun build guest/agent/main.ts --compile --outfile build/guest-agent
bash scripts/microvm/build-guest-rootfs.sh build/guest-agent build/rootfs.ext4 build/workspace-template.ext4
```

## 附录 B：实现顺序 checklist（严格按序，逐项打勾后才继续）

1. §1.1 vm-run-directory + 测试
2. §1.2.1 jailer-prereq-check + §1.2.3 uid allocator + 测试
3. §1.3.4 guest agent + build 脚本（先在本机用 socat TCP 模拟跑通协议单测）
4. §1.3.5 vsock bridge + 行缓冲测试
5. §1.2.4 驱动重写（最后一步接入 jailer，先不用 jailer 跑通 vsock 全链路，再切 jailer——分两次提交）
6. §1.4 provider/配置接线
7. §1.6 smoke 全绿
8. Phase 2 → 3 → 4（每阶段独立提交、独立验收）

## 附录 C：常见错误排查表

| 症状 | 根因 | 处置 |
|---|---|---|
| `PUT /vsock` 报 Invalid input | guest_cid < 3 或 UDS 路径在 chroot 外 | CID 分配器 bug；UDS 用 chroot 内路径 |
| CONNECT 无 OK 响应 | guest 未加载 virtio_vsock / agent 未启动 | 看 boot.log；确认内核 CONFIG 与 inittab |
| jailer 报 cgroup 错 | 内核未挂 cgroup v2 或权限不足 | `mount -t cgroup2`；euid 检查 |
| restore 后 agent 无响应 | vsock UDS 是旧连接的句柄 | load 后必须重新 CONNECT（§3.1） |
| 事件循环周期性卡顿 | 残留 copyFileSync | 附录 §3.2 审计 |
| debugfs dump 中文路径乱码 | debugfs 非 UTF-8 输出 | 导出清单按 inode 处理，不解析文件名编码 |

## 附录 D：tsc 基线（不得新增）

修改前 `npx tsc --noEmit` 已存在以下错误（与本次无关，禁止"顺手修"引入新风险，也禁止新增错误）：
- `scripts/benchmark-docker-vs-microvm.ts`：TS6133 ×2
- `scripts/test-multi-tenant-agent.ts`：TS18048 ×5
- `src/sandbox/microvm/firecracker-serial-bridge.ts`：TS2345/TS2532 ×2

## 附录 E：已知限制（写进 docs/platform-boundary.md 附录，不视为缺陷）

1. vsock 协议 v1 对伪造 exec_result 的防护是"先到者生效"（guest 是信任域内，防护目标是宿主编排正确性，不是 guest 内攻击者）；guest 内威胁由 KVM 边界兜底。
2. 加密工作区盘（B6 目标态）因 dm-crypt 需要特权，v1 以 0700 私有目录 + 终止销毁替代，加密盘列为 v2 候选。
