---
title: Python3-源码剖析(三)-GC垃圾回收
categories: Python3
date: 2022-05-01 14:34:28
keywords: Python3, CPython, Garbage, Collect
tags: [Python3, CPython, Python虚拟机, GarbageCollect]
---
剖析一下 `CPython` 的自动垃圾回收机制，并尝试提出改进的思路。

## 引用计数

相信有过计算机基础的人，哪怕对垃圾回收不那么熟悉，也肯定知道引用计数这个玩意。引用计数诞生于上个世纪，其主要思想是通过给每个对象增加计数，当计数为0时，则肯定没人使用该对象，可以放心将其删除。

虽然这个方法看起来有点糙，但在实际项目中，它的优点在于可以更实时的释放内存，释放内存的时机更精确，这也是为什么有的项目会尝试给 `Lua` 增添一个引用计数的垃圾回收，避免内存上涨过快。

凡事都有利弊，它的缺点也很明显，无法处理循环引用。

以下用 `Python` 举一个非常普遍的例子。

```python
class A:  
    pass  
  
class B:  
    pass

a = A()
b = B()
a.b = b
b.a = a
del a
del b
```

在上面中，我们手动删除了 `a` 和 `b` ，理应进行释放，但由于 `a` 和 `b` 互相构成了循环引用，导致其引用计数总是不为0，进而造成内存泄漏，而 `CPython` 对其解决方法也极其简单，就是将所有可能造成循环引用的对象，构成一个双向链表进行扫描，从 `root object` 出发进行扫描 - 清除，无法到达的对象就是可释放的对象，普通的对象直接采用引用计数去释放，简单快捷。

怎么去验证以上结论呢？我们可以用反证法，当 `del a` 和 `del b` 后，再调用 `gc.collect()` 查看其是否能被回收到，如果能回收到，说明在此时引用计数已经失效。

```python
# 设置 debug 标签，使得垃圾回收后的对象 存放至 gc.garbage 列表中
gc.set_debug(gc.DEBUG_SAVEALL)

# 回收第0代垃圾对象
gc.collect(0)

# 打印出回收的垃圾对象
print(gc.garbage)
```

可以看出引用计数确实失效了，因为通过 `扫描-清除` 回收能回收到这两个对象。

<!-- more -->

```python
[<__main__.A object at 0x10adefc10>, <__main__.B object at 0x10adeff70>, {'b': <__main__.B object at 0x10adeff70>}, {'a': <__main__.A object at 0x10adefc10>}]
```

接下来，我们来到 `CPython` 源码中查看如何用引用计数管理一个对象。我们将以整数为例，先看看整数对象的对象模型。

```c
// 对象的基类，拥有双向链表和引用计数
typedef struct _object {
    struct _object *_ob_next;
    struct _object *_ob_prev;
    Py_ssize_t ob_refcnt;
    struct _typeobject *ob_type;
} PyObject;

typedef struct {
    PyObject ob_base;
    Py_ssize_t ob_size;
} PyVarObject;

struct _longobject {
    PyVarObject ob_base;
    digit ob_digit[1];
};
```

可以看出每个对象都有一条双向链表，但是这里需要说明的是，此处的双向链表并非后面扫描 - 标记所使用的双向链表，此处的双向链表会将所有的对象都链接到 `refchain` 中，目前从代码中只能看出是拿来做调试用途的。

```c
void
_Py_AddToAllObjects(PyObject *op, int force)
{
    if (force || op->_ob_prev == NULL) {
        op->_ob_next = refchain._ob_next;
        op->_ob_prev = &refchain;
        refchain._ob_next->_ob_prev = op;
        refchain._ob_next = op;
    }
}

void
_Py_NewReference(PyObject *op)
{
    if (_Py_tracemalloc_config.tracing) {
        _PyTraceMalloc_NewReference(op);
    }
#ifdef Py_REF_DEBUG
    _Py_RefTotal++;
#endif
    Py_SET_REFCNT(op, 1);
#ifdef Py_TRACE_REFS
    _Py_AddToAllObjects(op, 1);
#endif
}

static inline PyObject*
_PyObject_INIT(PyObject *op, PyTypeObject *typeobj)
{
    Py_TYPE(op) = typeobj;
    if (PyType_GetFlags(typeobj) & Py_TPFLAGS_HEAPTYPE) {
        Py_INCREF(typeobj);
    }
    _Py_NewReference(op);
    return op;
}

PyLongObject *
_PyLong_New(Py_ssize_t size)
{
    PyLongObject *result;
    ...
    result = PyObject_MALLOC(offsetof(PyLongObject, ob_digit) +
                             size*sizeof(digit));
    ...
    return (PyLongObject*)PyObject_INIT_VAR(result, &PyLong_Type, size);
}
```

