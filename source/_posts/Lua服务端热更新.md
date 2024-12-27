---
title: Lua 服务端热更新
categories: Lua
date: 2020-12-15 12:19:20
keywords: Lua, Lua解释器, Lua5.3 Lua虚拟机, 服务端, 热更新
tags: [Lua, Lua虚拟机]
---

游戏服务端之所以用 Lua，大多数时候是因为 Lua 方便做热更新，一般来说对 Lua 做热更新基本上都会使用以下两句语句。

```lua
package.loaded[name] = nil
require(name)
```

这种方式的热更好处就是简单，不过有的代码写起来就要特别小心，当你在代码中看到以下类似的片段，很有可能是为了热更新做的一种妥协。

```lua
Activity.c2sFun = Activity.c2sFun or {};
```

同时，如果 Lua 代码中存有大量的 `upvalue` 时，还要记得保存原有的状态信息，否则会丢失原值，对于开发人员来说，这种热更方式费心费力。

因此， `Lua HotFix` 就是为了摆脱以上的限制，或者说减少需要关心的事情，让开发人员能够更为简单的做热更新。之所以要自己写这么一套东西，主要是因为网络上开源的热更方案不适合项目，要么支持的Lua版本过旧，要么就约束的过多，项目已经进行到了中后期，这个时候再来规范已经来不及了，其次有很多的错误，这点我会在本文中的第二部分进行讨论。

本文主要分为两个部分，第一部分为 HotFix 实现，第二部分为热更新的错误案例。

<!-- more -->

## HotFix 实现

首先放出 [HotFix](https://github.com/Yu2erer/LuaHotFix) 源码。

通过 `loadfile` 将文件读入 Lua ，此时为一个 `function` 也就是 chunk，设置这个 `function` 的执行环境为我的 假环境表 我管它叫 `fakeEnv` ，在里面替换掉一些函数，然后执行 `chunk` ，就能从 `fakeEnv` 得到一系列的函数，全局变量信息。

接下来是确定什么能更新，什么不能更新。首先函数必更新，因为你热更不更逻辑，要你有何用？其次数据默认不更新，为什么是默认不更新，主要考虑到 `upvalue` ，优先保证服务器正常运作（哪怕我热更失败），但是 table 这个类型我们要更新，只更新函数即可，table 中的数据也采用默认不更新的思路（因为项目中会在 table 中保存状态数据）。

这个时候就能成功的更新上新的逻辑了，此时就要考虑数据的更新，因为我们不确定什么数据是需要更新的（比如说配置信息），因此默认是不更新数据的，如果需要更新数据，则通过 在模块中加入 `__RELOAD` 函数，因为什么数据要更新，使用者最为清楚，其次使用这个 `__RELOAD` 函数，代码入库也极为方便，基本上把热更修改后的文件直接入库就行了。

代码片段示例

```lua
yuerer = {}
yuerer.age = 21

function __RELOAD()
	yuerer.age = 22
end

__RELOAD() -- 热更后可直接入库
```

因此，使用这套热更新有以下约束

1. 除了函数会更新，其他默认不更新（table 里面的数据也不会默认更新，因为有的开发人员喜欢在 table 里保存状态数据）
2. 如果要更新或新增除了函数以外的信息，自行定义 __RELOAD 函数，并实现
3. 不支持 userdata，thread 类型 
4. 不要存任何 function，table 的引用（或者是显式在 __RELOAD 函数中重置引用）
5. 不要热更 _ENV 的 metatable

## How to use

1. 假设我们 require 了一个模块 fix1，此时我们要更新 fix1 中的代码。

```lua
require("fix1")
local HotFix = require("HotFix")
HotFix:UpdateModule("fix1")
```

这样就能实现最基础的 除 `userdata` `thread` 类型的热更新

1. 如果想要更新数据，请在 fix1 模块下 写一个 `__RELOAD` 函数
这主要是基于两个原因
    - 数据可能有状态信息
    - 方便入库

```lua
function __RELOAD()
    -- do some things
end
```

## 热更新的错误案例

热更新的方案在网络上多种多样，我将会挑选出几个常见的错误，在这里进行讨论。

### 错误①

更新前的函数没有 `_ENV` 这个 `upvalue` ，依赖对 `table` 进行热更的方式无法生效。

假设我有一个函数 `error1` 写错了，现在要进行热更。以下代码片段分别表示热更前与热更后，如果我采用函数替代的形式，我能更新的上吗？

```lua
--------------- 热更前
local count = 0
function error1()
	count = count + 1
end

--------------- 热更后
local count = 0
function error1()
	count = count + 2
end
```

显然是不能的，我们先来看看 `error1` 的热更前的版本的指令，可以看出，函数体只有一个 `upvalue`。

```lua
function <test.lua:3,5> (4 instructions at 0x1687da0)
0 params, 2 slots, 1 upvalue, 0 locals, 1 constant, 0 functions
	1	[4]	GETUPVAL 	0 0	; count
	2	[4]	ADD      	0 0 -1	; - 1
	3	[4]	SETUPVAL 	0 0	; count
	4	[5]	RETURN   	0 1
constants (1) for 0x1687da0:
	1	1
locals (0) for 0x1687da0:
upvalues (1) for 0x1687da0:
	0	count	1	0
```

这个时候因为函数体没有调用任何全局函数 或是 全局变量，自然没有 `_ENV` 这个环境表作为 `upvalue`，也就没有办法通过改写 `_ENV[error1] = error1` 的方式修改全局表的 `error1` 的函数地址（除非你显式的加上 rawset(_ENV, error1, xxxx)，然而大多数开源的方案都没注意到这个问题)。因此当你热更后调用 `error1` 的时候还是会调用的热更前的版本。

