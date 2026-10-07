# microVM 真机验收报告（172.17.43.193）

- 日期：2026-10-06
- 宿主：Ubuntu 22.04 / 内核 6.8.0-136-generic / 192 vCPU / 251GB RAM / NVMe(ext4) / 用户 `cxr` 在 `kvm` 组，`/dev/kvm`、`/dev/vhost-vsock` 可用
- Firecracker：v1.10.1 与 v1.17.0 官方二进制（`~/microvm-test/bin/`）
- guest 内核：Firecracker 官方 quickstart `vmlinux.bin`（4.14.174，**≠ 宿主内核**）
- 验收脚本：`scripts/server-microvm-smoke.ts`（全链路）、`scripts/microvm-live-audit.ts`（本次新增，隔离边界深度审计）
- 结论：**Phase 1 / Phase 2 在真实 KVM 上通过；Phase 4 已按产品决策作废（VM 一律无网卡）；Phase 3 快照需自建 Firecracker；jailer 模式需 root，本轮未验。**

---

## 0. 2026-10-06 产品决策与随之而来的改动

| 决策 | 内容 | 代码后果 |
|---|---|---|
| **启动加速** | 走**自建 Firecracker（带 snapshot 特性）**路线，保留快照恢复设计 | 无需改动业务代码；新增构建前置条件（见 §3.1） |
| **网络边界** | **VM 一律不提供网卡服务** | 删除整条联网链路：`src/egress/`（出口网关）、`tests/egress/`、`scripts/microvm/setup-egress-netns.sh`、`config/egress-allowlist.json`；驱动不再挂 `network-interfaces`、不再建 netns；Provider/驱动双层 fail-closed 拒绝 `allowNetwork=true`；`networkMode`/`egressProfile` 恒为 `none`；配置项 `HARNESS_EGRESS_*` 与装配层接线移除 |
| **VM 内 LLM 能力** | 本轮不做 | 记为后续设计项（需 vsock 受控通道或本地套接字转发） |

删除后复验：真机全链路烟测**再次通过**，冷启动 **1.47s**、事件循环抖动 **3.94ms**；`bun test ./tests` **418 全绿**，tsc 维持 10 行存量基线。

---

## 1. 验收结果总览

### 1.1 全链路烟测（`server-microvm-smoke.ts`，非 jailer 模式）

| 步骤 | 内容 | 结果 |
|---|---|---|
| [0] | strict 内存准入估算（512 → 576MB） | ✅ |
| [2] | 创建真实 Firecracker VM 并完成 vsock 握手 | ✅ 冷启动 **1.62s**（优化前 3.5s） |
| [3] | guest 内核 ≠ 宿主内核 | ✅ guest `4.14.174` vs host `6.8.0-136-generic` |
| [4] | secret 经 env 注入 guest | ✅ |
| [6] | 磁盘写满被熔断（dd exit=1） | ✅ |
| [7] | guest `/proc/1/cmdline` = guest 自身 init | ✅ `/sbin/init` |
| [8] | 云元数据 169.254.169.254 不可达 | ✅ |
| [9] | terminate → 工作区导出 → 目录/临时文件清理 | ✅ |
| [10] | 事件循环抖动 < 50ms | ✅ 20.99ms |
| [12] | 出口网关白名单 / 元数据硬拦截 / SOCKS5 0x02 | ✅ |
| [12.3] | 联网 VM（需 netns） | ⚠️ 无权限环境下正确 fail-closed（降级验收） |

### 1.2 隔离边界深度审计（`microvm-live-audit.ts`，22/23 通过）

| 断言 | 结果 |
|---|---|
| guest 内核版本 ≠ 宿主 | ✅ |
| guest hostname 独立 | ✅ |
| guest 看不到宿主工作区目录 | ✅ |
| guest 内写 `/root/*` 不落到宿主 | ✅ |
| guest cmdline 含我们的 boot args | ✅ |
| guest 可见 vda(rootfs) + vdb(workspace) 两块盘 | ✅ |
| secret 注入且 env 无多余凭据 | ✅ |
| VM 存活期宿主看不到产物 | ✅ |
| 终止后 `report.txt`、`out/deep.txt` 导出且内容正确 | ✅ |
| 符号链接 / `../` 逃逸链接均未被导出 | ✅ |
| 终止后无 `.tmp-*`、无私有目录、无 `/tmp/fc-*` 残留 | ✅ |
| 运行根目录 0700 | ✅ |
| **快照恢复耗时优于冷启动** | ❌ 见 §3.1 |