以上关于 `CPython` 中的引用计数部分，就讲解完了，整体非常简单。接下来就是看容器类对象(会造成循环引用的对象)如何进行垃圾回收了。

## 扫描-清除

垃圾回收领域一直有几大门派，最为突出的门派分别为 `扫描-清除` 和 `标记-整理` ，先讲什么是 `标记-整理`。

假设我们将语言的内存池分为两块，其中一块不用，另一块一直拿来创建对象，当垃圾回收开启时，我们将所有可达对象(即可用对象)进行标记，然后将标记的对象重新在另一块内存池中进行创建，最后直接将原本那块内存池进行释放，这就将垃圾整理完成。

`标记-整理` 这种垃圾回收办法依赖于一个假设，那就是垃圾对象比正常的对象要多得多，这样整理起来由于是整个内存池一起销毁的，所以会快得多。

`CPython` 选择的是 `扫描-清除`，我们就不在其他地方进行展开了，着重来介绍 `扫描-清除` 。

假设我们从 `root object` 出发，如果可以扫描到的对象，即成为可达对象，可达对象则代表正在被使用不可清理。最终我们将得到一个不可达对象的列表，将其清理即可。

而 `扫描-清除` 由于扫描和清除是一次性完成的，会导致 `Stop The World` 时间特别长，因此产生了所谓的分代垃圾回收，这也就是 `CPython` 目前所使用的垃圾回收。

## 分代垃圾回收

分代垃圾回收基于一个假设，大部分对象存活的时间比较短，少部分对象存活的时间比较长，那么就可以优先对新生代进行垃圾回收，而对老年代的垃圾回收次数放缓，这就解决了 `扫描-清除` 的时间过长的问题。

接下来我们就来简单看看 分代垃圾回收的实现。我们以一个容器对象作为例子，就拿 `list` 好了。

以下为 `list` 的对象模型，由于本篇主题为垃圾回收，所以不关注其他成员。

```c
typedef struct {
    PyVarObject ob_base;
    PyObject **ob_item;
    Py_ssize_t allocated;
} PyListObject;
```

结构也是非常简单，同样有引用计数与双向链表(在 `PyVarObject` 结构中)，那么就会有疑惑了，这里的双向链表用于链接所有对象到 `refchain` ，那么我们的分代垃圾回收的扫描链表去哪了？

```c
/* GC information is stored BEFORE the object structure. */
typedef struct {
    // Pointer to next object in the list.
    // 0 means the object is not tracked
    uintptr_t _gc_next;

    // Pointer to previous object in the list.
    // Lowest two bits are used for flags documented later.
    uintptr_t _gc_prev;
} PyGC_Head;

void
_PyObject_GC_Link(PyObject *op)
{
    PyGC_Head *g = AS_GC(op);
    PyThreadState *tstate = _PyThreadState_GET();
    GCState *gcstate = &tstate->interp->gc;
    g->_gc_next = 0;
    g->_gc_prev = 0;
    gcstate->generations[0].count++; /* number of allocated GC objects */
    if (gcstate->generations[0].count > gcstate->generations[0].threshold &&
        gcstate->enabled &&
        gcstate->generations[0].threshold &&
        !gcstate->collecting &&
        !_PyErr_Occurred(tstate))
    {
        gcstate->collecting = 1;
        gc_collect_generations(tstate);
        gcstate->collecting = 0;
    }
}

PyObject *
_PyType_AllocNoTrack(PyTypeObject *type, Py_ssize_t nitems)
{
    PyObject *obj;
    const size_t size = _PyObject_VAR_SIZE(type, nitems+1);

    // 计算真实内存大小
    const size_t presize = _PyType_PreHeaderSize(type);
    char *alloc = PyObject_Malloc(size + presize);
    if (alloc  == NULL) {
        return PyErr_NoMemory();
    }
    obj = (PyObject *)(alloc + presize);
    if (presize) {
        ((PyObject **)alloc)[0] = NULL;
        ((PyObject **)alloc)[1] = NULL;
        _PyObject_GC_Link(obj);
    }
    memset(obj, '\0', size);

    if (type->tp_itemsize == 0) {
        _PyObject_Init(obj, type);
    }
    else {
        _PyObject_InitVar((PyVarObject *)obj, type, nitems);
    }
    return obj;
}

// list的构造函数
PyObject *
PyType_GenericAlloc(PyTypeObject *type, Py_ssize_t nitems)
{
    PyObject *obj = _PyType_AllocNoTrack(type, nitems);
    if (obj == NULL) {
        return NULL;
    }

    if (_PyType_IS_GC(type)) {
        _PyObject_GC_TRACK(obj);
    }
    return obj;
}
```