而下面的版本就可以更新成功。

```lua
--------------- 热更前
local count = 0
function error1()
	count = count + 1
	print()
end

--------------- 热更后
local count = 0
function error1()
	count = count + 2
	print()
end
```

我们再来看一下 这个版本的热更前的指令。可以看到 这次函数里面有了 `_ENV`，我们此时可以通过改写这个 `upvalue` 的内容来达到替换 `error1` 的目的。

```lua
function <test.lua:3,6> (6 instructions at 0x733da0)
0 params, 2 slots, 2 upvalues, 0 locals, 2 constants, 0 functions
	1	[4]	GETUPVAL 	0 0	; count
	2	[4]	ADD      	0 0 -1	; - 1
	3	[4]	SETUPVAL 	0 0	; count
	4	[5]	GETTABUP 	0 1 -2	; _ENV "print"
	5	[5]	CALL     	0 1 1
	6	[6]	RETURN   	0 1
constants (2) for 0x733da0:
	1	1
	2	"print"
locals (0) for 0x733da0:
upvalues (2) for 0x733da0:
	0	count	1	0
	1	_ENV	0	0
```

解决方案我认为分为两种。

1. 鸵鸟，毕竟一个模块从头至尾不调用 全局函数 或是 操作全局变量 的概率实在是太低了（热更模块中任意函数有用到就行，估计这也是很多开源热更方案没有检查出这种错误的原因）
2. 检查对函数热更的时候，有没有操作过 `_ENV` 如果没有，则通过 `rawset(_ENV, k, v)` 这种补丁的形式覆写环境表。

### 错误②

使用 `debug.setupvalue` 进行 `upvalue` 修复。以下代码猜一下执行结果。

```lua
local count = 0
function error2()
	print(count)
end

function error2_another()
	print(count)
end

error2()

error2_another()

debug.setupvalue(error2, 2, 1000) -- set error2 upvalue:count = 1000

error2()
error2_another()
```

答案揭晓，都为 1000。大部分的热更都没有考虑到一个 `upvalue` 会同时被一个以上的函数所使用的情况。

正确的热更方式是采用 `debug.upvaluejoin` 进行关联。

出现这样的错误主要还是因为分不清 `debug` 中 `setupvalue` 与 `upvaluejoin` 的区别。

### 错误③

还记得上个错误案例的 `debug.setupvalue` 吗？这里要讨论的是它和它的兄弟 `debug.getupvalue`。

```lua
debug.getupvalue (f, up)
此函数返回函数 f 的第 up 个上值的名字和值。 如果该函数没有那个上值，返回 nil 。
```

可以看到，它的第二个参数为索引，那么考虑一下下面的代码片段，能否热更成功呢？

```lua
--------------- 热更前
local count = 0
function error3()
	count = count + 1
end

--------------- 热更后
function error3()
	print(count)
end
```

