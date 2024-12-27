---
title: Lua 5.3 设计实现(五) Coroutine
categories: Lua
date: 2020-12-9 12:20:20
keywords: Lua, Lua解释器, Lua5.3 Lua虚拟机, 协程, Coroutine
tags: [Lua, Lua虚拟机]
---

Lua的协程和 Golang的协程不同，它是在同一个主线程上跑的协程，个人感觉用途不是很大，毕竟没有发挥多核的优势，不过还是有不少人认为这是 Lua的一个亮点，可以用来实现异步代码改写为同步代码，减轻人脑负担，然而很多人用的时候，并不了解当 Lua协程调用到C函数而C函数又调用到Lua函数后又执行 `yield` 的解决方案。本篇主要是来探讨Lua协程的设计。


## Lua协程的设计思路

试想一下，如果你来设计一个在同一个主线程上跑，且没有调度的协程，你会怎么做？

可能你会说这还不简单，我们都已经知道了 `CallInfo` 这样的结构，只需要创建一个新的Lua栈，将新的 函数设置进其 `CallInfo` ，当执行到 `resume` 时，则将 Lua栈 推入，去执行新的指令不就行了？

如果Lua只在自己的世界里面玩，从来不调用 C函数，那就还好。但问题是Lua会与其宿主语言也就是C语言进行打交道，会调用C的函数，如果这个C函数又调用了Lua Function，而其又调用了 `yield`，等到它又被 `resume` 的时候，它就没办法继续执行那尚未执行完成的C函数。

大致执行流程如下

```c
// 因为 lua 的 resume，其实是在C中导出的
(1)Lua:resume->[C:resume]
// C函数又调用了 lua的函数 因此会执行到 lua_call
->Lua:Function->[C:Function]->[C:lua_call]
// lua的函数被执行到后，又去执行 yield
->(Lua:Function)->Lua:yield

// 某一刻协程又被启动，此时回不到 C:lua_call
```

一种可行的思路是，将Lua的协程与每一个系统线程绑定，消耗高(不过我觉得这样才能发挥出多线程的优势嘛)。

Lua采用的方案则是，通过保存C函数和其状态，并标记状态，当 `resume`时根据已有信息，回到原来未执行完C函数的位置。

以下的 `lua_pcallk` 为使用例子，倒数第二个参数为上下文，倒数第一个参数则是该C函数如果被中断后，应该继续执行的事情。

```c
static int luaB_pcall (lua_State *L) {
  int status;
  luaL_checkany(L, 1);
  lua_pushboolean(L, 1);  /* first result if no errors */
  lua_insert(L, 1);  /* put it in place */
  status = lua_pcallk(L, lua_gettop(L) - 2, LUA_MULTRET, 0, 0, finishpcall);
  return finishpcall(L, status, 0);
}
```

<!-- more -->

## Coroutine

### create

先来看创建操作，调用 `lua_newthread` 创建一个新协程，这里面的协程的状态信息还是 `lua_State` ，各个协程之间的公共数据则在 `global_State` 。

`lua_xmove` 则是将两个 `lua_State` 的数据转移。

```c
LUA_API void 
lua_xmove (lua_State *from, lua_State *to, int n) {
  int i;
	....
  from->top -= n;
  for (i = 0; i < n; i++) {
    setobj2s(to, to->top, from->top + i);
    to->top++;  /* stack already checked by previous 'api_check' */
  }
  lua_unlock(to);
}

static int luaB_cocreate (lua_State *L) {
  lua_State *NL;
  luaL_checktype(L, 1, LUA_TFUNCTION);
  NL = lua_newthread(L);
  lua_pushvalue(L, 1);  /* move function to top */
  lua_xmove(L, NL, 1);  /* move function from L to NL */
  return 1;
}
```

### resume

创建好协程，还需要手动调用 `resume` 才能执行，主要依托于 `auxresume`，将参数拷贝到协程中，调用 `lua_resume` 。

```c
static int auxresume (lua_State *L, lua_State *co, int narg) {
  int status;
  if (!lua_checkstack(co, narg)) {
    lua_pushliteral(L, "too many arguments to resume");
    return -1;  /* error flag */
  }
  if (lua_status(co) == LUA_OK && lua_gettop(co) == 0) {
    lua_pushliteral(L, "cannot resume dead coroutine");
    return -1;  /* error flag */
  }

  lua_xmove(L, co, narg);
  status = lua_resume(co, L, narg);
  if (status == LUA_OK || status == LUA_YIELD) {
    int nres = lua_gettop(co);
    if (!lua_checkstack(L, nres + 1)) {
      lua_pop(co, nres);  /* remove results anyway */
      lua_pushliteral(L, "too many results to resume");
      return -1;  /* error flag */
    }
    lua_xmove(co, L, nres);  /* move yielded values */
    return nres;
  }
  else {
    lua_xmove(co, L, 1);  /* move error message */
    return -1;  /* error flag */
  }
}

static int luaB_coresume (lua_State *L) {
  lua_State *co = getco(L);
  int r;
  r = auxresume(L, co, lua_gettop(L) - 1);
  if (r < 0) {
    lua_pushboolean(L, 0);
    lua_insert(L, -2);
    return 2;  /* return false + error message */
  }
  else {
    lua_pushboolean(L, 1);
    lua_insert(L, -(r + 1));
    return r + 1;  /* return true + 'resume' returns */
  }
}
```