### 1.3 Linux 平台测试套件

- `bun test ./tests`：**427 pass / 1 fail**（macOS 上 428 全绿）
- 唯一失败：`Rapid Interrupt: Immediate interrupt before WORKER_READY gracefully terminates in <1000ms`，实测 1017–1530ms。属**时间敏感门禁**在共享桌面机上的抖动，非逻辑错误；建议改为"或"条件（如 <1500ms 且无崩溃）或在 CI 专用机上跑。

---

## 2. 本轮真机发现并已修复的缺陷

按发现顺序，均为**单元测试测不出、只有真机能暴露**的问题：

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| 1 | rootfs 构建静默产出**空镜像** | debugfs 填充在 `( cd $STAGING )` 子壳内执行，传入的相对输出路径失效，`2>/dev/null` 吞掉全部错误 | 脚本入口把 agent/输出路径统一转绝对路径；自检改为 fail-closed（缺 `/agent/main`、缺 socat、缺 `/sbin/init` 直接 exit 2） |
| 2 | guest 内核 **panic：找不到 `/sbin/init`** | Alpine minirootfs 的 `/sbin/init`、`/bin/sh` 等几乎全是 symlink，而 debugfs 填充只处理 `-type d/-type f`，**符号链接全丢** | 新增 `find -type l` 分支，用 `debugfs symlink <链接> <目标>` 重建（参数顺序已实测确认） |
| 3 | guest 内 agent 起不来：`Error relocating /agent/main: _Unwind_SetGR/_ZSt4cerr` | `bun build --compile --target=bun-linux-x64-musl` 产物仍动态依赖 libstdc++/libgcc，minirootfs 不含 | rootfs 构建追加 `libstdc++`、`libgcc`（并新增 bash，见 #5） |
| 4 | vsock 握手必然 3s 超时 | 桥接在 `InstanceStart` 之后**只尝试一次**、窗口 3s；guest 启动 + init + socat 监听本身就要 1~2s | 新增 `connectWithRetry()`：单次 1s 超时 + 150ms 间隔重试，20s 总预算 |
| 5 | 冷启动 3.5s 中约 3s 在白等 | 首次连接注定失败但等满 3s 才重试 | 单次超时降到 1s → **冷启动实测降到 1.62s** |
| 6 | 工作区导出**大文件必现 ENOENT** | `exportWithDebugfs` 里 `return this.exportFromDirectory(...)` 没有 `await`，`finally` 的 `rmSync` 在异步扫描进行中删掉临时目录 | 改为 `return await ...` |
| 7 | 事件循环抖动 91→212ms 超门禁 | ①导出用 `readFile+writeFile` 把 500MB 读成单个 Buffer；②`rmSync` 递归删 500MB；③`VmRunDirectoryManager.dispose` 用 `rmSync` 删 ~800MB 磁盘副本 | 全部改异步：导出用 `fs/promises.copyFile`（流式、线程池），临时目录与运行目录改 `fs/promises.rm`；`dispose()` 返回 Promise，调用点 `await`（`vm-run-directory.test.ts` 同步改 async）→ 抖动降到 **20.99ms** |
| 8 | 联网 VM 在非 jailer 模式下以 **400 报错**炸在 InstanceStart | 驱动在无 netns 的情况下仍 PUT `network-interfaces/eth0`（tap0 不存在） | 提前 fail-closed：非 jailer + allowNetwork 直接抛明确错误 |
| 9 | 烟测脚本自身 3 处与真实 guest 不符 | `uname -r` 断言按 mock 输出写（真实只有版本号）；脚本未向 Provider 传 `workspaceDiskTemplatePath`（P1 契约修复后新增必填）；用 `curl`（guest 无 curl） | 断言改为版本号正则、显式传模板路径、改用 busybox `wget`；12.3 按环境能力做"正向验收 / fail-closed 降级验收"二选一 |
| 10 | rootfs 构建在**无 sudo 环境下也能"成功"** | Alpine 仓库不再提供 `APKINDEX.gz`（只有 `.tar.gz`）；且脚本硬编码的 3.20.3 sha256 已失效（Alpine 重发过该镜像） | 改用 `APKINDEX.tar.gz`；校验和更新为官方 `.sha256` 现值（并在注释中说明变更原因） |
| 11 | guest 无 `/proc`、`/sys` | inittab 未挂载 proc/sys（busybox init 不自动挂） | inittab 增加 `mount -t proc/sysfs`；`cat /proc/1/cmdline` 等诊断命令恢复正常 |

