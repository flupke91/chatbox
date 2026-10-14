#!/usr/bin/env bash
set -euo pipefail

# Chatbox iOS 构建与侧载打包脚本
# 适用环境: macOS (Apple Silicon 或 Intel), 具备 Xcode 命令行工具与 CocoaPods

echo "=== 1. 安装前端与 Capacitor 依赖 ==="
export NODE_OPTIONS="--max-old-space-size=8192"
pnpm install --no-frozen-lockfile

echo "=== 2. 编译前端静态产物并同步到 iOS 工程 ==="
pnpm run mobile:sync:ios

echo "=== 3. 安装 CocoaPods 依赖 ==="
cd ios/App
pod install --repo-update

echo "=== 4. 使用 xcodebuild 归档 iOS App (无证书模式) ==="
rm -rf build
mkdir -p build
xcodebuild -workspace App.xcworkspace \
  -scheme App \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath build/App.xcarchive \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=NO \
  archive

echo "=== 5. 打包 Payload 生成可侧载的 Chatbox-iOS-unsigned.ipa ==="
cd build
mkdir -p Payload
cp -R App.xcarchive/Products/Applications/App.app Payload/
zip -qr Chatbox-iOS-unsigned.ipa Payload
zip -qr Chatbox-iOS-App.xcarchive.zip App.xcarchive

echo "=========================================================="
echo "✅ iOS 版本打包完成！产物位于:"
echo "   - ios/App/build/Chatbox-iOS-unsigned.ipa (可供 AltStore/Sideloadly/TrollStore 侧载)"
echo "   - ios/App/build/Chatbox-iOS-App.xcarchive.zip (Xcode 完整归档包)"
echo "=========================================================="
