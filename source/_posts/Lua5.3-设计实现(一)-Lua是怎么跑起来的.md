---
title: Lua 5.3 设计实现(一) Lua是怎么跑起来的?
categories: Lua
date: 2020-10-25 13:12:20
keywords: Lua, Lua解释器, Lua5.3 Lua虚拟机
tags: [Lua, Lua虚拟机]
---

其实在此之前已经写了一个 Lua 5.3 源码剖析系列，还有好几篇存档没有发。为什么突然又不发了呢？（甚至还删了），是因为我感觉之前那样学习的方式过于难受，折磨心智（人这一生最不该做的就是折磨自己），没有抓清主次，同时和网络上的博文同质化严重。因此就决定，再读一次 Lua 的源码，这次读的是 Lua 5.3.6 是 Lua 5.3 系列的最后一个版本。

本系列，不会谈论 Lua 语法，也默认读者已经有 Lua使用经验，我们将绕过 Lua 的编译器（大部分都是词法语法分析），直接进入到 Lua解释器中，来学习我们写好的 Lua 源码是怎么跑起来的。为了理解的方便，代码会有大量删减，只抽取其核心。

## Lua 编译过程

虽然，我们在一开始就说好，不谈论 Lua 编译器，但是还是要先理解 Lua 的运行机制。这里简单提一下，你写好的 `xxx.lua` 文件 会经过 luac 工具将 Lua源代码编译成 二进制文件，Lua 作者在代码中称其为 Chunk，接着 Lua解释器会加载它并执行，所以 Lua执行起来，看起来是边执行边编译，但实际上是先编译成 Chunk，再加载 Chunk去执行。

## 加载 Chunk

假设我们现在有一段 lua代码，且已经过了 luac工具 编译出了 Chunk，那么 Lua解释器是怎么将其加载的呢？

我们可以大胆猜测，Lua会有个load函数，去load我们的 Chunk。

```c
LUA_API int lua_load (lua_State *L, lua_Reader reader, void *data,
                      const char *chunkname, const char *mode) {
  ....
  status = luaD_protectedparser(L, &z, chunkname, mode);
  if (status == LUA_OK) {  /* no errors? */
    LClosure *f = clLvalue(L->top - 1);  /* get newly created function */
		....
  }
  return status;
}
```

<!-- more -->

确实拥有这个函数，其本质会调用 `luaD_protectedparser`，其内部又调用了 `f_parser` ，不用害怕 `luaD_pcall` 这个函数，其内部就是调用了传进去的函数指针，这里指 `f_parser` 。函数名p 指 Protect 安全的调用，其实就是有捕获异常的功能的调用函数，由于C语言没有异常机制，因此它内部用的 `setjmp` 来实现函数间跳转，模拟异常机制。

```c
int luaD_protectedparser (lua_State *L, ZIO *z, const char *name,
                                        const char *mode) {
	....
  status = luaD_pcall(L, f_parser, &p, savestack(L, L->top), L->errfunc);
  return status;
}
```

`f_parser` 会根据实际情况，选择从二进制或者文本中解析 Chunk，为了简单起见，我们只关注从二进制中解析的方法 即 `luaU_undump`。

```c
static void f_parser (lua_State *L, void *ud) {
  LClosure *cl;
  struct SParser *p = cast(struct SParser *, ud);
  int c = zgetc(p->z);  /* read first character */
  if (c == LUA_SIGNATURE[0]) {
    checkmode(L, p->mode, "binary");
    cl = luaU_undump(L, p->z, p->name);
  }
  else {
    checkmode(L, p->mode, "text");
    cl = luaY_parser(L, p->z, &p->buff, &p->dyd, p->name, c);
  }
  luaF_initupvals(L, cl);
}
```

`luaU_undump` 会先检查 Header，然后创建一个 closure，可以理解为是一个函数，里面会有其各种试行信息，然后将其放在虚拟机的栈顶，最后返回回去。

```c
LClosure *luaU_undump(lua_State *L, ZIO *Z, const char *name) {
  LoadState S;
  LClosure *cl;
	....
  checkHeader(&S);
  cl = luaF_newLclosure(L, LoadByte(&S));
  setclLvalue(L, L->top, cl);
  luaD_inctop(L);
  cl->p = luaF_newproto(L);
  LoadFunction(&S, cl->p, NULL);
  ....
  return cl;
}
```

`checkHeader` 主要是检查 Chunk 的Lua版本，大端小端字节序，浮点数是怎么存储的等信息，可以看出 Lua的设计理念是，不同版本我就直接不让你运行，非常霸道。