聪明的人可能已经发现了，如果我们按照索引来取 `upvalue` 然后更新到下面的那个函数中，是有问题的，我们来分别看看指令。

热更前的函数，第一个 `upvalue` 为 count。

```lua
function <test.lua:3,5> (4 instructions at 0x19acda0)
0 params, 2 slots, 1 upvalue, 0 locals, 1 constant, 0 functions
	1	[4]	GETUPVAL 	0 0	; count
	2	[4]	ADD      	0 0 -1	; - 1
	3	[4]	SETUPVAL 	0 0	; count
	4	[5]	RETURN   	0 1
constants (1) for 0x19acda0:
	1	1
locals (0) for 0x19acda0:
upvalues (1) for 0x19acda0:
	0	count	1	0
```

热更后的函数，第一个 `upvalue` 则为 `_ENV` 这是因为我们在这里先调用了 `print` 这个全局函数。

```lua
function <test.lua:8,10> (4 instructions at 0x19aceb0)
0 params, 2 slots, 2 upvalues, 0 locals, 1 constant, 0 functions
	1	[9]	GETTABUP 	0 0 -1	; _ENV "print"
	2	[9]	GETUPVAL 	1 1	; count
	3	[9]	CALL     	0 2 1
	4	[10]	RETURN   	0 1
constants (1) for 0x19aceb0:
	1	"print"
locals (0) for 0x19aceb0:
upvalues (2) for 0x19aceb0:
	0	_ENV	0	0
	1	count	1	0
```

因此，热更 `upvalue` 的时候，一定不能默认更新前后的函数 `upvalue` 的顺序是不变的。

### 错误④

小心重复更新。下面的代码展示了一个错误案例。

```lua
--------------- 热更前
local k = 0
local count = function()
  return k
end

function c1()
  local i = count()
  print("c1", i)
end

function c2()
  local i = count()
  print("c2", i)
end

--------------- 热更后
local k = 0
local j = 1
local count = function()
	k = k + j
   return k
end

function c1()
  local i = count()
  print("c1", i)
	c2()
end

function c2()
  local i = count()
  print("c2", i)
	c3()
end

function c3()
  print("c3", j)
end
```

正如我们前面所说，热更模块的实现无非是只替换函数与表中的函数，而数据则是默认用旧值，需要更新的数据在我所写的框架中需要定义一个 `__RELOAD()` 函数，在里面填写需要更新的数据（这块如果不记得的话，可以回到前面，了解一下我为什么要这么设计）

首先我们来讨论更新前，更新前没有 `c3` 函数，

现在来讨论更新后，更新后增加了一个 `c3` 函数，这种时候更新到 `c1` 时，会跟着 `c1` 的 `_ENV` 去更新 `c2` （因为 ENV 是一个 table 需要更新）， `c2`也有 `_ENV`  然后又会更新 `c1`  ，还会更新 `c3` 此时因为 `c3` 原本是一个不存在函数，直接设进 `_ENV` 就行了。

这个时候更新了 `c2` ，你可能有疑惑 不是 `c2` 已经更新过了吗？之前更新的 `c2` 是因为 `c1` 的 `_ENV` 更新到的，这次是由 假环境表中找出来更新的， `c2` 顺着自己的 `_ENV` 又会更新到 `c3` ，第二次更新 `c3` 的时候，因为之前我们已经设置到真正的 `_ENV` 去了，此时就要重新更新 `c3` 的 `upvalue` ，可这个“旧函数” 是同一次热更中产生的，因此在有的时候会导致 `c3` 的 `upvalue` 关联到错误的地址。

因此，要小心重复更新，无论是 table 也好， 还是 function 也好。

## 总结

Lua 热更新是一个值得研究的东西，它非常有趣，能够让你更理解 Lua 的运行机制，同时能够减轻项目开发人员的负担，由于时间关系，目前足够支持各个项目组各种奇怪的写法，在开源中的实现里应该是较为全面的，由于现有项目中不使用协程，而且是一个全Lua的框架，因此也没有 `userdata` ，目前来看是足够了。

唯一我觉得不足的地方，当其他地方存储一个 `function` 作为 callback 的时候，没法直接更新到，通常是采用调用字符串的形式来调用函数（其实就是从 `_ENV` 找这个函数的地址），如果可以将这一块做到 Lua 虚拟机中，就能实现更完美的热更新了。