lua_resume 会检查各种条件，包括协程状态，调用层数。

接下来会将 `nny` 设置为 0，这个 nny 指的是 `number of non-yieldable" calls` ，它是用来控制是否允许 `yield` 的，最终会以保护的形式调用 `resume`。

```c
LUA_API int lua_resume (lua_State *L, lua_State *from, int nargs) {
  int status;
  unsigned short oldnny = L->nny;  /* save "number of non-yieldable" calls */
  lua_lock(L);
  if (L->status == LUA_OK) {  /* may be starting a coroutine */
    if (L->ci != &L->base_ci)  /* not in base level? */
      return resume_error(L, "cannot resume non-suspended coroutine", nargs);
  }
  else if (L->status != LUA_YIELD)
    return resume_error(L, "cannot resume dead coroutine", nargs);
  L->nCcalls = (from) ? from->nCcalls + 1 : 1;
  if (L->nCcalls >= LUAI_MAXCCALLS)
    return resume_error(L, "C stack overflow", nargs);
  luai_userstateresume(L, nargs);
  L->nny = 0;  /* allow yields */
  api_checknelems(L, (L->status == LUA_OK) ? nargs + 1 : nargs);
  status = luaD_rawrunprotected(L, resume, &nargs);
  if (status == -1)  /* error calling 'lua_resume'? */
    status = LUA_ERRRUN;
  else {  /* continue running after recoverable errors */
    while (errorstatus(status) && recover(L, status)) {
      /* unroll continuation */
      status = luaD_rawrunprotected(L, unroll, &status);
    }
    if (errorstatus(status)) {  /* unrecoverable error? */
      L->status = cast_byte(status);  /* mark thread as 'dead' */
      seterrorobj(L, status, L->top);  /* push error message */
      L->ci->top = L->top;
    }
    else lua_assert(status == L->status);  /* normal end or yield */
  }
  L->nny = oldnny;  /* restore 'nny' */
  L->nCcalls--;
  lua_assert(L->nCcalls == ((from) ? from->nCcalls : 0));
  lua_unlock(L);
  return status;
}
```

如果是协程刚开始的时候，那就像是执行一个函数那么简单。相反如果是从 `yield` 状态切换回来，

其实这必然是 C函数中过来的，因为 lua调用 `yield` 其实还是到了C函数这。

如果在 lua 则继续解析指令即可，这里的 lua 其实是 hook 函数，看起来是 lua 函数 其实还是 C函数，可以看到 之前的堆栈信息存在了 `CallInfo->extra`，所以 `resume` 回来之后，实际上不会有 Lua函数，但是我们要跳过 Lua的指令。

若是在C中 调用的 lua函数，而lua函数又调用了 `yield` ，则看看 我们之前保存的继续处理函数和上下文存不存在，再去调用即可（调用的是C函数剩余的部分）。

执行完之前遗留的工作以后，只是说恢复到了正确的工作，别忘了 lua 中可能还有要执行的任务，因此会调用 `unroll`。

```c
static void resume (lua_State *L, void *ud) {
  int n = *(cast(int*, ud));  /* number of arguments */
  StkId firstArg = L->top - n;  /* first argument */
  CallInfo *ci = L->ci;
  if (L->status == LUA_OK) {  /* starting a coroutine? */
    if (!luaD_precall(L, firstArg - 1, LUA_MULTRET))  /* Lua function? */
      luaV_execute(L);  /* call it */
  }
  else {  /* resuming from previous yield */
    lua_assert(L->status == LUA_YIELD);
    L->status = LUA_OK;  /* mark that it is running (again) */
    ci->func = restorestack(L, ci->extra);
    if (isLua(ci))  /* yielded inside a hook? */
      luaV_execute(L);  /* just continue running Lua code */
    else {  /* 'common' yield */
      if (ci->u.c.k != NULL) {  /* does it have a continuation function? */
        lua_unlock(L);
        n = (*ci->u.c.k)(L, LUA_YIELD, ci->u.c.ctx); /* call continuation */
        lua_lock(L);
        api_checknelems(L, n);
        firstArg = L->top - n;  /* yield results come from continuation */
      }
      luaD_poscall(L, ci, firstArg, n);  /* finish 'luaD_precall' */
    }
    unroll(L, NULL);  /* run continuation */
  }
}
```

