---
title: Lua 5.3 源码剖析(一) 基础数据结构与基础操作
categories: Lua
date: 2020-07-26 13:14:20
keywords: Lua, 源码剖析, 虚拟机
tags: [Lua, 源码剖析, 虚拟机]
---

由于之前实习包括现在正式的工作 都做的是 游戏服务端研发, 少不了 与 Lua 打交道, 因此 也对 Lua 的实现产生了兴趣, 在这里试图 将 Lua 的实现原理 剖析出来, 此为本系列的首篇.

本文主要分两个部分 一个部分是剖析 Lua 中内置的各种类型的数据结构, 另一个部分是剖析 Lua 虚拟机中所要用的必要的数据结构.

## 基础数据结构

### 基本类型

众所周知, Lua 的基本类型 非常少, 仅有 int, number(浮点数), 闭包(函数), userdata(指针), string, nil, table 等类型. 这种时候 就要 有一个数据结构 来方便的表示出 这几种类型.

```c
typedef union Value {
  GCObject *gc;    // GC回收用的 暂时可以理解成一个链表 链上所有可回收的对象

  void *p;         /* light userdata */
  int b;           /* booleans */
  lua_CFunction f; /* light C functions */
  lua_Integer i;   /* integer numbers */
  lua_Number n;    /* float numbers */
} Value;

#define TValuefields	Value value_; int tt_

typedef struct lua_TValue {
  TValuefields;
} TValue;
```

<!-- more -->

Value 这个数据结构 采用 union 的形式组成 可以节省内存.

值得注意的是 其中的 lua_Interger 和 lua_Number 的大小 是通过 对编译器进行适配 即判断 编译环境是否支持 64bits, 若支持 则默认开启 "完整的lua" 编译, 也可以通过配置参数 来编译 "Small lua" , 这里的完整 与 不完整 指的是 int 和 number 是用 int64, double 编译, 还是 int32, float 来编译的意思.

```c
// 以下为 64bits 环境下的 代码片段
#define LUA_INTEGER long
#define LUA_NUMBER double

// 32bits
#define LUA_INTEGER int
#define LUA_NUMBER float
```

最后 将这些 数据结构 组合成 TValue, 可以看到 其中有一个 `int tt_` 的东西, 这个是用于 确认 TValue 的类型的, 以下为 `tt_` 中所能表示的 "一部分类型"

```c
/*
** basic types
*/
#define LUA_TNONE		(-1)
#define LUA_TNIL		0
#define LUA_TBOOLEAN		1
#define LUA_TLIGHTUSERDATA	2
#define LUA_TNUMBER		3
#define LUA_TSTRING		4
#define LUA_TTABLE		5
#define LUA_TFUNCTION		6
#define LUA_TUSERDATA		7
#define LUA_TTHREAD		8
#define LUA_NUMTAGS		9
```

为什么 说是 一部分呢? 因为 lua 源码在 以上几个类型 又进行了 一次细分, 因为 基础类型最大的数值也就用到 9, 只用到了低4位 因此可以从高4位做文章, 当想知道其具体类型的时候 就可以通过`TValue.tt__ & 0x3F // (bits 0-3 for tags + variant bits 4-5)` 获取到更具体的类型

```c
/* Variant tags for functions */
#define LUA_TLCL	(LUA_TFUNCTION | (0 << 4))  /* Lua closure */
#define LUA_TLCF	(LUA_TFUNCTION | (1 << 4))  /* light C function */
#define LUA_TCCL	(LUA_TFUNCTION | (2 << 4))  /* C closure */

/* Variant tags for strings */
#define LUA_TSHRSTR	(LUA_TSTRING | (0 << 4))  /* short strings */
#define LUA_TLNGSTR	(LUA_TSTRING | (1 << 4))  /* long strings */

/* Variant tags for numbers */
#define LUA_TNUMFLT	(LUA_TNUMBER | (0 << 4))  /* float numbers */
#define LUA_TNUMINT	(LUA_TNUMBER | (1 << 4))  /* integer numbers */
```

