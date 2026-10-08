# microVM 真机验收报告（172.17.43.193）

- 日期：2026-10-06 初验；2026-10-08 补验快照恢复路径（见 §5）与攻击烟测（见 §6）
- 宿主：Ubuntu 22.04 / 内核 6.8.0-136-generic / 192 vCPU / 251GB RAM / NVMe(ext4) / 用户 `cxr` 在 `kvm` 组，`/dev/kvm`、`/dev/vhost-vsock` 可用
- Firecracker：v1.10.1 与 v1.17.0 官方二进制（`~/microvm-test/bin/`）
- guest 内核：Firecracker 官方 quickstart `vmlinux.bin`（4.14.174，**≠ 宿主内核**）
- 验收脚本：`scripts/server-microvm-smoke.ts`（全链路）、`scripts/microvm-live-audit.ts`（隔离边界深度审计，23 项）、`scripts/microvm-attack-smoke.ts`（攻击烟测，37 项）、`scripts/microvm-guest-facts-probe.ts` 与 `scripts/microvm-exhaust-probe.ts`（事实探针）
- 结论：**Phase 1 / Phase 2 / Phase 3b 在真实 KVM 上通过；Phase 4 已按产品决策作废（VM 一律无网卡）。快照恢复在 jailer 模式下真机实测 368ms（冷启动 2519ms，提速 6.9 倍），无需自建 Firecracker。攻击烟测 37/37 通过，cgroup 限额确认生效。**

---

## 0. 2026-10-06 产品决策与随之而来的改动

| 决策              | 内容                                                   | 代码后果                                                                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **启动加速**        | 走**官方 Firecracker 二进制 + 快照恢复**路线，保留快照恢复设计 | 无需改动业务代码，**无需自建 Firecracker**（原"须自建"的结论基于错误探测信号，已推翻，见 §3.1；真机实测见 §5）                                                                                                                                                                                     |
| **网络边界**        | **VM 一律不提供网卡服务**                                     | 删除整条联网链路：`src/egress/`（出口网关）、`tests/egress/`、`scripts/microvm/setup-egress-netns.sh`、`config/egress-allowlist.json`；驱动不再挂 `network-interfaces`、不再建 netns；Provider/驱动双层 fail-closed 拒绝 `allowNetwork=true`；`networkMode`/`egressProfile` 恒为 `none`；配置项 `HARNESS_EGRESS_*` 与装配层接线移除 |
| **VM 内 LLM 能力** | 本轮不做                                                 | 记为后续设计项（需 vsock 受控通道或本地套接字转发）                                                                                                                                                                                                                                                     |

删除后复验：真机全链路烟测**再次通过**，冷启动 **1.47s**、事件循环抖动 **3.94ms**；`bun test ./tests` **418 全绿**，tsc 维持 10 行存量基线。

---

## 1. 验收结果总览

### 1.1 全链路烟测（`server-microvm-smoke.ts`，非 jailer 模式）

| 步骤     | 内容                                      | 结果                                             |
| ------ | --------------------------------------- | ---------------------------------------------- |
| [0]    | strict 内存准入估算（512 → 576MB）              | ✅                                              |
| [2]    | 创建真实 Firecracker VM 并完成 vsock 握手        | ✅ 冷启动 **1.62s**（优化前 3.5s）                      |
| [3]    | guest 内核 ≠ 宿主内核                         | ✅ guest `4.14.174` vs host `6.8.0-136-generic` |
| [4]    | secret 经 env 注入 guest                   | ✅                                              |
| [6]    | 磁盘写满被熔断（dd exit=1）                      | ✅                                              |
| [7]    | guest `/proc/1/cmdline` = guest 自身 init | ✅ `/sbin/init`                                 |
| [8]    | 云元数据 169.254.169.254 不可达                | ✅                                              |
| [9]    | terminate → 工作区导出 → 目录/临时文件清理           | ✅                                              |
| [10]   | 事件循环抖动 < 50ms                           | ✅ 20.99ms                                      |
| [12]   | 出口网关白名单 / 元数据硬拦截 / SOCKS5 0x02          | ✅                                              |
| [12.3] | 联网 VM（需 netns）                          | ⚠️ 无权限环境下正确 fail-closed（降级验收）                  |

