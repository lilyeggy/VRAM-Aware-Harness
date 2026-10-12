// 所有讲解内容的单一数据源。事实依据见各字段 src 注释（均为仓库内源码）。

export const LAYERS = [
  { id: "access", name: "接入层", sub: "上层怎么用", color: "#5ac8fa" },
  { id: "manage", name: "管理层", sub: "怎么造、用、收", color: "#ffb547" },
  { id: "channel", name: "通道层", sub: "宿主 ↔ VM 怎么对话", color: "#3ddc97" },
  { id: "base", name: "底座层", sub: "VM 本体", color: "#b28dff" },
];

export const MODULES = [
  {
    id: "M8", layer: "access", name: "统一接口与路由",
    short: "Agent 只看到 create / execute / terminate",
    what: "对上暴露统一的 Sandbox 接口；按档位（strict/default）把请求分发到不同实现。生产环境经独立的 Broker 进程转发。",
    how: "SandboxProviderRouter 按 profile 路由；MicrovmSandboxProvider 做 fail-closed 检查、写隔离证据；BrokerSandboxProvider 通过 Unix socket 调 Broker（SO_PEERCRED + 控制 token 校验）。",
    code: "sandbox-provider-router.ts · microvm-sandbox-provider.ts · broker/*",
  },
  {
    id: "M3", layer: "manage", name: "私有目录 / UID / CID",
    short: "每台 VM 的身份证件与私有空间",
    what: "为每台 VM 分配 0700 私有目录、唯一 UID（20000–29999）和 vsock CID（从 3 起）。",
    how: "VmRunDirectoryManager 建目录；VmUidAllocator 取最小未用值；VmCidAllocator 分配 CID；socket 路径用短根目录避开 108 字节上限。",
    code: "vm-run-directory.ts · vm-uid-allocator.ts · vm-cid-allocator.ts",
  },
  {
    id: "M5", layer: "manage", name: "工作区磁盘",
    short: "工作区是一块 ext4 盘：挂进去，停机后拷出来",
    what: "每个 Run 一份工作区盘，作为 VM 的第二块盘挂到 /workspace；结束时把里面的文件导出回宿主工作区。",
    how: "复制模板 workspace.ext4 → Firecracker /drives/workspace → guest inittab 挂载 /dev/vdb；终止时先停机，再用 debugfs rdump 导出，并清理危险符号链接。",
    code: "workspace-disk-exporter.ts · build-guest-rootfs.sh",
  },
  {
    id: "M6", layer: "manage", name: "快照加速",
    short: "把开好机的 VM 存档，下次秒级恢复",
    what: "首台冷启动握手成功后制作\"黄金快照\"；同模板的后续 VM 直接恢复，省掉开机时间。",
    how: "模板指纹 = sha256(kernel+rootfs+agent版本)；KeyedSemaphore 按指纹单飞制作；恢复走 /snapshot/load 且必须最先调用。",
    code: "vm-snapshot-manager.ts · vm-concurrency-gate.ts · firecracker-sandbox-driver.ts",
  },
  {
    id: "M7", layer: "manage", name: "生命周期与孤儿回收",
    short: "先停进程，再删目录；崩溃后按 pidfile 清场",
    what: "规定销毁顺序；Harness 崩溃后回收遗留的 Firecracker 进程，避免吃满宿主内存。",
    how: "terminate: flush → stopVm(SIGKILL 并等待) → 导出 → 释放 UID/CID → 删目录；启动时 reapOrphans 读 vm.pid 验活后再杀。",
    code: "microvm-sandbox-provider.ts · vm-orphan-reaper.ts",
  },
  {
    id: "M4", layer: "channel", name: "vsock 命令通道",
    short: "结构化 JSON 帧，代替\"往串口打字\"",
    what: "宿主与 VM 之间唯一的命令通路。命令以 argv 数组发送，输出 base64 分块回传。",
    how: "宿主桥连 vsock.sock，发 CONNECT 5000，ping/pong 握手；guest 里 socat VSOCK-LISTEN:5000 fork 出 agent，agent 用 spawn(argv) 执行。",
    code: "firecracker-vsock-bridge.ts · guest/agent/main.ts",
  },
  {
    id: "M1", layer: "base", name: "Firecracker 与 Guest 镜像",
    short: "KVM 造出的小电脑 + Alpine 系统",
    what: "用硬件虚拟化造出有独立内核的 VM，并准备它的系统：内核、Alpine rootfs、socat、agent。",
    how: "驱动用 HTTP 调 Firecracker API：boot-source → drives → vsock → machine-config → InstanceStart。镜像由 build-guest-rootfs.sh 生成。无网卡（allowNetwork 恒拒绝）。",
    code: "firecracker-sandbox-driver.ts · scripts/microvm/build-guest-rootfs.sh",
  },
  {
    id: "M2", layer: "base", name: "jailer 宿主加固",
    short: "给管家进程上锁：降权 · chroot · 限额",
    what: "保护的是宿主，不是 VM。即使 Firecracker 进程被攻破，它也只是一个低权限、被关在笼子里的进程。",
    how: "jailer 切到专属 UID，chroot 到只含必要文件的目录，cgroup 限 cpu.max 与 memory.max（内存上限 = guest 内存 + 64MiB）。",
    code: "firecracker-sandbox-driver.ts（jailer 分支）· jailer-prereq-check.ts",
  },
];