了解完了 lua_Integer 和 lua_Number 的类型之后, 就轮到 lua_CFunction 了

```c
/*
** Type for C functions registered with Lua
*/
typedef int (*lua_CFunction) (lua_State *L);
```

可以看到 这就是一个函数指针. 还有两个 类型别名

```c
/* chars used as small naturals (so that 'char' is reserved for characters) */
typedef unsigned char lu_byte;
typedef size_t lu_mem;
```

可能是为了 代码 好阅读吧, 大部分的类型都会协成 lu_xxx 的形式

通过以上的内容 我们可以得知 Lua 中的内置类型 本质上就是 一个 union 将所有类型包起来, 再通过组合的形式 嵌入一个 tt_ 来获取 Value 的类型.

### 虚拟机

#### CallInfo

描述了一个 函数 信息

```c
/*
** Information about a call.
** When a thread yields, 'func' is adjusted to pretend that the
** top function has only the yielded values in its stack; in that
** case, the actual 'func' value is saved in field 'extra'.
** When a function calls another with a continuation, 'extra' keeps
** the function index so that, in case of errors, the continuation
** function can be called with the correct top.
*/
typedef struct CallInfo {
  StkId func;  // 被调用函数在stack中的位置
  StkId	top;  // 被调用函数栈顶的位置
  struct CallInfo *previous, *next;  // 被调用函数的上一个和下一个调用的链表地址

  union {
    struct {  /* only for Lua functions */
      StkId base;  /* base for this function */
      const Instruction *savedpc;
    } l;
    struct {  /* only for C functions */
      lua_KFunction k;  /* continuation in case of yields */
      ptrdiff_t old_errfunc;
      lua_KContext ctx;  /* context info. in case of yields */
    } c;
  } u;

  ptrdiff_t extra;
  short nresults; // 想要多少个返回值
  unsigned short callstatus; // 调用状态
} CallInfo;
```

#### lua_State

描述了 lua虚拟机 信息

```c
#define CommonHeader	GCObject *next; lu_byte tt; lu_byte marked
// GC回收链表, lua_State 也是一个可回收的对象, tt 表示该对象的类型, marked表示是否进行回收
struct lua_State {
  CommonHeader;
  GCObject *gclist; // 将由 lua_State 开辟出来的新对象都挂载在此 用于 GC回收的时候扫描

  unsigned short nci; // CallInfo 有多少个
  lu_byte status; // 当前 Lua 协程状态
  global_State *l_G; // 指向 Global_State
  CallInfo *ci;  // 当前执行的 CallInfo

  const Instruction *oldpc;  /* last pc traced */

  StkId top;  // 栈顶
  StkId stack_last; // 栈底 此处不能被使用
  StkId stack; // 栈
  int stacksize; // 栈的大小

  UpVal *openupval; // 栈中 open upvalues
  struct lua_State *twups;  // 协程中的 open upvalues

  struct lua_longjmp *errorJmp; // 弥补C语言没有异常捕获机制的设计(就是用它来设计C语言的异常)
  CallInfo base_ci; // 第一层级的 CallInfo 即与 lua_State 共存亡的
  ptrdiff_t errfunc; // 错误函数在栈中的索引

  unsigned short nny; // 多少个不可抢占的调用 non-yieldable calls in stack
  unsigned short nCcalls; // 多少次函数调用

  int basehookcount;
  int hookcount;
  volatile lua_Hook hook;
  l_signalT hookmask;
  lu_byte allowhook;
};
```

#### global_State

