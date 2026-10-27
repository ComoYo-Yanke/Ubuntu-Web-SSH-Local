# Ubuntu Web SSH

一个尽量小的 Web SSH 工具：在浏览器里连接 Ubuntu Server，使用真实 PTY 终端，支持 screen、SFTP 上传下载和 CPU/内存/磁盘监控。

技术栈固定为 Node.js + Express + ssh2 + ws，前端是单个 `index.html`，终端使用 CDN 引入的 xterm.js。

## 文件结构

```text
server.js     后端：SSH 会话、WebSocket 终端、监控、上传下载
index.html    前端：登录、xterm 终端、监控 Canvas、文件传输、screen 按钮
package.json  仅 express、ssh2、ws 三个依赖
README.md
```

## 启动

要求 Node.js 18+，并且浏览器可以访问 jsDelivr CDN（xterm.js 从 CDN 加载）。

```bash
npm install
node server.js
```

也可以：

```bash
npm start
```

默认监听 `3000` 端口：

```text
http://localhost:3000
```

局域网其他设备访问：

```text
http://<运行 server.js 的机器 IP>:3000
```

自定义端口：

```bash
PORT=8080 node server.js
```

然后输入 Ubuntu 的 host/IP、SSH 端口、用户名和密码即可连接。服务端需要能访问目标机器的 SSH 端口。

## 使用说明

### 终端

- 使用真实的 SSH PTY（`term=xterm-256color`），浏览器尺寸变化会同步给远程终端。
- 支持在终端里直接运行 `ls`、`top`、`vim` 等交互程序。
- 运行 `screen -S demo` 后，可通过终端内快捷键或右侧「screen 窗口」按钮切换窗口。
- 页面刷新后会尝试用当前标签页的 session 恢复终端；服务重启后需要重新输入密码。
- 「重连终端」用于 WebSocket/网络断开后重连；「断开」会主动销毁服务端会话。

### screen 快捷按钮

右侧按钮会先发送 `Ctrl+A`，再发送对应按键：

- `N`：下一个窗口
- `P`：上一个窗口
- `0` - `9`：跳到指定编号窗口

使用前先在终端里启动 `screen`。如果没有安装：

```bash
sudo apt install screen
```

### 文件传输

- 上传：选择本地文件，填写远程目录（默认 `/tmp`），点「上传」。后端通过临时本地文件 + `sftp.fastPut` 写入远程。
- 下载：填写远程文件路径（默认 `/etc/hostname`），点「下载」。后端通过 `sftp.fastGet` 下载到临时文件，再作为附件返回浏览器。
- 页面会显示上传进度、上传/下载成功或错误信息。
- 远程目录需要有写权限；下载路径需要有读权限。

### 资源监控

连接成功后，前端每 3 秒请求一次 `/metrics`。后端在同一个 SSH 连接上执行：

```bash
top -bn1 | grep "Cpu(s)" ; free -m ; df -h /
```

解析并展示：

- CPU 使用率 = `100 - idle`
- 内存已用 / 总量（`free -m`）
- 根分区已用 / 总量 / 使用率（`df -h /`）

手动对比时，请在服务器上执行同样的命令。`top` 第一次采样的 CPU 数值会受采样窗口影响，短时间内有少量偏差是正常的。

## 验收步骤

1. 启动 `node server.js`，打开页面，输入 IP、22、Ubuntu 用户名和密码。
2. 连接后在终端执行 `ls`、`top`，确认输出和颜色正常。
3. 执行 `screen -S demo`；按 `Ctrl+A` 再按 `C` 创建新窗口，按 `N`/`P` 或点击右侧按钮切换。
4. 本地随便选一个文件上传到 `/tmp`，再下载 `/etc/hostname`，检查浏览器下载内容。
5. 观察右侧 CPU/内存/磁盘进度条，每 3 秒刷新；与服务端命令结果核对。

## 已知限制

- 密码只保存在 `server.js` 进程内存的 session Map 中，不写磁盘；进程重启后所有连接信息失效。
- 没有业务层登录、权限、HTTPS 或多用户隔离。**不要直接暴露到公网**，建议只在本机/可信内网使用。
- 没有 SSH host key 校验，ssh2 默认接受服务器主机密钥；不适合连接不受信任的网络目标。
- 前端只管理一个当前连接。后端理论支持多个 sessionId，但没有会话 TTL，异常关闭页面后会话会留在内存，直到进程重启或主动断开。
- 页面刷新会在当前标签页的 `sessionStorage` 中保留 `sessionId` 和用于显示的 `user@host:port`，但不保留密码。
- 上传文件会先进入 Node 进程内存，并写入系统临时目录，再由 `fastPut` 发送；默认请求体上限为 2 GB，超大文件不建议使用此工具。下载也会先落到临时文件。
- 需要浏览器能加载 jsDelivr 上的 xterm.js；完全离线环境需要自行把 xterm.js 和 CSS 下载到本地并改引用。
- 监控依赖 Ubuntu 常见的 `top`、`free`、`df` 输出格式；最小化系统或非 Ubuntu 系统可能需要调整解析。
- 只使用密码（或 keyboard-interactive 密码）认证，暂不支持 SSH 私钥。
