---
title: C++ 内存管理 之 Loki Allocator
categories: C++
date: 2019-11-8 15:00:20
keywords: C++, 内存管理, 内存分配原理, Loki, Allocator
tags: [C++, 内存管理, Loki]
---
Loki Allocator 有三个类 这玩意对比起 pool allocator 的优点就在于 它有把内存还给系统

但是它作为一个 内存分配器 却在里面使用了 vector 作为容器... 按道理来说 应该在其内部实现一个简易版的 vector 才不会那么奇怪 但也没所谓 只是 先用了一次标准库的分配器 后续使用容器的时候 就可以用 Loki 分配器了.

* Chunk
* FixedAllocator
* SmallObjAllocator

## Chunk 解剖

Chunk 是整个分配器的最底层 里面主要是三个 成员变量

```c++
// 指向内存块
unsigned char * pData_;
// 目前可用区块的第一块的索引
unsigned char firstAvailableBlock_;
// 有多少块可用
unsigned char blocksAvailable_;
```

Chunk 的几个关键函数 已进行 剪裁 和 修改

### Chunk 分配

分配流程很简单 就是 申请了内存以后 将每个小区块的第一个字节设置为索引 排好号

取的流程:
1. 从 当前可用区块的第一块索引中取 得当前可用区块
2. 当前可用区块会被返回
3. 被返回的可用区块中的索引 被设置到 当前可用区块索引去(这样下一次就会使用到它)
4. 可用区块数目 - 1

<!-- more -->

```
firstAvailableBlock_ = 4
blocksAvailable_     = 63
-------------------------
            4
-------------------------
            0
-------------------------
            3
-------------------------
            1
-------------------------
            2            <- 即将被分出去
-------------------------
            6
-------------------------
            7
-------------------------
           ...
-------------------------
           64
-------------------------
首先 因为当前可用区块索引 为 4 所以会找到 索引号为 2的区块
其次 找到了以后 这个区块的索引号 会被设置到 当前可用区块索引去 
这样下次就会用索引为 2 的区块
然后 区块可用数 - 1
-------------------------
firstAvailableBlock_ = 2
blocksAvailable_     = 62
-------------------------
            4
-------------------------
            0
-------------------------
            3            <-即将被分出去
-------------------------
            1
-------------------------
        已经被分配了
-------------------------
            6
-------------------------
            7
-------------------------
           ...
-------------------------
           64
-------------------------
```

### Chunk 回收

存的流程:
1. 首先 我们要明确 回收回来的区块 下次分配优先分配
2. 计算 回收回来的区块 应该放到哪里 (idx 为索引)
3. 那么 当前可用区块的索引号就应该设置为 idx 这样才能保证下次一定先用它
4. 那之前的索引号 就会被设置到 回收回来的区块的索引中去(分配完回收的区块后 就会分配之前本应该被分配的区块 后来因为回收了新的区块 而没被分配出去的区块 好绕口...)
5. 当前可用区块 + 1

### Chunk 函数实现

这块设计我个人觉得有一点不好的地方 就是 `Chunk::Init` 的时候 会传入 `blockSize` 但是 `Chunk::Allocate` 也会传入 `blockSize` 如果 这两块的 `blockSize` 不一致 则会出错

个人想法是 在 Init 的时候 将 `blockSize` 存入 data member 中去  在 Allocator 则不再传入