```c
typedef struct global_State {
  lua_Alloc frealloc; // 用于开辟内存 相当于全局的内存配置器
  void *ud; // 没用到
  TValue l_registry; // 寄存器
  lua_CFunction panic; // 异常的时候, 会调用这个函数
	struct lua_State *mainthread; // lua_State

	// 内部的一些信息 Begin
  const lua_Number *version;  /* pointer to version number */
  TString *memerrmsg;  /* memory-error message */
  TString *tmname[TM_N];  /* array with tag-method names */
  struct Table *mt[LUA_NUMTAGS];  /* metatables for basic types */
	// 内部的一些信息 End

  // GC Begin 暂时不讨论
  lu_byte currentwhite;
  lu_byte gcstate;  /* state of garbage collector */
  lu_byte gckind;  /* kind of GC running */
  lu_byte gcrunning;  /* true if GC is running */
  GCObject *allgc;  /* list of all collectable objects */
  GCObject **sweepgc;  /* current position of sweep in list */
  GCObject *finobj;  /* list of collectable objects with finalizers */
  GCObject *gray;  /* list of gray objects */
  GCObject *grayagain;  /* list of objects to be traversed atomically */
  GCObject *weak;  /* list of tables with weak values */
  GCObject *ephemeron;  /* list of ephemeron tables (weak keys) */
  GCObject *allweak;  /* list of all-weak tables */
  GCObject *tobefnz;  /* list of userdata to be GC */
  GCObject *fixedgc;  /* list of objects not to be collected */
	unsigned int gcfinnum;  /* number of finalizers to call in each GC step */
  int gcpause;  /* size of pause between successive GCs */
  int gcstepmul;  /* GC 'granularity' */
	l_mem totalbytes;  /* number of bytes currently allocated - GCdebt */
  l_mem GCdebt;  /* bytes allocated not yet compensated by the collector */
  lu_mem GCmemtrav;  /* memory traversed by the GC */
  lu_mem GCestimate;  /* an estimate of the non-garbage memory in use */
	// GC End

  struct lua_State *twups; // 协程中的 open upvalues

  // 字符串 部分 Begin
  stringtable strt; // 用于字符串的哈希表
  unsigned int seed; // 随机数 用于字符串 哈希
  TString *strcache[STRCACHE_N][STRCACHE_M]; // 字符串缓存
	// 字符串 End
 
} global_State;
```

简单看看 可以知道 里面有一大部分都是 GC 的内容 暂时不谈论, 还有一部分是 关于 TString 的, 也暂时不谈论.

可以看出 global_State 主要就里面有个分配内存的函数 frealloc 可以进行自定义 默认为如下函数, 还有一个 版本是带 内存池的.

```c
static void *l_alloc (void *ud, void *ptr, size_t osize, size_t nsize) {
  (void)ud; (void)osize;  /* not used */
  if (nsize == 0) {
    free(ptr);
    return NULL;
  }
  else
    return realloc(ptr, nsize);
}
```

mainthread 其实就是虚拟机状态, 本质上来说可以理解为 一个协程 故而名字为 mainthread

### luaL_newstate