可以看出，在创建这类需要扫描的对象时，会提前算好头部还需要加多少内存，在头部再加一个 `PyGC_Head` 作为分代回收的链表，然后调用 `_PyObject_GC_Link` 触发垃圾回收，可以看出当创建一个对象达到该代的阈值时，将会触发垃圾回收，最后才调用 `_PyObject_GC_TRACK` 将其链入 第0代 `GC链表` 中。

```c
// Lowest bit of _gc_next is used for flags only in GC.
// But it is always 0 for normal code.
#define _PyGCHead_NEXT(g)        ((PyGC_Head*)(g)->_gc_next)
#define _PyGCHead_SET_NEXT(g, p) _Py_RVALUE((g)->_gc_next = (uintptr_t)(p))

// Lowest two bits of _gc_prev is used for _PyGC_PREV_MASK_* flags.
#define _PyGCHead_PREV(g) ((PyGC_Head*)((g)->_gc_prev & _PyGC_PREV_MASK))
#define _PyGCHead_SET_PREV(g, p) do { \
    assert(((uintptr_t)p & ~_PyGC_PREV_MASK) == 0); \
    (g)->_gc_prev = ((g)->_gc_prev & ~_PyGC_PREV_MASK) \
        | ((uintptr_t)(p)); \
    } while (0)

static inline void _PyObject_GC_TRACK(
    PyObject *op)
{
    PyGC_Head *gc = _Py_AS_GC(op);

    PyInterpreterState *interp = _PyInterpreterState_GET();
    PyGC_Head *generation0 = interp->gc.generation0;
    PyGC_Head *last = (PyGC_Head*)(generation0->_gc_prev);
    _PyGCHead_SET_NEXT(last, gc);
    _PyGCHead_SET_PREV(gc, last);
    _PyGCHead_SET_NEXT(gc, generation0);
    generation0->_gc_prev = (uintptr_t)gc;
}
```

从宏中可以看出，`CPython` 用了地址的最后两位去做一些事情，之所以可以这么做是因为内部实现了个小的内存分配器，里面的地址按4字节对齐，这意味着后两位一定为0，这也是一个常用技巧了，没什么好说的。

现在让我们关注最重要的 垃圾回收过程。

```c
static Py_ssize_t
gc_collect_generations(PyThreadState *tstate)
{
    GCState *gcstate = &tstate->interp->gc;
    Py_ssize_t n = 0;
    for (int i = NUM_GENERATIONS-1; i >= 0; i--) {
        if (gcstate->generations[i].count > gcstate->generations[i].threshold) {
            if (i == NUM_GENERATIONS - 1
                && gcstate->long_lived_pending < gcstate->long_lived_total / 4)
                continue;
            n = gc_collect_with_callback(tstate, i);
            break;
        }
    }
    return n;
}
```

从最老一代开始进行收集，目前 `CPython` 默认有3代，分别为 0，1，2代。为了避免多次进行 `full gc` ，这里设置了个条件，当清理最老一代的时候，必须要 非最老一代存活的对象(long_lived_pending) / 当前最老一代存活的对象(long_lived_total) 超过 `25%` 才进行全量回收，其实这主要是因为 `扫描-清理` 过程是一次完成的，所以要尽量避免 `full gc` 。

接着就正式进入垃圾回收主函数。