`unroll` 较为简单，执行接下来的字节码，如果是停在了C函数，则会调用 `finishCcall` 去执行完剩余的C函数。

`adjustresults(L, ci->nresults);` 是因为此时一定停在了 `luaD_precall` 函数，而这后面就是这一句，因此可以写死，还有一句则是 `luaD_poscall`。

```c
static void finishCcall (lua_State *L, int status) {
  CallInfo *ci = L->ci;
  int n;
  /* must have a continuation and must be able to call it */
  lua_assert(ci->u.c.k != NULL && L->nny == 0);
  /* error status can only happen in a protected call */
  lua_assert((ci->callstatus & CIST_YPCALL) || status == LUA_YIELD);
  if (ci->callstatus & CIST_YPCALL) {  /* was inside a pcall? */
    ci->callstatus &= ~CIST_YPCALL;  /* continuation is also inside it */
    L->errfunc = ci->u.c.old_errfunc;  /* with the same error function */
  }
  /* finish 'lua_callk'/'lua_pcall'; CIST_YPCALL and 'errfunc' already
     handled */
  adjustresults(L, ci->nresults);
  lua_unlock(L);
  n = (*ci->u.c.k)(L, status, ci->u.c.ctx);  /* call continuation function */
  lua_lock(L);
  api_checknelems(L, n);
  luaD_poscall(L, ci, L->top - n, n);  /* finish 'luaD_precall' */
}

static void unroll (lua_State *L, void *ud) {
  if (ud != NULL)  /* error status? */
    finishCcall(L, *(int *)ud);  /* finish 'lua_pcallk' callee */
  while (L->ci != &L->base_ci) {  /* something in the stack */
    if (!isLua(L->ci))  /* C function? */
      finishCcall(L, LUA_YIELD);  /* complete its execution */
    else {  /* Lua function */
      luaV_finishOp(L);  /* finish interrupted instruction */
      luaV_execute(L);  /* execute down to higher C 'boundary' */
    }
  }
}
```

`lua_resume` 以保护模式调用 `resume` 如果出现异常，则会调用 `recover` 去修复。可以看到 这里是去找 调用 `pcall` 的 `CallInfo` 。因为 pcall 确实会抛出异常，然后就会去找 pcall 在哪里，将其还未执行完的事情给完成（指的是 luaD_pcall 异常后应该做的事情）。

```c
static CallInfo *findpcall (lua_State *L) {
  CallInfo *ci;
  for (ci = L->ci; ci != NULL; ci = ci->previous) {  /* search for a pcall */
    if (ci->callstatus & CIST_YPCALL)
      return ci;
  }
  return NULL;  /* no pending pcall */
}

static int recover (lua_State *L, int status) {
  StkId oldtop;
  CallInfo *ci = findpcall(L);
  if (ci == NULL) return 0;  /* no recovery point */
  /* "finish" luaD_pcall */
  oldtop = restorestack(L, ci->extra);
  luaF_close(L, oldtop);
  seterrorobj(L, status, oldtop);
  L->ci = ci;
  L->allowhook = getoah(ci->callstatus);  /* restore original 'allowhook' */
  L->nny = 0;  /* should be zero to be yieldable */
  luaD_shrinkstack(L);
  L->errfunc = ci->u.c.old_errfunc;
  return 1;  /* continue running the coroutine */
}
```

### yield

交出CPU资源，给其他协程机会，有了前面的基础，比较好理解，保存了当下次 `resume` 的时候，应该继续执行的C函数和上下文环境。

```c
LUA_API int lua_yieldk (lua_State *L, int nresults, lua_KContext ctx,
                        lua_KFunction k) {
  CallInfo *ci = L->ci;
  luai_userstateyield(L, nresults);
  lua_lock(L);
  api_checknelems(L, nresults);
  if (L->nny > 0) {
    if (L != G(L)->mainthread)
      luaG_runerror(L, "attempt to yield across a C-call boundary");
    else
      luaG_runerror(L, "attempt to yield from outside a coroutine");
  }
  L->status = LUA_YIELD;
  ci->extra = savestack(L, ci->func);  /* save current 'func' */
  if (isLua(ci)) {  /* inside a hook? */
    api_check(L, k == NULL, "hooks cannot continue after yielding");
  }
  else {
    if ((ci->u.c.k = k) != NULL)  /* is there a continuation? */
      ci->u.c.ctx = ctx;  /* save context */
    ci->func = L->top - nresults - 1;  /* protect stack below results */
    luaD_throw(L, LUA_YIELD);
  }
  lua_assert(ci->callstatus & CIST_HOOKED);  /* must be inside a hook */
  lua_unlock(L);
  return 0;  /* return to 'luaD_hook' */
}
```