```c
LUALIB_API lua_State* luaL_newstate(void) {
	// 将上面的内存配置器 放入其中, 然后调用 lua_newstate
  lua_State* L = lua_newstate(l_alloc, NULL);
  if (L)
    lua_atpanic(L, &panic); // 开辟内存失败则写入字符串 同时 abort
  return L;
}
static int panic(lua_State* L) {
	// fprintf
  lua_writestringerror("PANIC: unprotected error in call to Lua API (%s)\n", lua_tostring(L, -1));
  return 0; /* return to Lua to abort */
}

// Create a new lua process, a lua_State and a global_State
LUA_API lua_State* lua_newstate(lua_Alloc f, void* ud) {
  int i;
  lua_State* L;
  global_State* g;

	// LG 其实就是把 lua_State 和 global_State 合并在一起的结构体一次分配好内存
	// 避免内存碎片
  LG* l = cast(LG*, (*f)(ud, NULL, LUA_TTHREAD, sizeof(LG)));
  if (l == NULL)
    return NULL;

  L = &l->l.l;
  g = &l->g;
  L->next = NULL;
  L->tt = LUA_TTHREAD;

  g->currentwhite = bitmask(WHITE0BIT);
  L->marked = luaC_white(g);
  preinit_thread(L, g);
  g->frealloc = f;
  g->ud = ud;
  g->mainthread = L;
  g->seed = makeseed(L); // seed for calculate the string hash
  g->gcrunning = 0; /* no GC while building state */
  g->GCestimate = 0;
  g->strt.size = g->strt.nuse = 0;
  g->strt.hash = NULL;
  setnilvalue(&g->l_registry);
  g->panic = NULL;
  g->version = NULL;
  g->gcstate = GCSpause;
  g->gckind = KGC_NORMAL;
  g->allgc = g->finobj = g->tobefnz = g->fixedgc = NULL;
  g->sweepgc = NULL;
  g->gray = g->grayagain = NULL;
  g->weak = g->ephemeron = g->allweak = NULL;
  g->twups = NULL;
  g->totalbytes = sizeof(LG);
  g->GCdebt = 0;
  g->gcfinnum = 0;
  g->gcpause = LUAI_GCPAUSE;
  g->gcstepmul = LUAI_GCMUL;
  for (i = 0; i < LUA_NUMTAGS; i++)
    g->mt[i] = NULL;
	// 以保护模式 执行 f_luaopen函数 本质其实就是 用 setjmp 实现了C语言的异常机制(不懂就往下翻)
  if (luaD_rawrunprotected(L, f_luaopen, NULL) != LUA_OK) {
    /* memory allocation error: free partial state */
    close_state(L);
    L = NULL;
  }
  return L;
}

typedef struct LX {
  lu_byte extra_[LUA_EXTRASPACE];
  lua_State l;
} LX;
typedef struct LG {
  LX l;
  global_State g;
} LG;

static void f_luaopen(lua_State* L, void* ud) {
  global_State* g = G(L);
  stack_init(L, L); // 初始化 栈 这个函数尤其关键 因此我打算拆出来讲
  init_registry(L, g);
  luaS_init(L); // init lua string
  luaT_init(L); // init tag method name
  luaX_init(L); // lex
  g->gcrunning = 1; // 允许 GC
  g->version = lua_version(NULL); // 设置为空 则会返回写死的版本号
}
```

### stack_init

前面注释提到过 之所以单独把这个函数拆解出来 是因为这个函数比较关键

```c
#define EXTRA_STACK 5
#define LUA_MINSTACK 20
#define BASIC_STACK_SIZE (2 * LUA_MINSTACK)
/*
逻辑上比较简单 初始化 40个栈的空间, 然后预留了 5个空位 作为容错缓冲区
同时也是为了出错的时候 有地方把错误信息存进去
*/
static void stack_init(lua_State* L1, lua_State* L) {
  int i;
  CallInfo* ci;
  L1->stack = luaM_newvector(L, BASIC_STACK_SIZE, TValue);
  L1->stacksize = BASIC_STACK_SIZE; // 2 * 20 = 40
  for (i = 0; i < BASIC_STACK_SIZE; i++)
    setnilvalue(L1->stack + i);
  L1->top = L1->stack;
  L1->stack_last = L1->stack + L1->stacksize - EXTRA_STACK; // 预留了 5 个空位
  /* initialize first ci */
  ci = &L1->base_ci; // base_ci are the struct in lua_State, not alloc mem
  ci->next = ci->previous = NULL;
  ci->callstatus = 0;
  ci->func = L1->top; // the first block of stack not used forever
  setnilvalue(L1->top++); /* 'function' entry for this 'ci' */
  ci->top = L1->top + LUA_MINSTACK;
  L1->ci = ci; // pointer to the L1->base_ci
}
```

## 基础操作

以下都将以 integer 做例子

### 入栈

```c
LUA_API void lua_pushinteger(lua_State* L, lua_Integer n) {
  setivalue(L->top, n);
  api_incr_top(L);
}

#define setivalue(obj, x) \
  { \
    TValue* io = (obj); \
    val_(io).i = (x); \
    settt_(io, LUA_TNUMINT); \
  }
#define val_(o) ((o)->value_)
#define settt_(o, t) ((o)->tt_ = (t))
#define api_incr_top(L) \
  { \
    L->top++; \
  }
```