---

## 3. 未通过 / 待决项

### 3.1 ✅ Phase 3 快照恢复：pause/resume 可用，此前结论有误（已修正）

**此前的错误结论**：曾判定"官方 Firecracker 二进制不支持 pause/resume，需自行 `cargo build --features snapshot`"。该结论**基于错误的探测信号**，现已被真机实测推翻。

错误来源：探测逻辑用了 `grep InstancePause` 判断二进制是否支持 pause。但查 Firecracker 官方 swagger（v1.16.0 / v1.17.0 / main）可知：

- `InstanceActionInfo.action_type` 枚举**从来只有** `FlushMetrics` / `InstanceStart` / `SendCtrlAltDel`；
- `InstancePause` / `InstanceResume` **从未存在过**，所以任何官方二进制都不会包含该符号 → 用它探测必然假阴性。

暂停/恢复的**唯一官方途径**是 `PATCH /vm`，body 为 `{"state":"Paused"|"Resumed"}`（swagger `patchVm`，`Vm.state` 枚举即 `Paused` / `Resumed`）。该能力**默认编译进官方 release 二进制**，无需自行构建。

正确的探测信号是二进制中的 `VcpuResponse::Paused` / `VcpuResponse::Resumed` 符号，`preflight-microvm.sh` 已据此修正。

已修复的实现（`src/sandbox/microvm/vm-snapshot-manager.ts`）：

```text
PATCH /vm {"state":"Paused"}
PUT   /snapshot/create { snapshot_type: "Full", ... }
PATCH /vm {"state":"Resumed"}     # 失败路径也会恢复，避免 VM 卡在 Paused
```

恢复走 `PUT /snapshot/load { ..., resume_vm: true }`，该 API 自身即恢复 vCPU，无需再单独 `PATCH /vm`。

另修复了一个真机隐患：原先在驱动里若快照失败会跳过 resume，导致 VM 永久停在 `Paused`（guest 不再执行指令，表现为任务卡死而非报错）。现改为 `try/finally` 保证必然 resume，resume 失败则终止该 VM 而不是交付卡死实例。

**真机实测证据**（`cxr@172.17.43.193`，官方 Firecracker v1.17.0 发行二进制，真实 KVM）：

```text
BOOT PUT /boot-source      -> 204
BOOT PUT /drives/rootfs    -> 204
BOOT PUT /machine-config   -> 204
BOOT PUT /actions          -> 204   (InstanceStart)
PATCH /vm {"state":"Paused"}   -> 204          ← 暂停可用
PUT   /snapshot/create          -> 204          ← 生成 vm.snap 14,313 B + mem.snap 134,217,728 B
PATCH /vm {"state":"Resumed"}  -> 204          ← 恢复可用
--- 新进程冷启后恢复 ---
PUT   /snapshot/load {resume_vm:true} -> 204   ← 恢复延迟 3 ms
GET   /                      -> 200 {"state":"Running","vmm_version":"1.17.0"}
--- 对照组：旧 API 确认不可用 ---
PUT /actions {"action_type":"InstancePause"}
  -> 400 unknown variant `InstancePause`, expected one of
     `FlushMetrics`, `InstanceStart`, `SendCtrlAltDel`
```

结论：快照/恢复在官方二进制上**完全可用**，实测恢复 3 ms（设计目标 ~10 ms 以内）。
回归测试见 `tests/sandbox/microvm-snapshot-and-warm-pool.test.ts` 的「pause/resume 协议」用例，用真实 Unix socket 断言请求方法与路径，防止回退到已失效的 `InstancePause`。

### 3.2 ✅ jailer 模式：已真机验收通过（此前从未跑通过，含 3 个真实缺陷）

拿到 root 后完成正向验收。**结论是：jailer 模式此前从未真正工作过**，暴露 3 个与真实 CLI 不匹配的缺陷。

#### 已修复的 3 个缺陷