```c
static Py_ssize_t
gc_collect_with_callback(PyThreadState *tstate, int generation)
{
    ...
    Py_ssize_t result, collected, uncollectable;
    result = gc_collect_main(tstate, generation, &collected, &uncollectable, 0);
    ...
    return result;
}
```

在阅读之前，还要补充一个知识点，分代垃圾回收里面的三代回收是有阈值的，其中只有第0代也就是最年轻的一代的阈值指的是对象个数，剩下两代都是执行年轻代的次数。默认值为 `(700, 10, 10)`  这意味着想触发第0代垃圾回收需要创建出700个对象，而想触发第1代垃圾回收，需要第0代垃圾回收执行过10次，想要触发第2代垃圾回收则需要第1代垃圾回收执行过10次(同时还要满足上面的一个条件，这里就不重复了)。

```c
static Py_ssize_t
gc_collect_main(PyThreadState *tstate, int generation,
                Py_ssize_t *n_collected, Py_ssize_t *n_uncollectable,
                int nofail)
{
    int i;
    Py_ssize_t m = 0; /* # objects collected */
    Py_ssize_t n = 0; /* # unreachable objects that couldn't be collected */
    PyGC_Head *young; /* the generation we are examining */
    PyGC_Head *old; /* next older generation */
    PyGC_Head unreachable; /* non-problematic unreachable trash */
    PyGC_Head finalizers;  /* objects with, & reachable from, __del__ */
    PyGC_Head *gc;
    _PyTime_t t1 = 0;   /* initialize to prevent a compiler warning */
    GCState *gcstate = &tstate->interp->gc;

    // 将更老的一代的 count + 1 从而让之后能执行到后续的垃圾回收
    if (generation+1 < NUM_GENERATIONS)
        gcstate->generations[generation+1].count += 1;
  
    // 当前代和比当前代更年轻的计数重置，因为我们会将[0, 当前代]全部处理完
    for (i = 0; i <= generation; i++)
        gcstate->generations[i].count = 0;

    // 将更年轻的代归到当前代的链表上
    for (i = 0; i < generation; i++) {
        gc_list_merge(GEN_HEAD(gcstate, i), GEN_HEAD(gcstate, generation));
    }

    // young = [0, 当前代]
    young = GEN_HEAD(gcstate, generation);
    if (generation < NUM_GENERATIONS-1)
        // 当当前为第1代则old为第2代，当当前为第0代则old为第1
        old = GEN_HEAD(gcstate, generation+1);
    else
        // 说明当前为第2代，则old也为第2代
        old = young;

    // 核心, 将young中的对象的引用计数拷贝一份放到 _gc_prev.
    // 因为如果真正去修改引用计数的话，会导致意外释放掉一些本不该释放的对象
    // 但是拷贝一份出来做运算就没有这问题，此函数值得之后细说
    deduce_unreachable(young, &unreachable);
    // 找到可以停止追踪的tuples，减少垃圾回收工作量，这里不懂没关系，后面会举例细说
    untrack_tuples(young);

    // 将可达对象进行升级(升级到更老一代)
    if (young != old) {
        if (generation == NUM_GENERATIONS - 2) {
            gcstate->long_lived_pending += gc_list_size(young);
        }
        gc_list_merge(young, old);
    }
    else {
        // 同理，找到可以停止追踪的dict，只在full gc启用，原因后面说
        untrack_dicts(young);
        gcstate->long_lived_pending = 0;
        gcstate->long_lived_total = gc_list_size(young);
    }

    // 处理带有析构函数的对象，__del__，类似于 Lua 的 __gc
    gc_list_init(&finalizers);
    move_legacy_finalizers(&unreachable, &finalizers);
    move_legacy_finalizer_reachable(&finalizers);

    /* Clear weakrefs and invoke callbacks as necessary. */
    m += handle_weakrefs(&unreachable, old);

    // 调用 tp_finalize 即 __del__
    finalize_garbage(tstate, &unreachable);

    // 处理复活的对象
    PyGC_Head final_unreachable;
    handle_resurrected_objects(&unreachable, &final_unreachable, old);

    // 打破容器的引用计数
    m += gc_list_size(&final_unreachable);
    delete_garbage(tstate, gcstate, &final_unreachable, old);

    // 将终结器对象的bug信息进行整理
    handle_legacy_finalizers(tstate, gcstate, &finalizers, old);

    // 最老一代还会清空缓存池
    if (generation == NUM_GENERATIONS-1) {
        clear_freelists(tstate->interp);
    }
    ...
}
```