### 出栈

```c
// pop 多少个
#define lua_pop(L, n) lua_settop(L, -(n)-1)

LUA_API int lua_gettop(lua_State* L) {
  return cast_int(L->top - (L->ci->func + 1));
}  

LUA_API void lua_settop(lua_State* L, int idx) {
  StkId func = L->ci->func;
  if (idx >= 0) {
    while (L->top < (func + 1) + idx)
      setnilvalue(L->top++);
    L->top = (func + 1) + idx;
  } else {
    L->top += idx + 1; /* 'subtract' index (index is negative) */
  }
}
```

### 获取栈上的值

这里的栈比较特别, 因为本质是用数组实现的, 可以实现随机访问

```c
#define lua_tointeger(L, i) lua_tointegerx(L, (i), NULL)

LUA_API lua_Integer lua_tointegerx(lua_State* L, int idx, int* pisnum) {
  lua_Integer res;
  const TValue* o = index2addr(L, idx);
  int isnum = tointeger(o, &res);
  if (!isnum)
    res = 0;
  if (pisnum)
    *pisnum = isnum;
  return res;
}

/*
正数/负数 正常索引 恰好等于 LUA_REGISTRYINDEX 则去寄存器 如果比 LUA_REGISTRYINDEX 还小
就从upvalues找
*/
LUAI_DDEF TValue* index2addr(lua_State* L, int idx) {
  CallInfo* ci = L->ci;
  if (idx > 0) {
    TValue* o = ci->func + idx; // 正数则从ci->func往上索引
    if (o >= L->top)
      return NONVALIDVALUE; // nil
    else
      return o;
  } else if (!ispseudo(idx)) { // 负数 会有一个下限的判定
    // 0 >= idx > LUA_REGISTRYINDEX
    return L->top + idx;
  } else if (idx == LUA_REGISTRYINDEX) 
		// 临界值则判定从寄存器中索引 LUA_REGISTRYINDEX=-1000000-1000
    return &G(L)->l_registry;
  else { /* upvalues */
		// idx 如果比 LUA_REGISTRYINDEX 还小 则去 upvalues 找
    idx = LUA_REGISTRYINDEX - idx;
    // idx should <= MAXUPVAL, so why plus one?
    if (ttislcf(ci->func)) /* light C function? */
      return NONVALIDVALUE; // nil
    else {
      CClosure* func = clCvalue(ci->func);
      return (idx <= func->nupvalues) ? &func->upvalue[idx - 1] : NONVALIDVALUE;
    }
  }
}

// 检查是否为整型, 若不是则判断是否为浮点 整型(感觉存在重复判定了), 字符串, 将其转为整型 失败则为 0
#define tointeger(o, i) (ttisinteger(o) ? (*(i) = ivalue(o), 1) : luaV_tointeger(o, i, LUA_FLOORN2I))
#define ttisinteger(o) checktag((o), LUA_TNUMINT)
#define checktag(o, t) (rttype(o) == (t))
#define rttype(o) ((o)->tt_)
```

### C语言的异常机制

首先要确立一点, C语言并不支持原生的异常捕获机制, 但是C标准库提供了两个函数 去实现这一行为.

不过 如果是在 C++下编译 则默认采用 try catch 去完成这一过程.

