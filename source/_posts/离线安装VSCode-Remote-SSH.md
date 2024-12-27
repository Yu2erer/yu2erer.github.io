---
title: 离线安装 VSCode Remote-SSH
categories: 搞东搞西
date: 2019-05-23 22:17:20
keywords: VSCode, Remote, SSH, 离线安装
tags: [VSCode]
---
VSCode 近期推出了 Remote-SSH 这个工具 使得 Linux开发者 能够在本地(Windows 机)上直接对开发机源码进行修改 简直拯救了一大批人啊... 但是却没有提到 如何离线安装 因此本文可能是最早 尝试离线安装的教程

## 离线安装

1. 本地上下载好 [VSCode Insiders](https://code.visualstudio.com/insiders/)
2. 安装 `Remote-SSH` 插件

<!-- more -->

3. 为 `Remote-SSH` 配置好 服务器 信息 记得要将 `Show Login Terminal` 置 true
4. 直接连接(中途会多次要求输入密码) 此时 会显示一行 `Download XXXXXX` 我们不要去理他 直接开一个终端 连上服务器 
5. 输入命令 `ps aux | grep vscode` 可以看到 有一行 写者 `sh /tmp/vscode-remote-install.XXXXXXXXXXXX.sh`
6. 我们将 XXXXXXX 复制下来 然后 在本地机器 也就是能联网的机器上 打开 以下链接
```
自行将 $COMMIT_ID 替换成 上面得到的数值
https://update.code.visualstudio.com/commit:$COMMIT_ID/server-linux-x64/insider
```
7. 然后打开下载到本地机器 接着进入服务器中的 `~/.vscode-remote/bin` 这个目录 可以看到 有一个文件夹的名字 和我们上面获得的 数值是一样的 
8. 我们进去 可以看到有个文件的文件名中间有个 lock. 我们将其删除 并 输入命令 `touch 0` 然后把上面下载到的文件 上传到这个目录下
9. `tar -xf filename` 解压到当前目录(注意是当前目录)
10. 重启 `VSCode Insiders` 重新连接服务器 很愉快的就能连接上了!

![VSCode_Remote_SSH](/images/VSCode_Remote_SSH.png)
图片上的 `a5536b8f5a16a10d859f3dec1e59701671bf069e` 就是我们一开始获得的 XXXXXXX 按照以上步骤完成之后 应该和图片上的一致.

## 离线安装插件
装好了 但是没有插件咋整? 打开插件的网页 然后将其下载下来 再传到 `~/.vscode-remote/extension` 这个目录 最后解压 重启 `VSCode Insiders` 完事