```c++
// 简单的说 就是开辟 blockSize * blocks 那么大内存
bool Chunk::Init( ::std::size_t blockSize, unsigned char blocks ) {
    const ::std::size_t allocSize = blockSize * blocks;
    pData_ = static_cast< unsigned char * >( ::operator new ( allocSize ) );
    Reset( blockSize, blocks );
    return true;
}
// 填补 data member 含义上面已经给出了
void Chunk::Reset(::std::size_t blockSize, unsigned char blocks) {
    firstAvailableBlock_ = 0;
    blocksAvailable_ = blocks;
    // 这里很骚啊 把每个区块的前一个字节 来记录索引...
    unsigned char i = 0;
    for ( unsigned char * p = pData_; i != blocks; p += blockSize ) {
        // 此处注意 是从 1开始排噢 因为是 ++i
        *p = ++i;
    }
}
// 释放内存块
void Chunk::Release() {
    ::operator delete ( pData_ );
}
void* Chunk::Allocate(::std::size_t blockSize) {
    if ( 0 == blocksAvailable_ ) {
        return nullptr;
    }
    // 1. 取得 目前可用的第一块
    unsigned char * pResult = pData_ + (firstAvailableBlock_ * blockSize);
    firstAvailableBlock_ = *pResult;
    // 2. 当前可用区块 - 1
    --blocksAvailable_;
    // 3. 将目前可用第一块返回回去
    return pResult;
}
void Chunk::Deallocate(void* p, ::std::size_t blockSize) {
    unsigned char* toRelease = static_cast<unsigned char*>(p);
    // 找这个指针在 区块中的索引
    unsigned char index = static_cast< unsigned char >(
        ( toRelease - pData_ ) / blockSize);

    // 回收回来以后 下次优先用它
    // 1. 回收的区块里的索引 设置为 当前可用区块的索引
    *toRelease = firstAvailableBlock_;
    // 2. 当前的第一块可用索引修改为 回收回来的区块应该放置的位置
    // 不理解的可以多看几次 很绕口!
    firstAvailableBlock_ = index;
    // 3. 可用数 + 1
    ++blocksAvailable_;
}
```

## FixedAllocator 解剖

FixedAllocator 里面存着 vector<Chunk>

```c++
// vector<Chunk>
typedef ::std::vector< Chunk > Chunks;
Chunks chunks_;

// 指向 vector<Chunk> 其中某两个 Chunk
// allocChunk_ 指向 上一次 分配出去过区块的 Chunk
Chunk * allocChunk_;
// deallocChunk_ 指向 上一次 回收过区块的 Chunk
// 个人觉得是局部性原理 就上次满足过了 这次很大概率也有可能满足
Chunk * deallocChunk_;

// 指向 唯一一个空Chunk 如果没有 则 为 nullptr
Chunk * emptyChunk_;
```

### FixedAllocator 分配

分配流程 简单的说就是 用 Chunk 去分配 那么 FixedAllocator 最主要的任务就是去找 能够分配内存的 Chunk

1. 先看看 allocChunk_(指向上次分配过区块的Chunk) 有没有效 有效则直接分配
2. 无效 则去找 emptyChunk_(指向一个空Chunk) 有效直接分配
3. 无效 则依次遍历 vector 找到 其中一个 能分配区块的 Chunk
4. 找不到 则直接 创建一个新的 Chunk 并将其 push_back 到 vector 中

### FixedAllocator 回收

回收流程 就是先去找 要回收的区块在哪个 Chunk 中 这里先从 上一次回收过区块的 Chunk 中查看 再从 上一次分配过区块的 Chunk 中查看 如果都没有 则用一种 特殊的搜索方法 就是从 上一次回收过区块的 Chunk 作为临界点 每次循环 一次向上找 一次向下找 直到找到以后 再去调用释放函数 如果发生了全回收 则 看看是否已经有一块全回收了(因为要2块全回收才释放掉其中一块 避免突然又要用到那块Chunk)

### FixedAllocator 函数实现