```c
/*
setjmp 将当前的上下文环境保存起来, 直接调用返回值为0
若从 longjmp 调用返回则返回longjmp的第二个参数的值
longjmp 返回到 setjmp 的位置(恢复上下文) 并将第二实参带回给 setjmp 所在位置作为返回值返回
缺点就是 luaD_rawrunprotected不能够将抛弃的栈中的数据做 清理工作. 即 Destructor.
*/
#define LUAI_THROW(L,c)		longjmp((c)->b, 1)
#define LUAI_TRY(L,c,a)		if (setjmp((c)->b) == 0) { a }

l_noret luaD_throw (lua_State *L, int errcode) {
  if (L->errorJmp) { // 如果 errorJmp 不为空, 说明有错误处理函数
    L->errorJmp->status = errcode;
    LUAI_THROW(L, L->errorJmp); // 回到 调用 LUAI_TRY 的地方
  }
  else { // 没有错误处理函数, 则交给 global_State
    global_State *g = G(L);
    L->status = cast_byte(errcode);
    if (g->mainthread->errorJmp) {
			// global_State 中的 主虚拟机 如果有错误处理函数, 则交给它
			// 因为 L 很可能不是主虚拟机 而是其中创建出来的一个协程, 其中一个没有设置错误处理函数
			// 则交给 主虚拟机 看看有没有错误处理函数 如果也没有 那就让 global_State 去执行 panic
      setobjs2s(L, g->mainthread->top++, L->top - 1);
      luaD_throw(g->mainthread, errcode);
    }
    else {
      if (g->panic) {
        seterrorobj(L, errcode, L->top);  /* assume EXTRA_STACK */
        if (L->ci->top < L->top)
          L->ci->top = L->top;  /* pushing msg. can break this invariant */
        g->panic(L);  /* call panic function (last chance to jump out) */
      }
      abort();
    }
  }
}
```

### luaD_rawrunprotected(L, f_luaopen, NULL)

现在我们可以回过头来看这个函数, 这个函数在 lua_newstate 中被调用 luaD_rawrunprotected(L, f_luaopen, NULL)

```c
// 相信此时已经不需要我解释什么了 hhh
int luaD_rawrunprotected(lua_State* L, Pfunc f, void* ud) {
  unsigned short oldnCcalls = L->nCcalls;
  struct lua_longjmp lj; // longjmp struct save on the c stack
  lj.status = LUA_OK;
  lj.previous = L->errorJmp; /* chain new error handler */
  L->errorJmp = &lj;
  LUAI_TRY(L, &lj, (*f)(L, ud););
  L->errorJmp = lj.previous; /* restore old error handler */
  L->nCcalls = oldnCcalls;
  return lj.status;
}
```

### 调用函数

