---
title: C++ 内存管理 之 G4.9 扩展内存分配器
categories: C++
date: 2019-11-7 13:24:20
keywords: C++, 内存管理, GNU, GNU4.9, STL, 扩展内存分配器
tags: [C++, 内存管理, GNU, STL]
---
本文主要讲讲 GNU-C++ 4.9 下的扩展内存分配器

首先 GNU-C++ 4.9 有 7 个扩展的内存分配器

* new_allocator
* malloc_allocator
* pool_allocator
* __mt_alloc
* array_allocator
* debug_allocator
* bitmap_allocator

主要看看 `pool_allocator` `array_allocator` `bitmap_allocator`

以下源码都可在 `.../ext/*.h` 下找到 我将其进行了适当的 删减和修改

## __gnu_cxx::new_allocator

直接用 `::operator new` 和 `::operator delete` 实现出来的 好处是 可以被重载 没啥特色

```c++
template<typename _Tp>
class new_allocator {
public:
    pointer allocate(size_type __n, const void* = 0) {
        return static_cast<_Tp*>(::operator new(__n * sizeof(_Tp)));
    }
    void deallocate(pointer __p, size_type) {
        ::operator delete(__p);
    }
};
```

<!-- more -->

## __gnu_cxx::malloc_allocator

直接用 `std::malloc` 和 `std::free` 实现的 好处是 少调用 一次 `operator new` 和 `operator delete` 函数 节省一次入栈出栈开销 也没啥特色

```c++
template<typename _Tp>
class malloc_allocator {
public:
    pointer allocate(size_type __n, const void* = 0) {
        if (__n > this->max_size()) {
            std::__throw_bad_alloc();
        }

        pointer __ret = static_cast<_Tp*>(std::malloc(__n * sizeof(_Tp)));
        if (!__ret) {
            std::__throw_bad_alloc();
        }
        return __ret;
    }
    // __p is not permitted to be a null pointer.
    void deallocate(pointer __p, size_type) {
        std::free(static_cast<void*>(__p));
    }
};
```

## __gnu_cxx::pool_allocator