整体来看，除了代码量略大，其他的还是很简单的，接下来我们将解决上面几个遗留问题。

1. 如何找到 `root object` ？
2. `untrack_tuples` 是个啥？
3. `untrack_dicts` 为什么只在 `full gc` 时调用？

先解释第二点，为了加快垃圾回收的迭代，当 `tuple` 容器没有内嵌容器时，会将其从垃圾回收跟踪中删除，只使用最基础的引用计数。证明这一点很简单。

```python
a = (1, 2)  
print(gc.is_tracked(a))  # True
gc.collect()
print(gc.is_tracked(a))  # False
```

可以看出，对 `tuple` 取消追踪，是个惰性过程。接下来我们引申到 `dict` 。

```python
a = {"a": 1}
print(gc.is_tracked(a))  # False
a["b"] = {}
print(gc.is_tracked(a))  # True
a.pop("b")
print(gc.is_tracked(a))  # True
```

可以得出，当 `dict` 没有复杂的对象时，则不会对其追踪，那么我们是否可以将同样的思路引用于 `list` 呢？

接下来我们回到问题1，如何找到 `root object` ？如果读者对 `Lua` 了解的话就知道，`Lua` 的对象都可以从 `registry` 这个全局表中追踪到，但在 `Python` 的世界中却是不可行的，之所以会产生这样的问题，主要还是因为 `Python` 扩展模块(extension modules) 工作方式导致用于无法确定根集，这就使得复杂度一下就上来了。

`CPython` 的解决方法也很简单，结合引用计数和扫描清除两种办法去解决。拷贝一份引用计数(如果在原本的引用计数上操作太危险了，不小心变成0，就触发了引用计数回收了)，然后在其基础上进行遍历，每次将引用计数 -1，这样就得到了相对引用计数，相对引用计数为0，则有可能是不可达对象，先猜想它是，后续再遍历可达对象，如果从可达对象可以找到相对引用计数为0的对象，那么它就是可达对象，需要将其恢复。

这块虽然有点绕，但仔细品味一下还是非常简单的。

接下来我们来讨论第三个问题，为什么 `untrack_dicts` 只在 第三代垃圾回收时触发？
这主要是因为 `dict` 插入一个对象时，会判断这个对象是不是容器，是容器就会将其追踪，但是每次都会在 `untrack_dicts` 去遍历检查是否可以取消追踪，这就很蠢了，有兴趣的可以阅读 [Issue #14775](https://hg.python.org/cpython/rev/47e6217d0e84)。

其实还有些内容想讲，随便来个话题，在 `Python 2` 时代，当两个对象循环引用又同时有 `__del__` 时，垃圾回收会不回收这两个对象这类问题，但我不想在这里继续展开了，太累了，有兴趣可以阅读 [PEP-442](https://peps.python.org/pep-0442/) 进行学习。

## 想法

### 渐进分代？

`CPython` 的GC是 `Stop The World` 的，哪怕它已经很尽力用分代的方式去减少GC的损耗。是否可以将其改进为渐进的方式？我目前的想法是在容器操作时，进行 `Barrier` 操作，维护一个中间态，使得前面的扫描过程是可渐进的，最后处理垃圾的时候再停下来一次性处理完，减少停止的时间。但这个思路貌似不行，原因是根集是不确定的。

### 减少跟踪对象？

是否可以对其它常用容器也做 `untrack` 操作，当容器没有嵌套容器时，取消 `track` 操作，减少GC遍历损耗？这个思路需要小心避免犯上面 `untrack_dicts` 的错误。

甚至我们扩展 `gcmodule` 的接口，使得对一些常驻内存的对象进行标记，使其不要被跟踪？

### 尽可能少用 __del__

这点就不说啥了，`Lua` 里也最好别用 `__gc` 。

最后的最后，感谢 `CPython` 这份非常漂亮的代码设计，让我在这个五一假期，受益良多，下一步可能会回到 `Lua 5.2` 中，阅读它 "失败" 的分代GC作品，我认为学习失败的经验比成功的经验要重要得多。