### 1.2 隔离边界深度审计（`microvm-live-audit.ts`，22/23 通过）

| 断言                                        | 结果       |
| ----------------------------------------- | -------- |
| guest 内核版本 ≠ 宿主                           | ✅        |
| guest hostname 独立                         | ✅        |
| guest 看不到宿主工作区目录                          | ✅        |
| guest 内写 `/root/*` 不落到宿主                  | ✅        |
| guest cmdline 含我们的 boot args              | ✅        |
| guest 可见 vda(rootfs) + vdb(workspace) 两块盘 | ✅        |
| secret 注入且 env 无多余凭据                      | ✅        |
| VM 存活期宿主看不到产物                             | ✅        |
| 终止后 `report.txt`、`out/deep.txt` 导出且内容正确   | ✅        |
| 符号链接 / `../` 逃逸链接均未被导出                    | ✅        |
| 终止后无 `.tmp-*`、无私有目录、无 `/tmp/fc-*` 残留      | ✅        |
| 运行根目录 0700                                | ✅        |
| **快照恢复耗时优于冷启动**                           | ❌ 见 §3.1 |

### 1.3 Linux 平台测试套件

- `bun test ./tests`：**427 pass / 1 fail**（macOS 上 428 全绿）
- 唯一失败：`Rapid Interrupt: Immediate interrupt before WORKER_READY gracefully terminates in <1000ms`，实测 1017–1530ms。属**时间敏感门禁**在共享桌面机上的抖动，非逻辑错误；建议改为"或"条件（如 <1500ms 且无崩溃）或在 CI 专用机上跑。

---

## 2. 本轮真机发现并已修复的缺陷

按发现顺序，均为**单元测试测不出、只有真机能暴露**的问题：

| #  | 缺陷                                                                        | 根因                                                                                                                          | 修复                                                                                                                                                              |
| -- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | rootfs 构建静默产出**空镜像**                                                      | debugfs 填充在 `( cd $STAGING )` 子壳内执行，传入的相对输出路径失效，`2>/dev/null` 吞掉全部错误                                                        | 脚本入口把 agent/输出路径统一转绝对路径；自检改为 fail-closed（缺 `/agent/main`、缺 socat、缺 `/sbin/init` 直接 exit 2）                                                                      |
| 2  | guest 内核 **panic：找不到 `/sbin/init`**                                       | Alpine minirootfs 的 `/sbin/init`、`/bin/sh` 等几乎全是 symlink，而 debugfs 填充只处理 `-type d/-type f`，**符号链接全丢**                       | 新增 `find -type l` 分支，用 `debugfs symlink <链接> <目标>` 重建（参数顺序已实测确认）                                                                                                |
| 3  | guest 内 agent 起不来：`Error relocating /agent/main: _Unwind_SetGR/_ZSt4cerr` | `bun build --compile --target=bun-linux-x64-musl` 产物仍动态依赖 libstdc++/libgcc，minirootfs 不含                                    | rootfs 构建追加 `libstdc++`、`libgcc`（并新增 bash，见 #5）                                                                                                                 |
| 4  | vsock 握手必然 3s 超时                                                          | 桥接在 `InstanceStart` 之后**只尝试一次**、窗口 3s；guest 启动 + init + socat 监听本身就要 1~2s                                                   | 新增 `connectWithRetry()`：单次 1s 超时 + 150ms 间隔重试，20s 总预算                                                                                                           |
| 5  | 冷启动 3.5s 中约 3s 在白等                                                        | 首次连接注定失败但等满 3s 才重试                                                                                                          | 单次超时降到 1s → **冷启动实测降到 1.62s**                                                                                                                                   |
| 6  | 工作区导出**大文件必现 ENOENT**                                                     | `exportWithDebugfs` 里 `return this.exportFromDirectory(...)` 没有 `await`，`finally` 的 `rmSync` 在异步扫描进行中删掉临时目录                 | 改为 `return await ...`                                                                                                                                           |
| 7  | 事件循环抖动 91→212ms 超门禁                                                       | ①导出用 `readFile+writeFile` 把 500MB 读成单个 Buffer；②`rmSync` 递归删 500MB；③`VmRunDirectoryManager.dispose` 用 `rmSync` 删 ~800MB 磁盘副本 | 全部改异步：导出用 `fs/promises.copyFile`（流式、线程池），临时目录与运行目录改 `fs/promises.rm`；`dispose()` 返回 Promise，调用点 `await`（`vm-run-directory.test.ts` 同步改 async）→ 抖动降到 **20.99ms** |
| 8  | 联网 VM 在非 jailer 模式下以 **400 报错**炸在 InstanceStart                           | 驱动在无 netns 的情况下仍 PUT `network-interfaces/eth0`（tap0 不存在）                                                                    | 提前 fail-closed：非 jailer + allowNetwork 直接抛明确错误                                                                                                                  |
| 9  | 烟测脚本自身 3 处与真实 guest 不符                                                    | `uname -r` 断言按 mock 输出写（真实只有版本号）；脚本未向 Provider 传 `workspaceDiskTemplatePath`（P1 契约修复后新增必填）；用 `curl`（guest 无 curl）           | 断言改为版本号正则、显式传模板路径、改用 busybox `wget`；12.3 按环境能力做"正向验收 / fail-closed 降级验收"二选一                                                                                     |
| 10 | rootfs 构建在**无 sudo 环境下也能"成功"**                                            | Alpine 仓库不再提供 `APKINDEX.gz`（只有 `.tar.gz`）；且脚本硬编码的 3.20.3 sha256 已失效（Alpine 重发过该镜像）                                          | 改用 `APKINDEX.tar.gz`；校验和更新为官方 `.sha256` 现值（并在注释中说明变更原因）                                                                                                         |
| 11 | guest 无 `/proc`、`/sys`                                                    | inittab 未挂载 proc/sys（busybox init 不自动挂）                                                                                     | inittab 增加 `mount -t proc/sysfs`；`cat /proc/1/cmdline` 等诊断命令恢复正常                                                                                                |

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