```c++
void * FixedAllocator::Allocate( void ) {
    // 上次分配出去过区块的chunk 如果为 空 或者是 该chunk可用区块为 0
    // 则 将 空 chunk 赋值给它
    // 如果没有空 chunk  
    if ( ( nullptr == allocChunk_ ) || 0 == allocChunk_->blocksAvailable_ ) {
        if ( nullptr != emptyChunk_ ) {
            allocChunk_ = emptyChunk_;
            emptyChunk_ = nullptr;
        } else {
            // 都没有 则从头找其 遍历一遍 vector
            Chunks::iterator i = chunks_.begin();
            for ( ; ; ++i ) {
                // 到达尾部 还是没找着 就创建一个 临时对象 init 这个chunk
                // 然后将其 push 到 容器中
                if ( chunks_.end() == i ) {
                    chunks_.push_back(Chunk());
                    Chunk &newChunk = chunks_.back();
                    newChunk.Init(blockSize_, numBlocks_);
                    // 记录好 下次就从这里面去取区块
                    allocChunk_ = &newChunk;
                    // vector push_back的时候有可能发生成长
                    // vector 成长是两倍申请内存然后将其拷贝过去
                    // 如果不重新取迭代器地址的话 有可能该迭代器失效
                    deallocChunk_ = &chunks_.front();
                    break;
                }
                // 如果 找到一个chunk 的可用区块大于 0 则 用它来分配
                if ( i->blocksAvailable_ > 0) {
                    // i是迭代器 *i 等于 取迭代器的值就是 Chunk &*i 等于 取迭代器的值的地址 pData_
                    allocChunk_ = &*i;
                    break;
                }
            }
        }
    // 如果 上次分配区块的chunk是emptyChunk 则将 emptyChunk 置为空
    // 因为 emptyChunk 已经被用了
    } else if ( allocChunk_ == emptyChunk_) {
        emptyChunk_ = nullptr;
    }
    // 上次分配过区块的chunk 如果还能分配 则直接分配返回回去
    void * place = allocChunk_->Allocate( blockSize_ );
    return place;
}
bool FixedAllocator::Deallocate( void * p ) {
    Chunk * foundChunk = nullptr;
    const ::std::size_t chunkLength = numBlocks_ * blockSize_;
    // p 先看看是否在之前回收过区块的 Chunk 里面
    // 再看看是否在 之前分配过区块的 Chunk 里面
    if ( p >= deallocChunk_->pData_ && p < deallocChunk_->pData_ + chunkLength ) {
        foundChunk = deallocChunk_;
    } else if ( p >= allocChunk_->pData_ && p < allocChunk_->pData_ + chunkLength ) {
        foundChunk = allocChunk_;
    } else {
        // 实在找不到 再去搜索 这个搜索方式很特别 是夹着搜索
        foundChunk = VicinityFind( p );
    }
    if ( nullptr == foundChunk ) {
        return false;
    }
    deallocChunk_ = foundChunk;
    // 此时再真正的去 deallocate
    DoDeallocate(p);

    return true;
}
Chunk * FixedAllocator::VicinityFind( void * p ) const {
    if ( chunks_.empty() ) {
        return nullptr;
    }

    const ::std::size_t chunkLength = numBlocks_ * blockSize_;

    // lo指向 上一次回收过区块的 Chunk
    // hi指向 上一次回收过区块的 Chunk 的下一个
    Chunk * lo = deallocChunk_;
    Chunk * hi = deallocChunk_ + 1;
    const Chunk * loBound = &chunks_.front();
    const Chunk * hiBound = &chunks_.back() + 1;

    if ( hi == hiBound ) {
        hi = nullptr;
    }

    for (;;) {
        // lo 往上走 hi 往下走 直到找到 或者 触碰到边界
        if (lo) {

            if ( p >= lo->pData_ && p < lo->pData_ + chunkLength ) {
                return lo;
            }
            if ( lo == loBound ) {
                lo = nullptr;
                if ( nullptr == hi ) {
                    break;
                }
            } else { 
                --lo;
            }
        }

        if (hi) {
            if ( p >= hi->pData_ && p < hi->pData_ + chunkLength ) {
                return hi;
            }
            if ( ++hi == hiBound ) {
                hi = nullptr;
                if ( nullptr == lo ) {
                    break;
                }
            }
        }
    }
    return nullptr;
}
// 总得来说就是 当有2个全回收的Chunk才释放掉一个
void FixedAllocator::DoDeallocate(void* p) {
    // 让 Chunk 回收掉这个区块
    deallocChunk_->Deallocate(p, blockSize_);
    // 如果这个Chunk 已经全回收了
    if ( deallocChunk_->blocksAvailable_ == numBlocks_ ) {
        // emptyChunk 已经指向了 一个空 Chunk 的话
        // lastChunk 指向 vector 最后一个
        // 为了效率 如果 lastChunk 就是 回收的Chunk 那就直接将 emptyChunk 赋值给 当前回收的Chunk
        // 这样才能直接 pop_back
        // 同理 如果最后一个 Chunk 不是 emptyChunk 那就直接交换 这样才能 通过简单地 pop_back 将其移除
        if ( nullptr != emptyChunk_ ) {
            Chunk * lastChunk = &chunks_.back();
            if ( lastChunk == deallocChunk_ ) {
                deallocChunk_ = emptyChunk_;
            } else if ( lastChunk != emptyChunk_ ) {
                ::std::swap( *emptyChunk_, *lastChunk );
            }
            // 最后释放掉内存
            lastChunk->Release();
            chunks_.pop_back();
            // 修正 allocChunk 指针 防止 被释放掉的是 allocChunk
            if ( ( allocChunk_ == lastChunk ) || allocChunk_->blocksAvailable_ == 0 ) {
                allocChunk_ = deallocChunk_;
            }
        }
        emptyChunk_ = deallocChunk_;
    }
}
```

