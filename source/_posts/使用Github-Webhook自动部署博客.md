---
title: 使用 Github Webhook 自动部署 博客
categories: 搞东搞西
date: 2018-11-27 19:06:20
keywords: github, webhook, blog, deploy
tags: [Github, Webhook]
---
### 使用 Github Webhook 前
在搭建 这个 Blog 的早期 还没有用到自动部署
因此 每次发布 一篇新的文章 亦或是 修改了 Blog 的一些设置或者内容时 至少要经历以下几件事情

1. 生成 Blog 静态页面
2. 将其 `git push` 到 git 仓库
3. ssh 登录 服务器
4. 服务器 `git pull` 更新 Blog 静态页面

每次都要经历以上四件事情 实在是太繁琐了 因此决定使用 Github Webhook 进行自动部署

<!-- more -->

### 使用 Github Webhook 后
当使用了 Github Webhook 后 更新 Blog 就变成了以下 两件事情
1. 生成 Blog 静态页面
2. 将其 `git push` 到 git 仓库 

方便了不少 具体怎么做呢?
#### 部署 部署服务器
服务器首先是要有一个 一个部署脚本 和 自动部署服务器(我用 Golang 简易实现了一个)
```sh
#!/bin/sh
cd ~/~~~~
git pull ~~~~
```
```golang
package main

import (
	"io/ioutil"
	"encoding/hex"
	"crypto/sha1"
	"io"
	"crypto/hmac"
	"log"
	"os/exec"
	"net/http"
)

func reLaunch() {
	cmd := exec.Command("sh", "./deploy.sh")
	err := cmd.Start()
	if err != nil {
		log.Fatal(err)
	}
	err = cmd.Wait()
}
func index(w http.ResponseWriter, r *http.Request) {

	signature := r.Header.Get("X-Hub-Signature")
	if len(signature) <= 0 {
		return
	}
	payload, _ := ioutil.ReadAll(r.Body)
	mac := hmac.New(sha1.New, []byte("这里填写你的 Secret"))
	_, _ = mac.Write(payload)
	expectedMac := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(signature[5:]), []byte(expectedMac)) {
		io.WriteString(w, "<h1>401 Signature is error!</h1>")
		return
	}
	io.WriteString(w, "<h1>200 Deploy server is running!</h1>")
	reLaunch()
}
func main() {
	http.HandleFunc("/", index)
	http.ListenAndServe(":1111", nil)
}
```
#### 设置 Github

1. 先在 Github 上 找到 自己的仓库 的 Settings
2. 在 Payload URL 中设置 自己的 自动部署服务器 URL
3. Secret 设置一个密码 (如果不设置的话 就没办法判断是 Github 访问了你的部署服务器 还是 其他不怀好意的人)
3. 选择 只有 Push 事件时 才触发 Hook
4. 添加

![Github_Webhook](/images/Github_Webhook.png)

Github Webhook 每当 Push 事件发生时 就会 Post 请求访问 我们设置的 Payload URL (请求的 header 会有一个 X-Hub-Signature='sha1=xxxx' 的值 它是由 我们设置的 Secret sha1 加密 再加上 请求的 Body sha1 加密而来) 只要判断 这个 X-Hub-Signature 的值是否和我们预想的一样 就能知道这次请求是不是真的由 Github Webhook 发起的.

若判定通过 则调用我们的 部署脚本 进行部署