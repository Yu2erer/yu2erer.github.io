---
title: Lua 5.3 设计实现(四) Closure与Upvalues
categories: Lua
date: 2020-12-5 22:29:20
keywords: Lua, Lua解释器, Lua5.3 Lua虚拟机
tags: [Lua, Lua虚拟机]
---

`Closure` 其实对于 `C/C++` 程序员可以简单理解为 函数。不过由于有了 `Upvalues` 的概念，会让人理解起来不那么容易，但是 Lua 中的所有函数 其实都是 闭包，包括我们第一篇 [Lua 5.3 设计实现(一) Lua是怎么跑起来的？](https://yuerer.com/Lua5.3-%E8%AE%BE%E8%AE%A1%E5%AE%9E%E7%8E%B0(%E4%B8%80)-Lua%E6%98%AF%E6%80%8E%E4%B9%88%E8%B7%91%E8%B5%B7%E6%9D%A5%E7%9A%84/)) 文章中提到的运行流程的第一个主函数，其实也是一个闭包。

本文中 函数与闭包的名字会混用，请根据其是否含有 Upvalue 进行区分。

## Closure

闭包是由 函数原型（Proto）+ （UpValue）组合而成的。

而 `Proto` 其实就是拥有所有执行所需要的信息，因为这一块在第一篇已经讲过，故大幅度跳过。

```c
typedef struct Proto {
  CommonHeader;
  lu_byte numparams;  // 固定函数个数
  lu_byte is_vararg;  // 是否是可变长参数
  lu_byte maxstacksize;  // 寄存器数量，用栈模拟
  int sizeupvalues;  // Upvalues 个数

  int sizek;  /* size of 'k' */
  int sizecode;
  int sizelineinfo;
  int sizep;  /* size of 'p' */
  int sizelocvars;

  int linedefined;  // 开始行号
  int lastlinedefined;  // 结束行号
  TString  *source; // 源文件名

  TValue *k;  // 常量表
  Instruction *code;  // 指令表
  struct Proto **p;  // 子函数原型表
  int *lineinfo;  // 行号表 行号与指令对应
  LocVar *locvars;  // 局部变量表
  Upvaldesc *upvalues;  // Upvalue 表

  struct LClosure *cache;  /* last-created closure with this prototype */
  GCObject *gclist;
} Proto;
```

我们更关注的是 `Upvalues`。

<!-- more -->

## Upvalues

upvalue 主要由 一个union 和 TValue 构成，在这里要理解一个概念。

upvalue 的 `open` 状态。

1. open：当我们说一个 upvalue 是 open 的，指的是这个 upvalue 其原始值还在数据栈上（因此这个对象如果是可回收的，则被扫描标记管理）。
2. close：如果说一个 upvalue 是 close 的，指的是这个 upvalue 已经不在栈上了，离开了作用域，会被拷贝到 `UpVal.u.value` 中，不受到垃圾回收的管控，而是被引用计数管理。

```c
struct UpVal {
  TValue *v;  /* points to stack or to its own value */
  lu_mem refcount;  /* reference counter */
  union {
    struct {  /* (when open) */
      UpVal *next;  /* linked list */
      int touched;  /* mark to avoid cycles with dead threads */
    } open;
    TValue value;  /* the value (when closed) */
  } u;
};

#define upisopen(up)	((up)->v != &(up)->u.value)
```

因此 当 upvalue 为 open 时，v 指向 栈上原始值的地址。反之，则将其值存入到 UpVal 这个结构体自身。

这也就是为什么 下面的代码能够正确执行的原因。

```lua
function Counter()
	local t = 0
	return function()
		t = t + 1
		return t
	end
end
```

return 回去这个 `function` 因为 t 已经不在栈上了，故将其值存入了这个 UpVal 结构体中，跟随着这个 function 一起。

结构中的 `open` 这一个结构体，则是当 UpVal 为 open态时，链接上所有的 open UpVal，方便后续的查找，而 `touched` 是为了防止垃圾回收时 还指向栈上对象的 `upvalue` 被清理。因为 垃圾回收的 `atomic` 有个 `remarkupval` 的函数，在里面进行重新标记 `upvalue` 。

## Closure

无论是 C 函数，还是 Lua 函数，其 UpValues 都与函数本身分离，但又被包裹在一个结构体中。

```c
typedef struct CClosure {
  ClosureHeader;
  lua_CFunction f;
  TValue upvalue[1];  /* list of upvalues */
} CClosure;

typedef struct LClosure {
  ClosureHeader;
  struct Proto *p;
  UpVal *upvals[1];  /* list of upvalues */
} LClosure;

typedef union Closure {
  CClosure c;
  LClosure l;
} Closure;
```

其中 C 函数很有可能没有 UpValue，因此 Lua 也提供了一种叫 light C function 的东西，直接将函数指针设到栈顶，其生命周期由 其 Host 去管理。

```c
LUA_API void lua_pushcclosure (lua_State *L, lua_CFunction fn, int n) {
  lua_lock(L);
  if (n == 0) {
    setfvalue(L->top, fn);
    api_incr_top(L);
  }
  else {
    CClosure *cl;
    api_checknelems(L, n);
    api_check(L, n <= MAXUPVAL, "upvalue index too large");
    cl = luaF_newCclosure(L, n);
    cl->f = fn;
    L->top -= n;
    while (n--) {
      setobj2n(L, &cl->upvalue[n], L->top + n);
      /* does not need barrier because closure is white */
    }
    setclCvalue(L, L->top, cl);
    api_incr_top(L);
    luaC_checkGC(L);
  }
  lua_unlock(L);
}

#define setfvalue(obj,x) \
  { TValue *io=(obj); val_(io).f=(x); settt_(io, LUA_TLCF); }
```

Lua 的闭包就比较复杂了

先是创建一个 闭包，然后才设置 其 UpValue。

```c
LClosure *luaF_newLclosure (lua_State *L, int n) {
  GCObject *o = luaC_newobj(L, LUA_TLCL, sizeLclosure(n));
  LClosure *c = gco2lcl(o);
  c->p = NULL;
  c->nupvalues = cast_byte(n);
  while (n--) c->upvals[n] = NULL;
  return c;
}

static void pushclosure (lua_State *L, Proto *p, UpVal **encup, StkId base,
                         StkId ra) {
  int nup = p->sizeupvalues;
  Upvaldesc *uv = p->upvalues;
  int i;
  LClosure *ncl = luaF_newLclosure(L, nup);
  ncl->p = p;
  setclLvalue(L, ra, ncl);  /* anchor new closure in stack */
  for (i = 0; i < nup; i++) {  /* fill in its upvalues */
    if (uv[i].instack)  /* upvalue refers to local variable? */
      ncl->upvals[i] = luaF_findupval(L, base + uv[i].idx);
    else  /* get upvalue from enclosing function */
      ncl->upvals[i] = encup[uv[i].idx];
    ncl->upvals[i]->refcount++;
    /* new closure is white, so we do not need a barrier here */
  }
  if (!isblack(p))  /* cache will not break GC invariant? */
    p->cache = ncl;  /* save it on cache for reuse */
}
```

UpValue 会根据其是否在栈上，用 Upvaldesc 中的 instack 字段进行表示。（一般是在 代码被编译的时候，写入到调试信息中，或者是判断这个 key 是否出现在 local 中进行判断），这里的在栈上并不意味着它被打开，如果不在则在上层函数中进行寻找。

最后将这个 闭包 存入 Proto 的 cache中，如果下次还要根据 `Proto` 生成 Closure，则先检查该 CLosure 的 `UpValue` 是否完全一致，如果是则复用，因此最好不要写出动态生成闭包的代码，避免性能的损耗。

```c
// 动态建立，判断是否为 local 是的话，则是在栈中
f->upvalues[fs->nups].instack = (v->k == VLOCAL);
// 从dump文件中读取
f->upvalues[i].instack = LoadByte(S);
```

如果在栈中，则会调用 `luaF_findupval` 函数。

这个函数从 openupval 链中找，如果找不到就新建一个。

```c
UpVal *luaF_findupval (lua_State *L, StkId level) {
  UpVal **pp = &L->openupval;
  UpVal *p;
  UpVal *uv;
  lua_assert(isintwups(L) || L->openupval == NULL);
  while (*pp != NULL && (p = *pp)->v >= level) {
    lua_assert(upisopen(p));
    if (p->v == level)  /* found a corresponding upvalue? */
      return p;  /* return it */
    pp = &p->u.open.next;
  }
  /* not found: create a new upvalue */
  uv = luaM_new(L, UpVal);
  uv->refcount = 0;
  uv->u.open.next = *pp;  /* link it to list of open upvalues */
  uv->u.open.touched = 1;
  *pp = uv;
  uv->v = level;  /* current value lives in the stack */
  if (!isintwups(L)) {  /* thread not in list of threads with upvalues? */
    L->twups = G(L)->twups;  /* link it to the list */
    G(L)->twups = L;
  }
  return uv;
}
```

## 思考题

如果能答对以下几个问题相信对这一节的内容就已经完全理解了。

以下代码。

1. 有几个 upvalue？
2. 在内存中存在几份 upvalue？
3. return 的时候会拷贝几次 upvalue？

```lua
local _table = {}

function _table.test1()
_table.i = 10
end

function _table.test2()
_table.j = 100
end
```

可以先看看指令码。

```lua
[root@localhost src]# luac -l -l main.lua 

main <main.lua:0,0> (6 instructions at 0x2216a20)
0+ params, 2 slots, 1 upvalue, 1 local, 2 constants, 2 functions
	1	[1]	NEWTABLE 	0 0 0
	2	[5]	CLOSURE  	1 0	; 0x2216cc0
	3	[3]	SETTABLE 	0 -1 1	; "test1" -
	4	[9]	CLOSURE  	1 1	; 0x2216ed0
	5	[7]	SETTABLE 	0 -2 1	; "test2" -
	6	[9]	RETURN   	0 1
constants (2) for 0x2216a20:
	1	"test1"
	2	"test2"
locals (1) for 0x2216a20:
	0	_table	2	7
upvalues (1) for 0x2216a20:
	0	_ENV	1	0

function <main.lua:3,5> (2 instructions at 0x2216cc0)
0 params, 2 slots, 1 upvalue, 0 locals, 2 constants, 0 functions
	1	[4]	SETTABUP 	0 -1 -2	; _table "i" 10
	2	[5]	RETURN   	0 1
constants (2) for 0x2216cc0:
	1	"i"
	2	10
locals (0) for 0x2216cc0:
upvalues (1) for 0x2216cc0:
	0	_table	1	0

function <main.lua:7,9> (2 instructions at 0x2216ed0)
0 params, 2 slots, 1 upvalue, 0 locals, 2 constants, 0 functions
	1	[8]	SETTABUP 	0 -1 -2	; _table "j" 100
	2	[9]	RETURN   	0 1
constants (2) for 0x2216ed0:
	1	"j"
	2	100
locals (0) for 0x2216ed0:
upvalues (1) for 0x2216ed0:
	0	_table	1	0
```

1. 可以看到 两个函数 都有一个 `upvalue` ，指的是 `_table`
2. 内存中只会有一份 `upvalue`，因为第一次 `luaF_findupval` 会发现 `openupval` 没有，于是新建了一个，第二次 `pushclosure` 也会执行到 `luaF_findupval` ，这时候 `openupval` 已经有了，于是直接指向它。
3. 从问题2可以得知，两个闭包指向的 `upvalue` 实际上为同一个，因此当这个文件被 `return` 的时候，只会拷贝一次到第一个闭包的 `upvalue` 上。