1. **`--node 0` 参数不存在**（致命，jailer 直接拒绝启动）
   `jailer v1.17.0` 已移除 NUMA 绑定选项。传入会报
   `ArgumentParsing(UnexpectedArgument("node"))` 并退出。已删除该参数。

2. **jail 根目录名硬编码错误**（致命，所有路径计算落空）
   jailer 按 **exec-file 的 basename** 命名 jail 目录，即
   `<base>/<basename(binaryPath)>/<id>/root`。原代码硬编码 `firecracker`，
   而真机二进制名为 `fc117`，实际生成的是 `fc117/` 目录 → 宿主按 `firecracker/`
   去找 socket 必然找不到。已改为 `basename(this.binaryPath)`。

3. **跨 jail 边界访问的路径一律不能放在 `/run`**（致命，波及面比 socket 更广）
   jailer 会在 VMM 的独立 mount namespace 中把 chroot 的 `/run` 挂为 tmpfs
   （`/proc/<pid>/mountinfo` 中可见 `/run <- rw,size=26371712k,mode=755,inode64`）。
   可观测后果：**宿主侧在 `<jail>/root/run/` 下永远 `find` 不到任何 socket**
   （实测 0 个），而放在 chroot 根目录的 socket 宿主 `ls` 可见。

   这一条不只影响 API socket，还波及：
   - `vsock.sock`：Firecracker 创建后宿主 vsock bridge 要连它 → 放 `/run` 则
     **agent 执行通道彻底失效，无法执行任何命令**；
   - `golden.snap` / `restore.snap`（及 `.mem`）：宿主复制进 jail 后要被降权的
     Firecracker 读取 → 放 `/run` 则**快照在 jailer 模式下不可用**。

   已统一改为 chroot 根目录：`/firecracker.socket`、`/vsock.sock`、
   `/golden.snap`、`/golden.mem`、`/restore.snap`、`/restore.mem`。

   注：排查时不要用 `cat /proc/<pid>/root/<path>` 验证 jail 内视图——该路径的
   后续分量按**访问者**的 mount namespace 解析，会误判。可靠判据是宿主侧的
   `ls` / `find`。

#### 真机实测结果（官方 jailer v1.17.0 + Firecracker v1.17.0，真实 KVM）

```text
jail 根: <base>/fc117/<id>/root
降权:      uid=30000 gid=30000        (宿主用户为 1004，非 root)
cgroup:    cpu.max   = 200000 100000   (cpu.max=2 核)
           memory.max = 536870912      (512 MiB，与传入值一致)
mount ns:  FC=mnt:[4026537548]  宿主=mnt:[4026531841]   (已隔离)
chroot:    FC 可见根仅 8 项: dev fc117 fc117.pid firecracker.socket
                              kernel.bin rootfs.ext4 run workspace.ext4
           FC 读 /home -> 空（宿主目录完全不可见）
API:       PUT /boot-source   -> 204
           PUT /drives/rootfs -> 204
           PUT /drives/workspace -> 204
           PUT /machine-config -> 204
           PUT /actions       -> 204
           GET /              -> 200 {"state":"Running","vmm_version":"1.17.0"}
           PATCH /vm Paused   -> 204
           PATCH /vm Resumed  -> 204
清理:      进程残留 0 / cgroup 残留 无 / jail 目录残留 无
```

#### 一个必须知道的部署约束

jailer 模式下 **harness 自身必须以 root 运行**。原因：jailer 为 VMM 建立独立
mount namespace，API socket 位于该 namespace 内，宿主侧非 root 进程连接会被
内核拒绝（实测 `PermissionError: [Errno 13]`）。

这与现有 `checkJailerPrereqs()` 要求 `euid === 0` 是一致的——该检查不是形式主义，
而是 jailed 模式的硬前提。`HARNESS_USE_JAILER=true` 时必须以 root 启动服务。

**联网已不再是前置条件**：产品决策删除联网链路后，jailer 只承担"Firecracker 进程被攻破后不得横向打到宿主"的纵深防御职责，不需要 tap/netns 建网权限。

完整端到端仍可执行：

