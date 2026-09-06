# VocabDock

Windows 屏幕右缘停靠的英语词条便利贴（Tauri 2 + React + GSAP）。  
交互参考 [Noty](https://github.com/aimen08/noty)：收起彩条 → 扇出标签 → 抽出词卡。

> 安装后不会弹出普通大窗口。请看屏幕**最右侧彩色细条**，或托盘图标「VocabDock」。

## 功能

- 右缘 **rest pill** 悬停展开词条 tab；点开词卡查释义 / 例句 / 翻译
- 有道词典 + Bing 翻译补全；释义尽量自动填入
- 置顶多卡可同时停留；⠿ 拖到任意位置（拖动会自动置顶）
- 空白区域点击穿透，不挡下面的桌面 / IDE
- `Esc` 逐级收起；空闲自动收回

## 环境

- Node 22+
- Rust stable
- Visual Studio 2022 Build Tools（MSVC）
- WebView2（Windows 10/11 一般已自带）

## 开发

```bash
npm install
npm run tauri -- dev
```

## 打包

```bash
npm run tauri -- build
```

产物：

- `src-tauri/target/release/vocabdock.exe`
- `src-tauri/target/release/bundle/nsis/VocabDock_0.1.0_x64-setup.exe`

## 许可

个人 / 学习用途。词典与翻译数据来自第三方服务，请遵守其使用条款。