```c
static void checkHeader (LoadState *S) {
  checkliteral(S, LUA_SIGNATURE + 1, "not a");  /* 1st char already checked */
  if (LoadByte(S) != LUAC_VERSION)
    error(S, "version mismatch in");
  if (LoadByte(S) != LUAC_FORMAT)
    error(S, "format mismatch in");
  checkliteral(S, LUAC_DATA, "corrupted");
  checksize(S, int);
  checksize(S, size_t);
  checksize(S, Instruction);
  checksize(S, lua_Integer);
  checksize(S, lua_Number);
  if (LoadInteger(S) != LUAC_INT)
    error(S, "endianness mismatch in");
  if (LoadNumber(S) != LUAC_NUM)
    error(S, "float format mismatch in");
}
```

现在回过头来看 `closure` 的结构定义。我们可以确定 cl 中的 Proto 才是函数原型，同时 cl 分为 Lua函数和 C函数。 `upvals` 根据字面意思可以翻译为 上值，属于 Lua 特有，因为 Lua 支持嵌套函数，函数是一等公民，采用了 静态作用域，将外界的变量绑定进来，可以暂时理解为将全局变量绑定进来。

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
} Proto;

typedef struct LClosure {
  unsigned char nupvalues;
  struct Proto *p;
  UpVal *upvals[1];  /* list of upvalues */
} LClosure;

typedef struct CClosure {
  ClosureHeader;
  lua_CFunction f;
  TValue upvalue[1];  /* list of upvalues */
} CClosure;

typedef union Closure {
  CClosure c;
  LClosure l;
} Closure;