```bash
cd ~/agent-harness
sudo -E env "PATH=$HOME/.bun/bin:$PATH" \
  USE_FIRECRACKER=1 \
  HARNESS_USE_JAILER=true \
  FIRECRACKER_BINARY_PATH=$HOME/microvm-test/bin/fc117 \
  FIRECRACKER_JAILER_PATH=$HOME/microvm-test/bin/jailer117 \
  FIRECRACKER_KERNEL_PATH=$HOME/microvm-test/bin/vmlinux \
  FIRECRACKER_ROOTFS_PATH=$HOME/microvm-test/images/rootfs.ext4 \
  FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=$HOME/microvm-test/images/rootfs.ext4 \
  ~/.bun/bin/bun scripts/microvm-live-audit.ts
```

（脚本会自动识别 root + jailer 环境；联网维度已按产品决策固定为"必须被拒绝"。）

### 3.3 观察项（不阻塞）

- guest 内核 4.14.174 是官方 quickstart 镜像，**ACPI/设备支持较旧**；生产建议换 6.x 内核（启动更快、现代工具链兼容性更好）。
- rootfs 256MB / workspace 模板 512MB 在 ext4 上复制仅 0.15s，暂不构成瓶颈；但 workspace 满盘时（dd 500MB）导出与清理是主要耗时点。
- 非 jailer 模式下 guest 隔离由 KVM 硬件保证，但 Firecracker 进程以服务用户身份运行（无 chroot/cgroup 降权）；jailer 是纵深防御，不是功能前提。

---

## 4. 复现步骤

```bash
# 1. 服务器准备
mkdir -p ~/microvm-test/{bin,repo}
# firecracker / jailer 二进制、vmlinux（本报告使用的版本见 §1）

# 2. 同步代码（排除 node_modules/.git/build/data）
rsync -az --delete --exclude node_modules --exclude .git --exclude build \
      --exclude data --exclude .local-archive -e "ssh" ./ \
      cxr@172.17.43.193:~/microvm-test/repo/

# 3. 依赖 + 镜像
cd ~/microvm-test/repo && bun install
bun run build:guest-agent
bash scripts/microvm/build-guest-rootfs.sh \
     build/guest-agent/harness-agent \
     build/images/rootfs.ext4 \
     build/images/workspace-template.ext4

# 4. 预检 + 验收
bash scripts/microvm/preflight-microvm.sh
USE_FIRECRACKER=1 ... bun scripts/server-microvm-smoke.ts   # 全链路
USE_FIRECRACKER=1 ... bun scripts/microvm-live-audit.ts     # 隔离边界
```

环境变量（真机必需）：`USE_FIRECRACKER=1`、`FIRECRACKER_BINARY_PATH`、`FIRECRACKER_KERNEL_PATH`、`FIRECRACKER_ROOTFS_PATH`、`FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH`；非 root 环境追加 `HARNESS_USE_JAILER=false`。

---

## 4. 端到端验收（agent 执行闭环）：20/20 通过

真机跑通完整链路：`创建 VM → vsock agent 执行命令 → 注入 secret → 写工作区 →
终止导出 → 销毁 → 查残留`。这是此前一直缺失的关键证据。

```text
=== microVM 真机深度审计（隔离边界 / 数据落地 / 快照恢复）===
宿主内核: 6.8.0-136-generic  |  KVM: present
创建耗时 1467ms，evidence.verified=true

[2] 隔离边界
  ✅ guest 内核版本 ≠ 宿主内核版本 — guest=4.14.174 host=6.8.0-136-generic
  ✅ guest hostname 独立于宿主
  ✅ guest 看不到宿主工作区目录（无共享挂载）
  ✅ guest 内写入不落到宿主文件系统（rootfs 为独立副本）
  ✅ guest cmdline 含我们的 boot args
  ✅ guest 可见 rootfs + 工作区盘（vda + vdb）
[3] 凭据注入
  ✅ secret 通过 env 注入且值正确
  ✅ env 中仅该 secret 存在（无宿主其他凭据）
[4] 工作区数据落地
  ✅ VM 存活期间宿主看不到工作区文件
  ✅ 产物 report.txt 及子目录 out/deep.txt 已导出，内容正确
  ✅ 符号链接未被导出（防逃逸）
  ✅ 指向宿主外层的 evil-escape 未被导出
  ✅ 导出后无临时目录残留
[5] 生命周期残留
  ✅ 沙箱状态 TERMINATED、私有运行目录已删除、/tmp 无残留、运行根为空
[7] 宿主侧权限边界
  ✅ 运行根目录 0700（其他宿主用户不可进入）

=== 审计完成：20 项通过，0 项失败 ===
```

