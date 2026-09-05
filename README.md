# Notepad

英语词条便利贴：贴在屏幕右缘，悬停扇出，点开查看释义。  
参考 [Noty](https://github.com/aimen08/noty) 的三态交互，Windows 版用 **Tauri 2 + React + GSAP**。

## 开发

需要：Node 22+、Rust、VS 2022 Build Tools（MSVC）、WebView2。

```bash
npm install
# 在「x64 Native Tools / VsDevCmd」环境中：
npm run tauri dev
```

## 用法

- 右侧细条悬停 / 点击 → 扇出词条 tab
- 点 tab → 抽出词卡（英文 + 中文 + 例句）
- `+` 快速添加词条；`Esc` 逐级收起
- Fan 空闲约 4s 收起；未固定词卡约 60s 收起
