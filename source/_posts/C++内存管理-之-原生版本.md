---
title: C++ 内存管理 之 原生版本
categories: C++
date: 2019-11-4 09:02:20
keywords: C++, 内存管理
tags: [C++, 内存管理]
---
## 为什么要叫原生版本?

因为我觉得这一块是 C++ 自带的表达式 表达式里面 去调用 C语言的 CRT 库中的 `malloc` 和 `free` 但这篇 只讲自带的表达式 而不去深究 CRT 中的内存分配函数 所以只叫原生版本

## 常见的内存分配

| 分配 | 释放 | 类属 | 可否重载 |
| --- | ---- | --- | --- |
| malloc() | free() | C 函数 | 否 |
| new | delete | C++ 表达式 | 否 |
| ::operator new()| ::operator delete() | C++ 函数 | 可 |
| allocator<T>::allocate() | allocator<T>::deallocate() | C++ 标准库 | 自由设计搭配的容器 |

### 使用示例

其中 `::operator new() 和 ::operator delete()` 调用了 `malloc() 和 free()`

```c++
    void *p1 = malloc(512);
    free(p1);
    
    complex<int> *p2 = new complex<int>;
    delete p2;
    
    void *p3 = ::operator new(512);
    ::operator delete(p3);

#ifdef _MSC_VER
    // 属于 non-static 要先实例化object再调用
    int *p4 = allocator<int>().allocate(3, (int*)0);
    allocator<int>().deallocate(p4, 3);
#endif

#ifdef __GUNC__
    // 早期 GNU-C++ 2.9 版本
    // void *p4 = alloc::allocate(512);
    // alloc::deallocate(p4, 512);
    // alloc 换名字了
    void *p5 = __gnu_cxx::__pool_alloc<int>().allocate(9);
    __gnu_cxx::__pool_alloc<int>().deallocate((int*)p5, 9);
    // 4.9 版本之后
    void *p4 = allocator<int>().allocate(7);
    allocator<int>().deallocate((int*)p4, 7);

#endif
```

<!-- more -->

## new 表达式

`Object *p = new Object(1);`

编译器 在内部将其转化为

```c++
Object *p;
try {
    // operator new 可以被重载 如果没重载 调用全局版本

    void *mem = operator new(sizeof(Object)); // 1. 分配内存
    p = static_cast<Object*>(mem); // 2. 转换类型
    // 实际上只有编译器才能这样调用 构造函数
    // 然鹅在 VC 6.0 下可以这样调用
    // p->Object::Object(1);
    // 可以通过 placement new 直接调用 构造函数
    new (p) Object(1); // 3. 调用构造函数
}
catch () {
    // 分配内存失败 则不执行 构造函数
}
```

### operator new
前面说过 里面调用的是 `malloc()`

```c++
// 来自于 vc98/crt/src/newop2.cpp
// const std::nothrow_t & 不抛异常
// C++ 11 用 noexcept 代表不会抛出异常 如果抛出 则会调用 std::terminate() 终止程序 防止异常传播
void *operator new(size_t size, const std::nothrow_t &) _THROW0() {
    void *p;
    // 分配内存成功 就直接返回 如果失败 进入循环
    // 会调用 _callnewh => newhandler 是一个由你设定的函数 去找找有什么办法可以释放掉一些内存 使得有机会成功分配内存
    while ((p = malloc(size)) == 0) {
        _TRY_BEGIN
            if (_callnewh(size) == 0) break;
        _CATCH(std::bad_alloc) return 0;
        _CATCH_END
    }
    return (p);
}
```

## delete 表达式

```c++
Object *p = new Object(1);
delete p;
```

编译器 将 `delete` 转化为

```c++
p->~Object(); // 先调用析构函数
operator delete(p); // 再释放内存
```

### operator delete

会调用 `free()` 来释放内存

```c++
// 来自于 vc98/crt/src/delop.cpp
void __cdecl operator delete(void *p) _THROW0() {
    free(p);
}
```

## array new, array delete

```c++
// 调用三次构造函数 按顺序构造
Object *p = new Object[3];
// 调用三次析构函数 逆序析构
delete[] p;
```