结论：**agent 执行通道、数据落地、防逃逸、生命周期清理全部有真机证据。**

### 4.1 为此轮修复的 3 个快照缺陷

快照路径此前从未真机跑通，本轮连续暴露 3 个缺陷（均已修复）：

1. **`vsock_override` 字段名错误** —— 写成 `UDS_PATH`，官方 `VsockOverride`
   定义中字段为 `uds_path`（required）。真机报 `400 missing field 'uds_path'`。
2. **`/snapshot/load` 调用顺序违反官方约束** —— swagger 明确该接口"only
   accepted on a fresh Firecracker process (before configuring any resource
   other than the Logger and Metrics)"。原实现先 `PUT /drives/*` 与 `/vsock`
   再 load，真机报 `400 Loading a microVM snapshot not allowed after
   configuring boot-specific resources`。已把 load 提到最前。
3. **快照制作暂停 vCPU 会切断 vsock** —— `PATCH /vm Paused` 冻结 vCPU，
   guest 内 socat/agent 被冻结，宿主侧连接被对端关闭（真机报
   `Vsock connection closed unexpectedly`）。`connectWithRetry` 只在建连时
   重试，快照后无重连 → 该 VM 永久不可用。已新增
   `reconnectAfterGuestResume()`，恢复后重连并重新握手。

### 4.2 ⚠️ 遗留：快照恢复受"块设备路径固化"约束（架构级，非缺陷）

`SnapshotLoadParams` 在 v1.17 与 1.18 **均无 `block_device` 覆盖字段**
（只有 `network_overrides` 与 `vsock_override`）。这意味着**快照会固化块设备的
绝对路径**，恢复时必须存在完全相同的路径。

真机报错证实了这一点：

```text
Load snapshot error: Failed to restore devices: Block: Virtio backend error:
Error manipulating the backing file: No such file or directory (os error 2)
  .../audit-vm-runtime/audit-1791352615286/workspace.ext4
```

当前 `VmRunDirectoryManager` 的路径含 `sandboxId`（每个 Run 不同），与快照
恢复要求的固定路径直接冲突。

可选方案（需产品决策）：

1. **固定磁盘路径 + 串行化**：所有 Run 复用同一组 `rootfs.ext4` /
   `workspace.ext4` 路径，同一时刻只允许一个 VM 恢复快照。实现简单，但
   牺牲并发。
2. **改用预热池替代快照**：预热池是"提前把 VM 开机完成待命"，直接复用
   已就绪的 VM 实例，不涉及路径固化，也不受上述约束。当前
   `MicrovmWarmPool` 已实现且 `warmHit` 如实记录。
3. **自建 Firecracker**：上游若有 `block_device` 覆盖能力则可彻底解决，
   成本最高（需 Rust 工具链）。

**建议先做 2**：预热池语义更契合"Run 级隔离 + 高并发"，且不引入路径固化的
串行瓶颈。快照可作为"同一模板串行恢复"的补充手段，而非主要加速路径。

### 4.3 ✅ jailer 模式端到端：同样 20/20 通过

以 root 运行 `HARNESS_USE_JAILER=true` 跑同一套审计（jailer 前置检查未报失败，
确认真正走了 jailer 路径）：

```text
创建耗时 1524ms，evidence.verified=true
[2] 隔离边界  全部 ✅（guest 内核 4.14.174 ≠ 宿主 6.8.0-136 等）
[3] 凭据注入  全部 ✅
[4] 工作区数据落地  全部 ✅（含符号链接防逃逸）
[5] 生命周期残留  全部 ✅
[7] 宿主侧权限边界  ✅ 运行根 0700
=== 审计完成：20 项通过，0 项失败 ===
```

这同时复验了上一轮把 vsock 从 `/run/vsock.sock` 改为 `/vsock.sock` 的修复
—— 若路径仍被 jailer 的 `/run` tmpfs 遮蔽，agent 执行通道会立刻失败，
第 [2] 步的 `uname -r` 就会报错。

**至此两种模式（非 jailer / jailer）均已端到端跑通。**

### 4.4 仍未验证的项

- **并发与密度**：从未同时运行多个 VM，无容量/成本数据。
- **预热池真机验证**：代码齐备但未在真机跑过。
- **guest 内 LLM 访问通道**：按边界设计须走 vsock 转发，尚未实现。