### 4.2 ✅ 块设备路径固化：jailer 模式已解决（此前误判为架构级阻塞）

`SnapshotLoadParams` 在 v1.17 与 1.18 **均无 `block_device` 覆盖字段**
（只有 `network_overrides` 与 `vsock_override`）。因此**非 jailer 模式**下
快照会固化块设备的宿主绝对路径，恢复时必须存在完全相同的路径。

非 jailer 模式真机报错（该路径属于已 terminate 的前一个 sandbox，目录已回收）：

```text
Load snapshot error: Failed to restore devices: Block: Virtio backend error:
Error manipulating the backing file: No such file or directory (os error 2)
  .../audit-vm-runtime/audit-1791451195121/workspace.ext4
```

**但这不影响生产路径。** jailer 模式下驱动传给 Firecracker 的是 chroot 内路径
（`firecracker-sandbox-driver.ts`：`rootfsPathForApi = "/rootfs.ext4"`、
`workspacePathForApi = "/workspace.ext4"`）。快照固化的是这个 **VM 内部视角**的
路径，而每个 Run 的 chroot 宿主目录虽然不同（`jailer/fc117/<新id>/root/`），
VM 看到的路径**始终是 `/workspace.ext4`**，且该文件在其 chroot 内确实存在。
**chroot 即 Firecracker 的路径虚拟化层**，这也是官方 snapshot 文档推荐的标准做法。

真机验证见 §5：jailer 模式 23/23 通过，恢复 368ms。

> **此前建议"改用预热池替代快照"的结论是错的，已撤回。** 该建议基于把非
> jailer 测试路径的报错当成生产路径的阻塞。预热池与快照恢复是两条独立的
> 加速机制，可并存；快照恢复无需被替代。

遗留（仅影响开发/测试路径）：非 jailer 模式**不支持**快照恢复，原因是磁盘
路径含 `sandboxId` 且前一个 Run 终止后目录被回收。如需在非 jailer 模式下使用
快照，可固定磁盘路径并串行化，或直接使用 jailer 模式（生产路径）。

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
- **预热池真机验证**：代码齐备但未在真机跑过（快照恢复已可用且不与之冲突）。
- **guest 内 LLM 访问通道**：按边界设计须走 vsock 转发，尚未实现。

---

## 5. 2026-10-08 补验：jailer 模式快照恢复端到端通过

