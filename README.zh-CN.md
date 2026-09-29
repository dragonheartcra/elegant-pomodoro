<div align="center">

# Elegant Pomodoro · 优雅番茄钟

[English](./README.md) | 简体中文

**一款赏心悦目的番茄钟，内置 FlowTunes 音乐频道与环境音混音。**

<br>

<img src=".github/images/app-main.png" width="300" alt="主窗口">
&nbsp;&nbsp;&nbsp;
<img src=".github/images/app-music.png" width="300" alt="音乐面板">

</div>

---

## 概览

优雅番茄钟把经典的圆形表盘番茄钟和 [FlowTunes](https://flowtunes.app)
的音乐体验结合在了一起：专注时有 41 个 AI 音乐频道实时流式播放，休息时可以
切换到另一个频道，还能把多种环境音按各自音量混进音乐里。暂停计时，音乐也
会跟着暂停。

本项目基于 [Pomotroid](https://github.com/Splode/pomotroid) fork 而来——
Pomotroid 的计时功能全部保留。

## 功能

**计时器**

- 独立系统线程 + 单调时钟漂移校正，长时间计时依然精准
- 专注 / 短休 / 长休，循环轮数可配置
- 自动开始下一轮、重开本轮、跳过本轮
- 系统托盘实时进度弧
- 会话统计：每日热力图、小时柱状图、连续专注天数

**音乐与环境音**

- 41 个 FlowTunes 频道（6700+ 首曲目）直接流式播放，无需下载
- 专注与休息使用各自独立的频道，轮次切换自动换台
- 可选「休息时自动播放」，音乐面板内置播放控制
- 65 种环境音（雨声、篝火、鸟鸣……）可多选混音，每种独立音量
- 播放状态与计时器完全同步：暂停 / 恢复 / 停止一起走

**其他**

- 38 套内置主题 + 自定义主题热重载，见 [THEMES.md](THEMES.md)
- 8 种界面语言（English、简体中文、Deutsch、Español、Français、日本語、
  Português、Türkçe）
- 全局与应用内快捷键（可自定义绑定）
- 可选的本地 WebSocket 服务，向第三方集成暴露实时计时状态
- 自定义提示音、紧凑模式、窗口位置记忆

## 下载

前往 [Releases](../../releases) 获取安装包或便携版可执行文件。打 tag 后 CI
会产出 Windows 构建，同时也会构建 Linux 和 macOS 产物。所有二进制**均未签
名**，首次运行时 SmartScreen / Gatekeeper 会提示，属正常现象。

## 从源码构建

前置要求：[Node.js](https://nodejs.org) ≥ 22、npm、[Rust](https://rustup.rs)
stable 工具链（以及 C/C++ 构建环境，Windows 上即 Visual Studio Build Tools）。

```sh
npm install
npm run tauri dev      # 开发模式运行
npm run tauri build    # 产出安装包到 src-tauri/target/release/bundle/
```

## 音乐数据说明

仓库内置的频道目录、环境音列表、频道图标与运行时流式播放的音频均属于
[FlowTunes](https://flowtunes.app)，此处仅作个人非商业用途使用，详见
[static/flowtunes/NOTICE.md](static/flowtunes/NOTICE.md)。这部分内容不受本
仓库 MIT 许可证覆盖。如果你喜欢这些音乐，请支持原服务。如需在其他项目中
转载这些数据，请先开 issue 沟通。

## 许可证

优雅番茄钟以 [MIT](LICENSE) 协议开源。

- 计时核心与设计语言：fork 自
  [Pomotroid](https://github.com/Splode/pomotroid)，© 2018 Christopher Murphy。
- FlowTunes 频道数据与流式音频：版权归 FlowTunes 所有（见上方说明）。
- 字体：[Mona Sans](https://github.com/github/mona-sans)，© GitHub，采用
  [SIL Open Font License 1.1](static/fonts/OFL.txt) 授权。