## SmallObjAllocator 解剖

```c++
// vector<FixedAllocator> 其实是个数组 你可以理解成 vector
::Loki::Private::FixedAllocator * pool_;
// 支持分配的最大内存大小
const ::std::size_t maxSmallObjectSize_;
// 用于对齐操作
const std::size_t objectAlignSize_;
```

### SmallObjAllocator 分配实现

分配内存 简单的说 就是从 vector<FixedAllocator> 找合适的 FixedAllocator 然后再用底层的 FixedAllocator 去找 Chunk 分配内存

```c++
void * SmallObjAllocator::Allocate( ::std::size_t numBytes, bool doThrow ) {
    if ( numBytes > GetMaxObjectSize() ) {
        // 这里就是调用 ::operator new
        return DefaultAllocator( numBytes, doThrow );
    }

    if ( 0 == numBytes ) {
        numBytes = 1;
    }
    // 获取即将要分配的内存大小 属于哪个 pool 的下标
    const ::std::size_t index = GetOffset( numBytes, GetAlignment() ) - 1;
    const ::std::size_t allocCount = GetOffset( GetMaxObjectSize(), GetAlignment() );

    FixedAllocator & allocator = pool_[ index ];
    // 使用底层的 FixedAllocator 去分配
    void * place = allocator.Allocate();

    // 内存不足 则尝试去释放内存 释放其他 FixedAllocator 下的 空 Chunk 归还给 OS 然后再分配
    if ( ( nullptr == place ) && TrimExcessMemory() ) {
        place = allocator.Allocate();
    }

    if ( ( nullptr == place ) && doThrow ) {
        throw std::bad_alloc();
    }
    return place;
}

```

这里有一个有意思的点 `SmallObjAllocator::TrimExcessMemory()` 这个函数 会遍历所有的 FixedAllocator 然后 调用 `FixedAllocator::TrimChunkList()` 这里面有一段代码

```c++
bool FixedAllocator::TrimChunkList( void ) {
// ... 省略
    {
        // Use the "make-a-temp-and-swap" trick to remove excess capacity.
        // 这里的意思是说 我将 chunks_ 这个 vector 复制了一份 到 temp
        // 此时 temp的容量 == chunks_的大小 但不一定等于 容量 因为 vector 会扩大一部分作为后备内存
        // 然后进行一次交换 这样 chunks_ 假设 本来 capacity 是 140 但是 size 只有 100 进行了交换
        // chunks_ 现在的 capacity == size == 100 也就还了 40个 size 给了 OS
        Chunks temp( chunks_ );
        temp.swap( chunks_ );
    }
// ... 省略
    return true;
}
```

### SmallObjAllocator 回收实现

回收内存 找回收的内存对应的 FixedAllocator 然后调用下一层的 FixedAllocator 去进行真的是回收操作

```c++
void SmallObjAllocator::Deallocate( void * p ) {
    if ( nullptr == p ) {
        return;
    }

    FixedAllocator * pAllocator = nullptr;
    const ::std::size_t allocCount = GetOffset( GetMaxObjectSize(), GetAlignment() );
    Chunk * chunk = nullptr;

    for ( ::std::size_t ii = 0; ii < allocCount; ++ii ) {
        chunk = pool_[ ii ].HasBlock( p );
        if ( nullptr != chunk ) {
            pAllocator = &pool_[ ii ];
            break;
        }
    }
    if ( nullptr == pAllocator ) {
        // operator delete
        DefaultDeallocator( p );
        return;
    }

    const bool found = pAllocator->Deallocate( p, chunk );
}
```