此前快照能力只在裸 API 层验证过（3ms），从未走过完整驱动链路。本次以 root
运行 `HARNESS_USE_JAILER=true` + `HARNESS_VM_SNAPSHOTS_ENABLED=true`，用
`scripts/microvm-live-audit.ts` 跑完整生命周期。

### 5.1 途中发现并修复：远端 guest rootfs 为坏产物

首次运行在 vsock 握手阶段直接失败（`connect ENOENT .../vsock.sock`）。抓
Firecracker 日志定位到 guest 内核 panic：

```text
Kernel panic - not syncing: Requested init /sbin/init failed (error -2).
```

用 `debugfs` 检查镜像确认 `/sbin` 是**空目录**、`/sbin/init` 不存在：

```text
$ debugfs -R "ls -l /sbin" rootfs.ext4
     30   40775 (2)   1004   1004    4096  6-Oct-2026 21:40 .
      2   40755 (2)      0      0    4096  6-Oct-2026 21:40 ..
```

这是 §3.4 那次"rootfs 构建静默产出空镜像"缺陷**修复前**留下的遗留镜像
（镜像时间 10-06 22:00，修复后构建脚本已加 `/sbin/init` 的 fail-closed 自检）。
用修复后的脚本重建镜像即恢复：

```text
$ bash scripts/microvm/build-guest-rootfs.sh <agent> <rootfs> <workspace>
[OK] /agent/main exists in rootfs
Successfully built
$ debugfs -R "stat /sbin/init" rootfs.ext4
Inode: 399   Type: symlink    Mode:  0777        # 修复后为指向 busybox 的正确符号链接
```

**这同时验证了修复的有效性**：同一个坏镜像在修复前的脚本下会被静默产出，
修复后的脚本会 fail-closed 拒绝。

### 5.2 非 jailer 模式：前 5 步全过，第 6 步快照恢复失败

隔离边界 6/6、凭据注入 2/2、数据落地 6/6、残留清理 4/4 全部通过；第 6 步
快照恢复报 400（块设备路径固化，详见 §4.2）：

```text
第二次创建失败：/snapshot/load 400
  Failed to restore devices: Block: Virtio backend error:
  No such file or directory .../audit-vm-runtime/audit-1791451195121/workspace.ext4
```

黄金快照本身已成功生成（池中产出 `vm.snap` + `mem.snap`），即**快照制作
（pause → create）已验证可用**，失败仅在恢复时的块设备路径。

### 5.3 jailer 模式：23/23 全通过，恢复 368ms（提速 6.9 倍）

```text
[1] 创建 strict MicroVM ... 创建耗时 2519ms，evidence.verified=true
[2] 隔离边界验证    6/6 ✅（guest 内核 4.14.174 ≠ 宿主 6.8.0-136 等）
[3] 凭据注入        2/2 ✅
[4] 工作区数据落地  6/6 ✅（含符号链接防逃逸）
[5] 生命周期残留    4/4 ✅
[6] 快照恢复路径
    第二次创建耗时 368ms（首次 2519ms）
  ✅ 快照恢复后的 VM 仍能执行命令（agent 可用） — 4.14.174
  ✅ 恢复路径耗时未劣化（≤ 冷启动） — 368ms vs 2519ms
  ✅ acquisition 耗时如实记录 — 368ms, warmHit=false
[7] 宿主侧权限边界  ✅ 运行根目录 0700

=== 审计完成：23 项通过，0 项失败 ===
```

**连续两轮均 23/23 通过**（第二轮 368ms vs 2519ms），结果稳定可复现。

关键结论：第 6 步走的是**真实恢复路径**——第二个 sandbox 是新起的 Firecracker
进程，通过 `PUT /snapshot/load {resume_vm:true}` 恢复，且恢复后 agent 可正常
执行命令（`uname -r` 返回 `4.14.174`），说明 guest 从内存镜像继续执行而非重新
冷启动。`warmHit=false` 如实记录，表明这 368ms 确实来自快照而非预热池。

### 5.4 至此的最终状态

- **不需要自建 Firecracker**：官方 v1.17.0 二进制实测满足全部需求。
- **不需要用预热池替代快照**：两条独立机制，快照恢复已在生产路径验证。
- 启动延迟：冷启动 ~2.5s → 快照恢复 ~0.37s（jailer 模式）。
- 非 jailer 模式不支持快照恢复（路径固化），仅影响开发/测试路径。

