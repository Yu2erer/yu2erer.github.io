---
title: 实现 SOCKS5 网络混淆代理
categories: 
- [搞东搞西]
- [计算机网络]
date: 2019-02-22 09:42:20
keywords: 计算机网络, 网络协议, Socks5, 代理协议, GoSocksProxy, 酸酸
tags: [网络协议, 计算机网络, SOCKS5, GoSocksProxy]
---
在天朝这么久 你曾为网络状况不佳而烦恼过吗? 平时使用的 Shadowsocks 是怎么实现?
这篇讲的就是 如何用 Golang 实现一个最为基础的 Shdowsocks 的功能的软件 我将本文实现的软件取名叫 GoSocksProxy

老规矩先介绍一遍 什么是 GoSocksProxy? 它是怎么来的?

## [GoSocksProxy](https://github.com/Yu2erer/GoSocksProxy)
一个 Golang 所写的网络混淆代理 是学习 SOCKS5 协议时的副产品 为此还做了一张图

![GoSocksProxy](/images/GoSocksProxy.jpg)

<!-- more -->

## Shdowsocks大致原理
酸酸最主要是由两部分构成
#### ss-local
在本地监听的一个服务 本地主机的网络请求经过 ss-local 并加密(让防火墙不知道你在访问什么) 传输到 ss-server
#### ss-server
跑在 墙外的服务器 且监听来自本地的请求 对 ss-local 发来的数据进行解密 访问真实的目标服务地址 将其读出 并加密(目的同上) 发回本地

## SOCKS协议简介
一种网络传输协议 主要用于客户端与外网服务器之间通讯的中间传递 
* 是SOCKetS的简称 
* 是会话层的协议 位于表示层与传输层之间
    * Shdowsocks的数据传输建立于SOCKS5协议

最初由David Koblas开发，而后由NEC的Ying-Da Lee将其扩展到版本4。最新协议是版本5
* 支持UDP协议
* 支持用户身份验证和通信加密方式
* 支持IPv6