```

`LoadFunction` 将填充 `Proto` ，要注意 Proto 是嵌套的，如果有多个函数的情况下。

```c
static void LoadFunction (LoadState *S, Proto *f, TString *psource) {
  f->source = LoadString(S, f);
  if (f->source == NULL)  /* no source in dump? */
    f->source = psource;  /* reuse parent's source */
  f->linedefined = LoadInt(S);
  f->lastlinedefined = LoadInt(S);
  f->numparams = LoadByte(S);
  f->is_vararg = LoadByte(S);
  f->maxstacksize = LoadByte(S);
  LoadCode(S, f);
  LoadConstants(S, f);
  LoadUpvalues(S, f);
  LoadProtos(S, f);
  LoadDebug(S, f);
}
```

加载完了 `Chunk` ，目光回到 `f_parser` 其最后会调用 `luaF_initupvals` 初始化 upVals 就是置nil。

```c
void luaF_initupvals (lua_State *L, LClosure *cl) {
  int i;
  for (i = 0; i < cl->nupvalues; i++) {
    UpVal *uv = luaM_new(L, UpVal);
    uv->refcount = 1;
    uv->v = &uv->u.value;  /* make it closed */
    setnilvalue(uv->v);
    cl->upvals[i] = uv;
  }
```

Load 完之后，我们也能猜测到应当还有个 Call 方法，才能将加载进来的内容 跑起来。将 func读入到 CallInfo（可以理解为Lua解释器中的执行栈），会设置一下是不是可变参，有几个返回值等行为，最后调用 `luaV_execute` 去执行指令。

```c
int luaD_precall (lua_State *L, StkId func, int nresults) {
  CallInfo *ci;
  switch (ttype(func)) {
		....
    case LUA_TLCL: {  /* Lua function: prepare its call */
      StkId base;
      Proto *p = clLvalue(func)->p;
      int n = cast_int(L->top - func) - 1;  /* number of real arguments */
      int fsize = p->maxstacksize;  /* frame size */
      checkstackp(L, fsize, func);
      if (p->is_vararg)
        base = adjust_varargs(L, p, n);
      else {  /* non vararg function */
        for (; n < p->numparams; n++)
          setnilvalue(L->top++);  /* complete missing arguments */
        base = func + 1;
      }
      ci = next_ci(L);  /* now 'enter' new function */
      ci->nresults = nresults;
      ci->func = func;
      ci->u.l.base = base;
      L->top = ci->top = base + fsize;
      ci->u.l.savedpc = p->code;  /* starting point */
      ci->callstatus = CIST_LUA;
      if (L->hookmask & LUA_MASKCALL)
        callhook(L, ci);
      return 0;
    }
  }
}
void luaD_call (lua_State *L, StkId func, int nResults) {
	....
  if (!luaD_precall(L, func, nResults))  /* is a Lua function? */
    luaV_execute(L);  /* call it */
	....
}
```

`luaV_execute` 会将指令读入，然后去执行，Lua 的指令长度为32位，其中6位为指令，剩余位数为操作数。

```c
void luaV_execute (lua_State *L) {
  CallInfo *ci = L->ci;
  LClosure *cl;
  TValue *k;
  StkId base;
  ci->callstatus |= CIST_FRESH;  /* fresh invocation of 'luaV_execute" */
 newframe:  /* reentry point when frame changes (call/return) */
  lua_assert(ci == L->ci);
  cl = clLvalue(ci->func);  /* local reference to function's closure */
  k = cl->p->k;  /* local reference to function's constant table */
  base = ci->u.l.base;  /* local copy of function's base */
  /* main loop of interpreter */
  for (;;) {
    Instruction i;
    StkId ra;
    vmfetch();
    vmdispatch (GET_OPCODE(i)) {
			...
      vmcase(OP_LOADNIL) {
        int b = GETARG_B(i);
        do {
          setnilvalue(ra++);
        } while (b--);
        vmbreak;
      }
....
```

`luaD_precall` 会将要执行的函数或称为闭包存放到 `CallInfo`，接着 `luaV_execute` 会调用 `vmfetch` 获取指令，savedpc 就是我们当前执行到的指令。

```c
#define vmfetch()	{ \
  i = *(ci->u.l.savedpc++); \
	.... \
  ra = RA(i); /* WARNING: any stack reallocation invalidates 'ra' */ \
}
```

在这里，有必要看看 `CallInfo` 的结构，因为执行的函数有可能是C函数和Lua函数，故源码用 union将其包起来，我们目前只在意 Lua 的部分，可以看到 savedpc 存的就是每一条指令，它的实际类型就是 `uint32` ，采用了定长指令，前六位为指令。

```c
typedef struct CallInfo {
  StkId func;  /* function index in the stack */
  StkId	top;  /* top for this function */
  struct CallInfo *previous, *next;  /* dynamic call link */
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
  short nresults;  /* expected number of results from this function */
  unsigned short callstatus;
} CallInfo;
```

就这样，Lua解释器从加载 Chunk 到执行 Chunk 的流程走完了。

但仅如此还不够，我们可以看到以上大部分函数，都以 `lua_state` 作为参数，因此我们还需要先实例化 `lua_state` ，不过在此之前，我们要先简单认识一下 `lua_state` 的结构定义。

## lua_State

去除掉大量的无关信息，一个 Lua 解释器，仅需要以下几项即可运作。分别是栈的信息（如果你有Lua经验，想必早已知道Lua是通过栈模拟寄存器），调用栈信息即 `CallInfo`。

```c
struct lua_State {
	....
  unsigned short nci;  /* number of items in 'ci' list */
  StkId top;  /* first free slot in the stack */
	....
  CallInfo *ci;  /* call info for current function */
  StkId stack_last;  /* last free slot in the stack */
  StkId stack;  /* stack base */
	....
};
```

### lua_newstate

简单地初始化 lua_State，在这里我将无关的内容给删除了，可以看到初始化后会调用 `f_luaopen` 函数去打开Lua基础库。

```c
LUA_API lua_State *lua_newstate (lua_Alloc f, void *ud) {
  int i;
  lua_State *L;
  LG *l = cast(LG *, (*f)(ud, NULL, LUA_TTHREAD, sizeof(LG)));
  if (l == NULL) return NULL;
  L = &l->l.l;
	....
  for (i=0; i < LUA_NUMTAGS; i++) g->mt[i] = NULL;
  if (luaD_rawrunprotected(L, f_luaopen, NULL) != LUA_OK) {
    /* memory allocation error: free partial state */
    close_state(L);
    L = NULL;
  }
  return L;
}
```

`stack_init` 初始化栈和初始化调用栈即 `CallInfo`， `init_registry` 初始化注册表，往后的全局对象，还有一些C函数都会注册到这里面。

```c
static void f_luaopen (lua_State *L, void *ud) {
  stack_init(L, L);  /* init stack */
  init_registry(L, g);
  luaS_init(L); // 初始化用于复用的字符串，当字符串相等的时候能复用就复用
	....
  luaX_init(L); // 关键字 字符串提前注册并设置不能GC
	....
}
```

## 结语

经过以上的洗礼，可以看到 Lua 在加载 Chunk的时候，要先创建好Lua解释器，然后通过指定格式Load进内存，再调用 precall 预处理，最后将一条条的指令执行。

其实之前看Lua源码的时候感觉很复杂，特别难看懂，特别是C语言的通病各种宏，看一下后面的，过一阵又忘了宏里面写的是什么。这次则采用一种新的方式来阅读，即先想想如果是你来做这个功能，你会怎么做？想到的方法不会相差太多，这个时候顺着自己的思路来寻觅作者的思路，会简单的多。