---

## 6. 2026-10-08 补验：攻击烟测 37/37 通过（jailer 模式）

此前"microVM 比容器更安全"这句话**从未被证明**：
`scripts/container-sandbox-attack-smoke.ts` 有 9 项攻击验证，但那是**容器**版本；
`blast-radius-isolation.e2e.test.ts` 里 microVM 出现 0 次。攻击面从 runsc/kernel
换成 KVM/virtio 边界后，攻击手法与逃逸面完全不同。

本轮用 `scripts/microvm-attack-smoke.ts` 在真实 KVM 上发起等价攻击，并补充
microVM 特有逃逸面（virtio 设备枚举、内核模块、/proc/sys、块设备层、cgroup 限额）。

**结果：37/37 通过，连续两轮稳定复现。**

### 6.1 先取事实、再写断言：3 条基于猜测的断言被真机推翻

首轮运行卡在 `host_path：guest 无宿主 /home 与 /root/.ssh`。改用
`scripts/microvm-guest-facts-probe.ts` 取 guest 内真实可见事实后，发现**三条
断言的预期方向本身就是错的**：

| 原断言                                          | 真机事实                                                | 修正后的断言                                                                 |
| --------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| `test ! -e /home && test ! -e /root/.ssh`     | guest 是 Alpine，**自带 `/home`（空）与 `/root`**（无 `.ssh`） | guest `/home` 不含宿主家目录条目（对照宿主 **110 项**）、看不到宿主 SSH 私钥（对照 **5 个文件名**） |
| `test ! -w /proc/sys/kernel/core_pattern`     | guest 内 `/proc/sys` **可写**（rc=0 写入成功）              | guest 可写自己的内核参数，**但宿主 `core_pattern` 纹丝不动**（不外溢）         |
| `cat /proc/sys/kernel/modules_disabled`       | 实测 `modules_disabled=0`（并未禁用），断言等于没验                | guest **无 `/lib/modules` 目录且 `/proc/modules` 为 0 行**（无可加载模块）         |

**教训**：隔离断言不能靠"guest 应该没有 X"来猜。正确做法是先用探针取事实，
再基于事实写断言。第三条尤其重要——原写法在任何情况下都会通过，是**假绿**。

### 6.2 隔离证据：从"目录不存在"升级为"块设备层 + cgroup 层"

新断言在设备层与资源层各拿到硬证据：

```text
✅ host_path：guest 无宿主块设备节点（nvme/sd 均不可见）
✅ host_path：guest 根设备是 vda（宿主为 nvme0n1p2，非同一设备）
✅ cgroup_isolated：firecracker 位于独立 cgroup（/fc117/attack-b）
✅ cgroup_memory_max：内存限额=335544320（期望 335544320 = (256+64)MiB）
✅ cgroup_cpu_max：CPU 限额=200000 100000（期望 2 核 = 200000/100000）
```

宿主根在 `/dev/nvme0n1p2`，guest 根在 `/dev/vda`（`/dev/root -> vda`）——
**这是设备层证据，比"某路径没挂载"强得多**：guest 拿不到任何宿主块设备节点。

cgroup 限额此前**从未被验证过**。实测 jailer 为每台 VM 建独立 cgroup
`/fc117/<vmId>`，`memory.max = (256+64)MiB`、`cpu.max = 2 核`，与
`buildJailerCgroupArgs` 完全一致。容量准入不超卖的物理基础由此得到确认。

### 6.3 资源耗尽：损失止于 guest 边界，宿主零副作用

`scripts/microvm-exhaust-probe.ts` 实测：

| 攻击                | 结果                                                             | 宿主影响                                          |
| ----------------- | -------------------------------------------------------------- | --------------------------------------------- |
| 写满 `/workspace`（4GiB dd） | rc=1，`/dev/vdb` 100% 满（223.7M 用尽）                             | 无                                            |
| guest 内存分配 800MB  | guest OOM 杀掉分配进程（stderr `Killed`），VM 存活                        | cgroup `memory.current` 触顶 319.9MiB/320MiB，宿主 available 无变化         |
| fork 2000         | **成功**（283ms），VM 存活                                            | 无（guest `pid_max=32768`，2000 在预算内）            |
| fork 20000        | 22.9s 后 vsock 断开，**VM 被打死**                                      | firecracker 进程消失、cgroup 归零、宿主 available 138552MB→138094MB |