// 一次 Run 的完整旅程（管理层 + 底座 + 通道）
export const CREATE_STEPS = [
  {
    title: "检查环境",
    who: "host",
    layer: "manage",
    desc: "确认 /dev/kvm 可读写、内核和 rootfs 存在、jailer 与 firecracker 二进制可用。缺一个就拒绝创建。",
    api: [],
    where: "firecracker-sandbox-driver.ts · create()",
  },
  {
    title: "分配身份",
    who: "host",
    layer: "manage",
    desc: "建 0700 私有目录；分配专属 UID；分配 vsock CID。",
    api: [],
    where: "vm-run-directory.ts · vm-uid-allocator.ts · vm-cid-allocator.ts",
  },
  {
    title: "准备材料",
    who: "host",
    layer: "manage",
    desc: "把内核、系统盘、工作区盘放进私有目录。内核默认硬链接（只读 0444）；系统盘默认整份复制；工作区盘每台独占。",
    api: [],
    where: "copyFileReflink · shareBaseFile",
  },
  {
    title: "改文件属主",
    who: "host",
    layer: "base",
    desc: "chown -R uid:gid。否则降权后的管家进程读不到这些文件。",
    api: [],
    where: "firecracker-sandbox-driver.ts · chown",
  },
  {
    title: "启动 jailer → Firecracker",
    who: "kvm",
    layer: "base",
    desc: "jailer 降权、chroot、套 cgroup，然后启动 Firecracker。此时它还是空壳，只开着 API socket。",
    api: ["jailer --id … --uid … --chroot-base-dir … --cgroup memory.max=…"],
    where: "jailer 分支 spawn(jailerPath)",
  },
  {
    title: "写 pidfile",
    who: "host",
    layer: "manage",
    desc: "把管家进程号写进 vm.pid。这是崩溃后找回它的唯一凭证。",
    api: [],
    where: "writePidFile()",
  },
  {
    title: "等待 API socket",
    who: "host",
    layer: "base",
    desc: "轮询 firecracker.socket，出现即说明管家在听。",
    api: [],
    where: "create() · waitForSocket",
  },
  {
    title: "插上假硬件",
    who: "kvm",
    layer: "base",
    desc: "通过 HTTP 依次配置启动内核、两块盘、vsock、CPU/内存。注意：没有网卡。",
    api: [
      "PUT /boot-source   { kernel, init=/sbin/init quiet }",
      "PUT /drives/rootfs { is_root_device: true }",
      "PUT /drives/workspace { /dev/vdb }",
      "PUT /vsock         { guest_cid, uds_path }",
      "PUT /machine-config { vcpu_count, mem_size_mib }",
    ],
    where: "putSocket(...) 调用序列",
  },
  {
    title: "开机",
    who: "kvm",
    layer: "base",
    desc: "KVM 让 CPU 进入虚拟化模式，从内核入口执行：内核识别设备 → 启动 init → 读 inittab。",
    api: ["PUT /actions { action_type: InstanceStart }"],
    where: "InstanceStart",
  },
  {
    title: "inittab 挂载 + 接线员就位",
    who: "guest",
    layer: "channel",
    desc: "把 /dev/vdb 挂成 /workspace；socat 在 vsock 5000 端口监听，每个连接 fork 一个 agent。",
    api: [
      "mount /dev/vdb /workspace",
      "socat VSOCK-LISTEN:5000,fork EXEC:/agent/main",
    ],
    where: "scripts/microvm/build-guest-rootfs.sh（inittab）",
  },
  {
    title: "握手打通通道",
    who: "host",
    layer: "channel",
    desc: "连 vsock.sock，发 CONNECT 5000，收到 OK，再 ping/pong。冷启动时每 100ms 重试，最多 20 秒。",
    api: ["CONNECT 5000 → OK", "{type:ping} → {type:pong}"],
    where: "firecracker-vsock-bridge.ts · connectWithRetry",
  },
  {
    title: "拍黄金快照（可选）",
    who: "kvm",
    layer: "manage",
    desc: "首台冷启动成功后冻结 VM，把内存与设备状态存成 vm.snap / mem.snap，供后续同模板 VM 直接恢复。",
    api: [
      "PATCH /vm { state: Paused }",
      "PUT /snapshot/create",
      "PATCH /vm { state: Resumed }",
    ],
    where: "vm-snapshot-manager.ts · 单飞闸门",
  },
];