G2.9 容器默认配置器 在 我的 [C++ 内存管理 之 STL内存分配实现原理](https://www.yuerer.com/C++%E5%86%85%E5%AD%98%E7%AE%A1%E7%90%86-%E4%B9%8B-STL%E5%86%85%E5%AD%98%E5%88%86%E9%85%8D%E5%AE%9E%E7%8E%B0%E5%8E%9F%E7%90%86/) 这篇文章中 的 `GNU-C++ 2.9 std::alloc 原理` 已经分析过了

## __gnu_cxx::__mt_alloc

适用于多线程的内存分配

## __gnu_cxx::array_allocator

用于分配固定大小的内存块 使用 标准库 中的 `std::array` 实现 无需再去调用 `::operator new` 和 `::operator delete` 在进入 main 之前就可以用了 因为是用的 静态数组

```c++
// tr1 是因为 在 C++ 11之前 array不属于标准库的内容 属于一个小版本
template<typename _Tp, typename _Array = std::tr1::array<_Tp, 1> >
class array_allocator : public array_allocator_base<_Tp> {
public:
    typedef _Array  array_type;
private:
    // 数组指针
    array_type*     _M_array;
    // 数组已使用量
    size_type       _M_used;
public:
    // 简单的说就是 从外面将数组指针传进来 然后保存到 data member
    array_allocator(array_type* __array = 0) throw() 
    : _M_array(__array), _M_used(size_type()) { }

    pointer allocate(size_type __n, const void* = 0) {
        if (_M_array == 0 || _M_used + __n > _M_array->size()) {
            std::__throw_bad_alloc();
        }
        pointer __ret = _M_array->begin() + _M_used;
        _M_used += __n;
        return __ret;
    }
};
```

要注意的是 array 因为是静态的 所以不需要 释放 因此 你调用 `deallocate` 是没有任何操作的

不过 如果说 `deallocate` 能够回收掉已经分出去的数组中的某块的话 那可能利用率更高一些

```c++
// 静态数组
int my[65536];
array_allocator<int, array<int, 65536>> myAlloc(&my);
// 相当于分配了 数组中的 3块出去
int *p = myAlloc.allocate(3);
// 不会有任何操作
myAlloc.deallocate(p);

// 堆中的数组
typedef ARRAY std::array<int, 65536>;
ARRAY *pa = new ARRAY;
array_allocator<int, ARRAY> myAlloc(pa);
```

## __gnu_cxx::debug_allocator

不做分配归还动作 里面传入一个真正的 `allocator` 来分配归还内存 正如其名 不做事情 只是用来 debug 用的 每次申请 多申请一块 来记录 分配的内存 然后归还的时候 `assert` 来查看 分配的 `size` 是否正确

有点类似 `malloc` 中的 cookie

```c++
template<typename _Alloc>
class debug_allocator {
public:
    typedef typename _Traits::size_type      size_type;
    typedef typename _Traits::value_type     value_type;
private:
    size_type 		_M_extra;  
    _Alloc			_M_allocator;

    // 计算 用来记录我分配的内存块的大小的区块 占用了几个元素单位
    size_type _S_extra() {
        const size_t __obj_size = sizeof(value_type);
        return (sizeof(size_type) + __obj_size - 1) / __obj_size; 
    }
public:
    debug_allocator(const _Alloc& __a)
    : _M_allocator(__a), _M_extra(_S_extra()) { }

    pointer allocate(size_type __n) {
        // 多分配 extra 个 单位 用于记录 当前分配的区块大小
        pointer __res = _M_allocator.allocate(__n + _M_extra);      
        size_type* __ps = reinterpret_cast<size_type*>(__res);
        *__ps = __n;
        return __res + _M_extra;
    }
    void deallocate(pointer __p, size_type __n) {
        // 检查 回收回来的大小和 区块记录的大小是否一致
        using std::__throw_runtime_error;
        if (__p) {
            pointer __real_p = __p - _M_extra;
            if (*reinterpret_cast<size_type*>(__real_p) != __n) {
                __throw_runtime_error("debug_allocator::deallocate wrong size");
            }
            _M_allocator.deallocate(__real_p, __n + _M_extra);
        } else {
            __throw_runtime_error("debug_allocator::deallocate null pointer");
        }
    }
};
```

## __gnu_cxx::bitmap_allocator

使用 `bitmap` 来查找 被使用和未被使用的内存块

内部实现了一个 `mini vector` 和 普通的 `vector` 一样 会 `两倍` 成长

一整块称之为 Super Block 每一个 Block 相当于一个元素单位

```
  Super Blocks Size     记录已使用的块数    位图数组 记录某块是否被使用        64个Blocks 被 mini vector 所管理
[|  Super Blocks Size  |  Use Counts  |  bitmap[1]  |  bitmap[0]  |  [1][][][][][][]...[][][][][][][][][]  |]
                                                            1110 
                                               <-bitmap 记录的方向     Super Blocks 使用的方向->
```
假设 此时在32位系统下 一个内存块为 8 字节 则 Super Blocks Size 为 = 4 + (4 * 2) + 8 * (64 * 8) = 524字节

如果 全回收了 就 按照 Super Block 的大小 顺序放到 `free_list` 中 其实也是一个 vector 并且下次分配规模减半 (因为vector 每次分配都是两倍递增) 当 `free_list` 超过64个 Super Block 时 如果最后进来的 比最后面的还要大 就将其还给 OS (总而言之就是把最大的还给 OS)

如果 前面一个 Super Block 本来没区块 现在回收到了区块 此时又请求了区块的话 会从后面一个 Super Block 去分配 但是如果 后面一个 Super Block 不存在的话 则从 前面一个 Super Block 取

`free_list` 存在的意义就是 先把 Super Block 存起来 万一以后有用 就不用重新创建了

```c++
template<typename _Tp>
// free list 其实就是个 vector
class bitmap_allocator : private free_list {
public:
    pointer allocate(size_type __n) {
        if (__n > this->max_size()) {
	        std::__throw_bad_alloc();
        }
        // 只负责一个元素单位 超过的话 就不归它管了 实际上正常使用容器 都是一个个元素申请内存的
        // 除非你直接通过构造函数 给容器塞东西 就是一次申请 N个元素单位内存
        if (__builtin_expect(__n == 1, true)) {
            return this->_M_allocate_single_object();
        } else { 
            const size_type __b = __n * sizeof(value_type);
            return reinterpret_cast<pointer>(::operator new(__b));
	    }
    }
    void deallocate(pointer __p, size_type __n) throw() {
        if (__builtin_expect(__p != 0, true)) {
            if (__builtin_expect(__n == 1, true)) {
                this->_M_deallocate_single_object(__p);
            } else {
                ::operator delete(__p);
            }
        }
    }
};
```