如果 没配套使用的话 不一定会发生内存泄漏

* 对 class without ptr member 可能没影响
* 对 class with ptr member 通常有影响

先看第一种情况 

| cookie |
| -----  |
|  Object 1 |
|  Object 2 |
|  Object 3 |

`cookie` 是调用 `malloc()` 的时候 一起带来的 记录了这块内存的大小 相当于是额外的开销
此时 这个 class 没有 ptr member 那么 delete 的时候 只会调用 一次析构函数 但是没关系 这里面没有指针成员 因此 析构完了以后 `free()` 会看 `cookie` 知道了整块内存的大小 直接将其 释放 没有发生内存泄漏

第二种情况

假设这个 class 有 ptr member 那么 `delete` 的时候 只调用了 一次析构函数 那另外两个 class 里面 开辟的内存 因为没有调用到析构函数 没能被成功回收 因此发生了内存泄漏

因此发生内存泄漏不是 数组本身 而是 class 中 有可能开了内存

## placement new
将 object 构建在 已经分配好的内存中

```c++
#include <new>
char *buf = new char[sizeof(Object) * 3];
Object *p = new (buf) Object(1);

delete []buf;
```

会被编译器转换为

```c++
Object *p;
try {
    // 多了第二参数
    void *mem = operator new(sizeof(Object), buf);
    p = static_cast<Object*>(mem);
    p->Object::Object(1);
}
catch () {
    // 分配内存失败 则不执行 构造函数
}
```

此时 调用的 operator new 为

```c++
void *operator new(size_t, void *loc) {
    return loc;
}
```

相当于 不分配内存 直接把已经有的内存指针 返回回去 然后在其上面调用构造函数

## 重载 operator new, operator delete

重载 `operator new / operator delete` 可分为 全局重载 和 局部重载 其中全局重载影响太广了 一般是局部重载

要注意的点是 这两个函数 一定要是 `static` 不然你这个类都没有实例化 怎么能调到这两个函数 但是这两个函数就是拿来实例化的 产生了驳论 不过 C++ 编译器会默认给这两个函数 加上 `static` 所以你写不写 没啥所谓

```c++
class Foo {
public:
    void *opeartor new(size_t);
    // 第二参数 可有可无
    void operator delete(void*, size_t);
};
```

## 重载 placement new, placement delete

和 重载 `operator new` 类似

其实这真的能说是重载 `placement new` 吗? `placement new` 是在指定位置下进行构造函数

而这个 则很像 `operator new` 的重载了 唯一不同是参数个数不同和使用方式不同了

```c++
// 第一个参数 必须是 size_t 这是为了 自动传入大小 不然没法 new
void *operator new(size_t size, long extra, char init) {
    return malloc(size + extra);
}
void operator delete(void* p, long, char) {
    free(p);
}
// placement delete 重载 
// 就算和 placement new 没有一一对应也没关系
// 因为重载的 placement delete
// 只在 placement new 后 ctor 后失败(抛出异常) 时 才会被调用
// 如果不对应起来 就可以看做是 你放弃处理 ctor 发出的异常
// 注意 全局局部重载的效果都是一样的 delete 的时候不会去调用 placement delete
```

使用方式 `Foo *pf = new(300, 'c) Foo;`

### basic_string 使用 new(extra) 扩充申请内存量

basic_string 重载了 `placement new` 来多申请内存 因为 string 内部有引用计数 多申请一块内存来存放这些信息

`inline static void *operator new(size_t, size_t)`


## new handler

当 `operator new` 没能力分配你要的内存时 要么 抛出 `std::bad_alloc` 异常 要么则是直接返回 0 这也是为什么要检查分配出来的内存 是否可用

强行要求 编译器 不抛出异常 `new (nothrow) obj;`

new handler 的设定方式

```c++
typedef void (*new_handler)();
// 为什么要传回来一个new handler 回来
// 假如你之前 已经有一个 A handler 此时你传进去一个 B handler
// 通过返回回来 你就能把 A handler 保存起来
new_handler set_new_handler(new_handler p) throw();
```

new handler 只有两种选择

1. 想办法释放内存
2. 调用 abort() 或 exit()