// 销毁顺序
export const DESTROY_STEPS = [
  { title: "flush", desc: "让 guest 把文件缓存落盘（尽力而为）。" },
  { title: "stopVm", desc: "用 vm.pid 找到管家进程，SIGKILL 并等待它真正退出。此后 guest 不再写盘。" },
  { title: "导出", desc: "把 workspace.ext4 里的文件用 debugfs rdump 拷回宿主工作区。失败只记录，不中断清理。" },
  { title: "释放", desc: "释放 UID、CID，删除 chroot 与私有目录。顺序不能颠倒：先删目录，进程就成了孤儿。" },
];

// 一次 exec 的通信帧（与 firecracker-vsock-bridge.ts / guest/agent/main.ts 一致）
export const EXEC_REQUEST = {
  v: 1, type: "exec", id: "req-7f3a",
  argv: ["sh", "-lc", "ls /workspace"],
  cwd: "/workspace", timeoutMs: 60000, maxOutputBytes: 1048576,
};
export const EXEC_OUTPUT = { v: 1, type: "exec_output", id: "req-7f3a", stream: "stdout", data: "b3V0cHV0cwo=" };
export const EXEC_RESULT = { v: 1, type: "exec_result", id: "req-7f3a", exitCode: 0, timedOut: false, truncated: false };

// 启动耗时（来自项目文档 docs/vm-lifecycle-benchmark.zh-CN.md 与 platform-boundary.md 的历史真机实测，非本页重测）
export const COLD_MS = 1477;
export const WARM_BREAKDOWN = [
  { name: "copy-snapshot 拷快照进 chroot", ms: 298, color: "#ff6b6b" },
  { name: "copy-disks 拷内核/盘", ms: 110, color: "#ffb547" },
  { name: "vsock 握手", ms: 53, color: "#3ddc97" },
  { name: "api-socket 等待", ms: 20, color: "#5ac8fa" },
  { name: "snapshot-load（Firecracker 恢复本身）", ms: 7, color: "#b28dff" },
];
export const WARM_TOTAL_MS = 490;