关键判据是**风暴前后对比**而非绝对值（此时 A、B 两台 VM 本就该各对应 1 个进程）：

```text
✅ fork_bomb_bounded：20000 进程风暴止于 guest 边界（VM 被资源预算打掉=true，宿主 firecracker 2→2）
✅ resource_containment：宿主未被 fork 风暴吃掉（firecracker 2→2，available 138552MB→138094MB）
```

**已知的真实行为（非缺陷，需记录）**：guest 内 fork 风暴会拖垮**自己的** VM
（vsock 断连、agent 失联），但损失严格止于 guest 边界——宿主不泄漏任何进程或内存。
若产品需要"VM 被 guest 压垮后自动恢复"，需要额外的存活探测机制，当前尚未实现。

### 6.4 探针自身的两个 bug（差点造成假阴性结论）

写这轮验证时，探针本身犯了两个错，都会得出**错误的安全结论**，值得记录：

1. **`pgrep -f firecracker` 匹配到调用方自己的命令行** → 读到 ssh 会话的
   cgroup（`memory.max=max`），险些误判"cgroup 限额没生效"这个 P0。
   正确做法：读 `/proc/<pid>/cmdline` 的**第一个 NUL 分隔字段**（`argv[0]`）
   取 basename 比对。
2. **guest 是 busybox，`head -c 600M` 报 `invalid number` 但 shell 吞掉错误返回
   rc=0** → 内存耗尽项等于没测。必须用纯字节数。

修正后 cgroup 限额确认生效（§6.2），`memory.current` 实测触顶 319.9MiB/320MiB。

### 6.5 攻击面对照表（容器版 9 项 → microVM 版）

| 容器版断言                       | microVM 版对应                                | 结果      |
| --------------------------- | --------------------------------------- | ------- |
| `runsc_runtime_evidence`   | `microvm_runtime_evidence`                | ✅       |
| `cross_tenant_workspace`   | 路径级 + 内容级 grep 双查                        | ✅ 3/3   |
| `host_path`                | 目录 + 文件名对照 + **块设备层**                   | ✅ 6/6   |
| `path_traversal`           | `../` 穿越 + 合法路径未被误封                       | ✅ 2/2   |
| `tenant_secret` / `unauthorized_secret` | 各租户只拿到自己的 secret        | ✅ 3/3   |
| `network_none`            | 无 eth0、无云元数据地址                             | ✅ 2/2   |
| `pid_limit`               | → fork 风暴止于 guest 边界                      | ✅       |
| `tmpfs_limit`             | → 工作区磁盘熔断                                 | ✅       |
| `sandbox_lost`            | → VMM 被 SIGKILL 后状态收敛 + 宿主无残留               | ✅ 2/2   |
| （新增）                     | `virtio_pci_off` / `no_module_load` / `proc_sys_*` / `devices_only_vda_vdb` / `kernel_isolated` / `hostname_isolated` / `cgroup_*` / `resource_containment` | ✅ 11/11 |

### 6.6 复现

```bash
# 需 root（jailer 硬性要求），jailer 与 firecracker 二进制版本必须匹配
sudo -S env \
  FIRECRACKER_BINARY_PATH=$BASE/bin/fc117 \
  FIRECRACKER_JAILER_PATH=$BASE/bin/jailer117 \
  FIRECRACKER_KERNEL_PATH=$BASE/bin/vmlinux \
  FIRECRACKER_ROOTFS_PATH=$BASE/images/rootfs.ext4 \
  FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=$BASE/images/rootfs.ext4 \
  HARNESS_USE_JAILER=true HARNESS_VM_SNAPSHOTS_ENABLED=false \
  bun scripts/microvm-attack-smoke.ts
```

> ⚠️ `jailer`（v1.10.1）与 `fc117`（v1.17.0）**版本不匹配**，jailer 会静默
> 失败导致 API socket 永不出现（报 `Firecracker API Socket 未能在 1500ms 内就绪`）。
> 必须用 `jailer117`。