### SOCKS5协议详解
源自RFC:
* [RFC1928](https://www.ietf.org/rfc/rfc1928.txt)
* [RFC1929](https://www.ietf.org/rfc/rfc1929.txt)

RFC 1928 前半截给你介绍了 SOCKS产生的背景 和 现有 SOCKS4 的缺陷 然后引出了 SOCKS5

#### 建立连接
当一个SOCKS协议的客户端连接到服务端时 会发送 `版本信息` 和 `认证方式`的消息到服务器

```
+----+----------+----------+
|VER | NMETHODS | METHODS  |
+----+----------+----------+
| 1  |    1     | 1 to 255 |
+----+----------+----------+
```
* VER指的是 SOCKS版本 这里是SOCKS5 故为 0x05
* NMETHODS是 METHODS 的长度
* METHODS为 客户端锁支持的认证方式


NMETHODS 原文解释为 
> `The NMETHODS field contains the number of method identifier octets that appear in the METHODS field.`

里面的 octets 为 八位元组 相当于是 八位 一字节 为什么不直接用byte呢?
经过 Wiki 得知 不同计算机中的字节长度不同 使用 octets 是为了不引起歧义


接着服务端从中挑选一个认证方式 并将消息发回客户端
```
+----+--------+
|VER | METHOD |
+----+--------+
| 1  |   1    |
+----+--------+
```
* X'00' NO AUTHENTICATION REQUIRED(不需要认证)
* X'01' GSSAPI
* X'02' USERNAME/PASSWORD
* X'03' to X'7F' IANA ASSIGNED
* X'80' to X'FE' RESERVED FOR PRIVATE METHODS(私人方法保留)
* X'FF' NO ACCEPTABLE METHODS(都不支持)

本地监听服务器整个握手过程具体实现
```go
    buf := make([]byte, 263)
    n, _ := io.ReadAtLeast(conn, buf, 2) // 读入两个字节
    if buf[0] != 0x05 { // 判断SOCKS版本 只支持 SOCKS5
        return
    }
    conn.Write([]byte{0x05, 0x00}) // 告诉客户端 不需要认证
```

#### 发起请求
客户端正式发起请求 给 服务端 告诉服务端我现在访问的地址是哪里 你替我访问
```
+----+-----+-------+------+----------+----------+
|VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
+----+-----+-------+------+----------+----------+
| 1  |  1  | X'00' |  1   | Variable |    2     |
+----+-----+-------+------+----------+----------+
```
* VER protocol version: X'05'
* CMD(命令码 指示操作)
    * CONNECT X'01'
    * BIND X'02'
    * UDP ASSOCIATE X'03'
* RSV RESERVED(保留 为0x00)
* ATYP address type of following address(表示 DST.ADDR的类型)
    * IP V4 address: X'01'
    * DOMAINNAME: X'03'
    * IP V6 address: X'04'
* DST.ADDR desired destination address(目的地址)
* DST.PORT desired destination port in network octet order(目的端口)

到了这里 就可以将这个请求 转发 给墙外的服务器 由墙外的服务器来处理这个请求

服务端收到以后进行回复
```
+----+-----+-------+------+----------+----------+
|VER | REP |  RSV  | ATYP | BND.ADDR | BND.PORT |
+----+-----+-------+------+----------+----------+
| 1  |  1  | X'00' |  1   | Variable |    2     |
+----+-----+-------+------+----------+----------+
```
* VER protocol version: X'05'
* REP Reply field:
    * X'00' succeeded(成功)
    * X'01' general SOCKS server failure(普通SOCKS服务器连接失败)
    * X'02' connection not allowed by ruleset(现有规则不允许连接)
    * X'03' Network unreachable(网络不可达)
    * X'04' Host unreachable(主机不可达)
    * X'05' Connection refused(拒绝连接)
    * X'06' TTL expired(TTL 超时)
    * X'07' Command not supported(不支持的命令)
    * X'08' Address type not supported(地址类型不支持)
    * X'09' to X'FF' unassigned(未定义)
* RSV RESERVED
* ATYP address type of following address
    * IP V4 address: X'01'
    * DOMAINNAME: X'03'
    * IP V6 address: X'04'
* BND.ADDR server bound address(服务器绑定地址)
* BND.PORT server bound port in network octet order(服务器绑定端口)

本地监听服务器 将请求转发给 墙外服务器后 墙外服务器再做出相应操作

本地监听服务器具体实现
```go
    /*
        直接转发 socks5协议的请求的一部分到墙外服务器 从AYTR开始
        +------+----------+----------+
        | ATYP | DST.ADDR | DST.PORT |
        +------+----------+----------+
        |  1   | Variable |    2    |
        +----+-----+-------+--------+
    */
    dstServer, _ := s.DialServer()
    // 加密转发到墙外服务器
    dstServer.Write(buf[3:n])
    // 直接回应SOCKS客户端说请求成功
    conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00})
    // 接着就是不断的将墙外服务器的信息解密后传给SOCKS
    // SOCKS传来的信息加密后转发给墙外服务器
    go io.Copy(conn, dstServer)
    io.Copy(dstServer, conn)
```

墙外服务器具体实现
```go
buf := make([]byte, 263)
n, _ := io.ReadAtLeast(conn, buf, 5)

var dstIP []byte
// 根据传入进来的第一个字节判断访问地址的类型
switch buf[0] {
case 0x01: // ipv4
    dstIP = buf[1 : net.IPv4len+1]
case 0x03: // domainname
    ipAddr, err := net.ResolveIPAddr("ip", string(buf[2:n-2]))
    if err != nil {
        return
    }
    dstIP = ipAddr.IP
case 0x04: // ipv6
    dstIP = buf[1 : net.IPv6len+1]
default:
    return
}
// 传入进来的请求的最后两位为访问地址的端口
dstPort := buf[n-2:]
dstAddr := &net.TCPAddr{
    IP:   dstIP,
    Port: int(binary.BigEndian.Uint16(dstPort)),
}

// 墙外服务端另起一个请求 去访问真正要访问的地址 例如 google.com
client, _ := net.DialTCP("tcp", nil, dstAddr)
// 最后源源不断的从 真正的请求中读出数据并加密转发给 本地监听服务器
go io.Copy(conn, client)
// 从本地监听服务器读出要访问的地址并解密转发给 client做真正的请求操作
io.Copy(client, conn)
```

## 至此 
最主要的功能就实现完了 完整的源码 已经放到 [Github: GoSocksProxy](https://github.com/Yu2erer/GoSocksProxy)