```c
#define LUAI_MAXCCALLS 200
// 其中的 hook 之类的函数 可忽略, 为调试的时候 用户设置的钩子函数
void luaD_call(lua_State* L, StkId func, int nResults) {
  if (++L->nCcalls >= LUAI_MAXCCALLS)
    stackerror(L);
  if (!luaD_precall(L, func, nResults)) /* is a Lua function? */
    luaV_execute(L); // 如果是 Lua 的函数 则用虚拟机去解析字节码
  L->nCcalls--;
}

// 如果调用函数等于200个, 就软错误, 超过 200 + 25个 则抛出异常
static void stackerror(lua_State* L) {
  if (L->nCcalls == LUAI_MAXCCALLS)
    luaG_runerror(L, "C stack overflow");
  else if (L->nCcalls >= (LUAI_MAXCCALLS + (LUAI_MAXCCALLS >> 3)))
    luaD_throw(L, LUA_ERRERR); /* error while handing stack error */
}

int luaD_precall(lua_State* L, StkId func, int nresults) {
  lua_CFunction f;
  CallInfo* ci;
  switch (ttype(func)) {
    case LUA_TCCL: /* C closure */
      f = clCvalue(func)->f;
      goto Cfunc;
    case LUA_TLCF: /* light C function */
      f = fvalue(func);
    Cfunc : {
      int n; // 返回值个数
      checkstackp(L, LUA_MINSTACK, func); // 栈不够20 就会开一个新栈
      ci = next_ci(L); // 创建新的 CallInfo
      ci->nresults = nresults;
      ci->func = func;
      ci->top = L->top + LUA_MINSTACK;
      ci->callstatus = 0;
      if (L->hookmask & LUA_MASKCALL)
        luaD_hook(L, LUA_HOOKCALL, -1);
      n = (*f)(L); // 真正执行函数
      luaD_poscall(L, ci, L->top - n, n); // 主要是从栈中 获取返回值
      return 1;
    }
    case LUA_TLCL: { /* Lua function: prepare its call */
      StkId base;
      Proto* p = clLvalue(func)->p;
      int n = cast_int(L->top - func) - 1; /* number of real arguments */
      int fsize = p->maxstacksize; /* frame size */
      checkstackp(L, fsize, func);
      if (p->is_vararg)
        base = adjust_varargs(L, p, n);
      else { /* non vararg function */
        for (; n < p->numparams; n++)
          setnilvalue(L->top++); /* complete missing arguments */
        base = func + 1;
      }
      ci = next_ci(L); /* now 'enter' new function */
      ci->nresults = nresults;
      ci->func = func;
      ci->u.l.base = base;
      L->top = ci->top = base + fsize;
      ci->u.l.savedpc = p->code; /* starting point */
      ci->callstatus = CIST_LUA;
      if (L->hookmask & LUA_MASKCALL)
        callhook(L, ci);
      return 0;
    }
    default: { /* not a function */
      // check 1 stack size for meta method
      checkstackp(L, 1, func); /* ensure space for metamethod */
      tryfuncTM(L, func); /* try to get '__call' metamethod */
      return luaD_precall(L, func, nresults); /* now it must be a function */
    }
  }
}

// 主要是 回退 CallInfo 然后 调用 moveresults 去获取返回值
int luaD_poscall(lua_State* L, CallInfo* ci, StkId firstResult, int nres) {
  StkId res;
  int wanted = ci->nresults;
  if (L->hookmask & (LUA_MASKRET | LUA_MASKLINE)) {
    if (L->hookmask & LUA_MASKRET) {
      ptrdiff_t fr = savestack(L, firstResult); /* hook may change stack */
      luaD_hook(L, LUA_HOOKRET, -1);
      firstResult = restorestack(L, fr);
    }
    L->oldpc = ci->previous->u.l.savedpc; /* 'oldpc' for caller function */
  }
  res = ci->func; // 把返回值 依次挪到 func 在栈中的位置
  L->ci = ci->previous; // 回退 CallInfo
  // 移动返回值到 res 的位置 如果不存在 则设置为 nil
  return moveresults(L, firstResult, res, nres, wanted);
}
```

实际上 还有一个 带保护的 调用函数的接口

```c
struct CallS { /* data to 'f_call' */
  StkId func;
  int nresults;
};

static void f_call(lua_State* L, void* ud) {
  struct CallS* c = cast(struct CallS*, ud);
  luaD_callnoyield(L, c->func, c->nresults); // 
}
// 使用方法: luaD_pcall(L, f_call, &c, savestack(L, c.func), func);
int luaD_pcall(lua_State* L, Pfunc func, void* u, ptrdiff_t old_top, ptrdiff_t ef) {
  int status;
  CallInfo* old_ci = L->ci;
  lu_byte old_allowhooks = L->allowhook;
  unsigned short old_nny = L->nny;
  ptrdiff_t old_errfunc = L->errfunc;
  L->errfunc = ef;
	// 使用 LUAI_TRY 调用 f_call函数
	// 如果出错就回退 没出错的话 则继续执行
  status = luaD_rawrunprotected(L, func, u);
  if (status != LUA_OK) { /* an error occurred? */
    StkId oldtop = restorestack(L, old_top);
    luaF_close(L, oldtop); /* close possible pending closures */
    seterrorobj(L, status, oldtop);
    L->ci = old_ci;
    L->allowhook = old_allowhooks;
    L->nny = old_nny;
    luaD_shrinkstack(L);
  }
  L->errfunc = old_errfunc;
  return status;
}
```

## 总结

在本篇中, 剖析了Lua 基本类型的数据结构, 和 虚拟机的一些数据结构与函数, 相信在阅读完这一篇文章后, 读者已经有能力模仿 Lua 实现一个 不带GC的, 与C交互的, 简单的虚拟机.