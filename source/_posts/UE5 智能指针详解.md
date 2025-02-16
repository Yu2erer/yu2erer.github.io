---
title: UE5 智能指针详解
categories: UE
date: 2025-02-16 12:50:20
keywords: UE5, 智能指针, TSharedPtr, TSharedRef, TWeakPtr, TUniquePtr
tags: [UE5, 智能指针, TSharedPtr, TSharedRef, TWeakPtr, TUniquePtr]
---

本文以 UE5.4 为基准，讲解智能指针的实现机制。阅读本文前需要对 C++11 的智能指针有基本了解。

## 简介

- **虚幻智能指针库** 为C++11智能指针的自定义实现，旨在减轻内存分配和追踪的负担。该实现包括行业标准 **共享指针**、**弱指针** 和 **唯一指针**。其还可添加 **共享引用**，此类引用的行为与不可为空的共享指针相同。

根据官方文档，与 C++ 标准库相比，虚幻引擎新增了共享引用的概念。智能指针的实现位于 `Core` 模块下。

## 线程安全

UE 的智能指针分为两种模式，表示是否为线程安全。这里所说的线程安全仅指其内部的引用计数器是否线程安全。

```cpp
enum class ESPMode : uint8
{
    NotThreadSafe = 0,
    ThreadSafe = 1
};
```

默认为 `ThreadSafe` 和 C++标准库保持一致。

```cpp
template< class ObjectType, ESPMode Mode = ESPMode::ThreadSafe > class TSharedRef;
template< class ObjectType, ESPMode Mode = ESPMode::ThreadSafe > class TSharedPtr;
template< class ObjectType, ESPMode Mode = ESPMode::ThreadSafe > class TWeakPtr;
template< class ObjectType, ESPMode Mode = ESPMode::ThreadSafe > class TSharedFromThis;
```

## 引用计数

引用控制器（以下简称控制块）中记录了共享引用次数和弱引用次数。

若为线程安全，内部计数器采用原子操作。

```cpp
template <ESPMode Mode>
class TReferenceControllerBase
{
    using RefCountType = std::conditional_t<Mode == ESPMode::ThreadSafe, std::atomic<int32>, int32>;
public:
    RefCountType SharedReferenceCount{1};
    RefCountType WeakReferenceCount{1};
};
```

<!-- more -->

一个值得注意的地方是，即使 `SharedReferenceCount` 为 0，控制块也不一定会被销毁（当然对象本身已经销毁），只有当 `WeakReferenceCount` 也为 0 时，控制块才会被销毁。

1. **对象销毁仅由共享引用计数控制**
2. **引用控制器销毁由弱引用计数控制**

控制块带有 `Base` 后缀，表示它是基类。实际使用时，分别是 `FSharedReferencer` 和 `FWeakReferencer` 这两个类，它们对应两种指针的控制块。

它们以组合方式持有指向基类的指针，并且互为友元，这样在相互构造（共享指针或弱指针）时，能够增加或减少对方的引用计数。

```cpp
template< ESPMode Mode >
class FSharedReferencer
{
    template< ESPMode OtherMode > friend class FWeakReferencer;

    TReferenceControllerBase<Mode>* ReferenceController;
};

template< ESPMode Mode >
class FWeakReferencer
{
    template< ESPMode OtherMode > friend class FSharedReferencer;

    TReferenceControllerBase<Mode>* ReferenceController;
};
```

控制块还有两种版本，一个是带删除器的版本，另一个是侵入式控制块。

先来了解一下删除器。

删除器通过重载 `operator()` 来实现在析构时执行特定行为，当然也可以使用 Lambda，编译器会自动将 Lambda 转换为含有 operator() 的类。删除器通常用于 C 风格数组，需要调用 `delete[]`。

删除器包装类有两个实现，其中一个将删除器作为成员变量。

是否将删除器作为成员变量，取决于 `DeleterType` 是否为空。这是因为编译器进行了[空基类优化](https://zh.cppreference.com/w/cpp/language/ebo)（Empty Base Optimization）。

```cpp
template <typename DeleterType, bool bIsZeroSize = std::is_empty_v<DeleterType>>
struct TDeleterHolder : private DeleterType
{
    explicit TDeleterHolder(DeleterType&& Arg)
        : DeleterType(MoveTemp(Arg))
    {
    }

    template <typename ObjectType>
    void InvokeDeleter(ObjectType * Object)
    {
        Invoke(*static_cast<DeleterType*>(this), Object);
    }
};

template <typename DeleterType>
struct TDeleterHolder<DeleterType, false>
{
    explicit TDeleterHolder(DeleterType&& Arg)
        : Deleter(MoveTemp(Arg))
    {
    }

    template <typename ObjectType>
    void InvokeDeleter(ObjectType * Object)
    {
        Invoke(Deleter, Object);
    }
private:
    DeleterType Deleter;
};
```

带删除器的控制块仅仅是在释放对象时调用删除器。


```cpp
template <typename ObjectType, typename DeleterType, ESPMode Mode>
class TReferenceControllerWithDeleter : private TDeleterHolder<DeleterType>, public TReferenceControllerBase<Mode>
{
public:
    virtual void DestroyObject() override
    {
        this->InvokeDeleter(Object);
    }
private:
    ObjectType* Object;
};
```

侵入式控制块的特点是将引用计数和对象本身分配到同一块内存中，避免了二次分配，从而提高了性能。


```cpp
template <typename ObjectType, ESPMode Mode>
class TIntrusiveReferenceController : public TReferenceControllerBase<Mode>
{
public:
    template <typename... ArgTypes>
    explicit TIntrusiveReferenceController(ArgTypes&&... Args)
    {
        new ((void*)&ObjectStorage) ObjectType(Forward<ArgTypes>(Args)...);
    }

    ObjectType* GetObjectPtr() const
    {
        return (ObjectType*)&ObjectStorage;
    }

    virtual void DestroyObject() override
    {
        DestructItem((ObjectType*)&ObjectStorage);
    }
private:
    mutable TTypeCompatibleBytes<ObjectType> ObjectStorage;
};
```

这三种控制块可以通过以下辅助方法来创建：

```cpp
namespace SharedPointerInternals
{
    template <ESPMode Mode, typename ObjectType>
    inline TReferenceControllerBase<Mode>* NewDefaultReferenceController(ObjectType* Object)
    {
        return new TReferenceControllerWithDeleter<ObjectType, DefaultDeleter<ObjectType>, Mode>(Object, DefaultDeleter<ObjectType>());
    }

    template <ESPMode Mode, typename ObjectType, typename DeleterType>
    inline TReferenceControllerBase<Mode>* NewCustomReferenceController(ObjectType* Object, DeleterType&& Deleter)
    {
        return new TReferenceControllerWithDeleter<ObjectType, typename TRemoveReference<DeleterType>::Type, Mode>(Object, Forward<DeleterType>(Deleter));
    }

    template <ESPMode Mode, typename ObjectType, typename... ArgTypes>
    inline TIntrusiveReferenceController<ObjectType, Mode>* NewIntrusiveReferenceController(ArgTypes&&... Args)
    {
        return new TIntrusiveReferenceController<ObjectType, Mode>(Forward<ArgTypes>(Args)...);
    }
}
```

## TSharedPtr

有了控制块后，就可以来实现智能指针了。

```cpp
template< class ObjectType, ESPMode InMode >
class TSharedPtr
{
public:
    using ElementType = ObjectType;
    static constexpr ESPMode Mode = InMode;
private:
    template< class OtherType, ESPMode OtherMode > friend class TSharedPtr;
    template< class OtherType, ESPMode OtherMode > friend class TSharedRef;
    template< class OtherType, ESPMode OtherMode > friend class TWeakPtr;
    template< class OtherType, ESPMode OtherMode > friend class TSharedFromThis;
private:
    ObjectType* Object;
    SharedPointerInternals::FSharedReferencer< Mode > SharedReferenceCount;
};
```

构造空共享指针。

```cpp
FORCEINLINE TSharedPtr( SharedPointerInternals::FNullTag* = nullptr )
    : Object( nullptr )
    , SharedReferenceCount()
{
}
```

构造共享指针，允许为 nullptr，与 `std::shared_ptr` 行为对齐。

`EnableSharedFromThis` 类似 `shared_from_this` 用于传递自身指针，但用共享指针包装。

```cpp
template <
    typename OtherType,
    typename = decltype(ImplicitConv<ObjectType*>((OtherType*)nullptr))
>
FORCEINLINE explicit TSharedPtr( OtherType* InObject )
    : Object( InObject )
    , SharedReferenceCount( SharedPointerInternals::NewDefaultReferenceController< Mode >( InObject ) )
{
    SharedPointerInternals::EnableSharedFromThis( this, InObject, InObject );
}
```

跳过其他拷贝构造、移动构造、拷贝赋值、移动赋值的实现，以及带自定义删除器相关的构造函数。

由 `TRawPtrProxy` 隐式构造出 `TSharedPtr` 。

```cpp
template <
    typename OtherType,
    typename = decltype(ImplicitConv<ObjectType*>((OtherType*)nullptr))
>
FORCEINLINE TSharedPtr( SharedPointerInternals::TRawPtrProxy< OtherType > const& InRawPtrProxy )
    : Object( InRawPtrProxy.Object )
    , SharedReferenceCount( SharedPointerInternals::NewDefaultReferenceController< Mode >( InRawPtrProxy.Object ) )
{
    SharedPointerInternals::EnableSharedFromThis( this, InRawPtrProxy.Object, InRawPtrProxy.Object );
}
```

`TRawPtrProxy` 是用 `MakeShareable` 辅助函数构造出来的。

```cpp
template< class ObjectType >
[[nodiscard]] FORCEINLINE SharedPointerInternals::TRawPtrProxy< ObjectType > MakeShareable( ObjectType* InObject )
{
    return SharedPointerInternals::TRawPtrProxy< ObjectType >( InObject );
}
```

因此切忌，不要用 `auto` 去接 `MakeShareable` 的返回值，因为它返回的不是 `TSharedPtr` 而是 `TRawPtrProxy` ，但它可以隐式构造为 `TSharedPtr` 和 `TSharedRef` (这点后面可以看到)。

```cpp
{
    auto RawPtrProxy = MakeShareable(obj); // ERROR
}
```

## TWeakPtr

`TWeakPtr` 的控制块总是从其他地方获取，而不是通过 new 创建的。

```cpp
template< class ObjectType, ESPMode InMode >
class TWeakPtr
{
public:
	using ElementType = ObjectType;
	static constexpr ESPMode Mode = InMode;

private:
    template< class OtherType, ESPMode OtherMode > friend class TWeakPtr;
    template< class OtherType, ESPMode OtherMode > friend class TSharedPtr;
private:
	ObjectType* Object;
	SharedPointerInternals::FWeakReferencer< Mode > WeakReferenceCount;
};
```

简单看三类构造函数吧，第一类是从 `TSharedPtr` 构造 `TWeakPtr` 。

```cpp
template <
    typename OtherType,
    typename = decltype(ImplicitConv<ObjectType*>((OtherType*)nullptr))
>
FORCEINLINE TWeakPtr( TSharedPtr< OtherType, Mode > const& InSharedPtr )
    : Object( InSharedPtr.Object )
    , WeakReferenceCount( InSharedPtr.SharedReferenceCount )
{
}
```

第二类从 `TSharedRef` 构造 `TWeakPtr` 。

```cpp
template <
    typename OtherType,
    typename = decltype(ImplicitConv<ObjectType*>((OtherType*)nullptr))
>
FORCEINLINE TWeakPtr( TSharedRef< OtherType, Mode > const& InSharedRef )
    : Object( InSharedRef.Object )
    , WeakReferenceCount( InSharedRef.SharedReferenceCount )
{
}
```

第三类从 `TWeakPtr` 构造 `TWeakPtr` 。

```cpp
template <
    typename OtherType,
    typename = decltype(ImplicitConv<ObjectType*>((OtherType*)nullptr))
>
FORCEINLINE TWeakPtr( TWeakPtr< OtherType, Mode > const& InWeakPtr )
    : Object( InWeakPtr.Object )
    , WeakReferenceCount( InWeakPtr.WeakReferenceCount )
{
}
```

将 `TWeakPtr` 转换为 `TSharedPtr` 时，注意共享指针可能已经被释放。

```cpp
[[nodiscard]] FORCEINLINE TSharedPtr< ObjectType, Mode > Pin() &&
{
    return TSharedPtr< ObjectType, Mode >( MoveTemp( *this ) );
}
```

## TSharedRef

`TSharedRef` 是 Unreal 引擎的扩展，与引用类似，但它不能为空，Unreal 推荐优先使用它，因为不需要担心为空的情况。

```cpp
template< class ObjectType, ESPMode InMode >
class TSharedRef
{
public:
    using ElementType = ObjectType;
    static constexpr ESPMode Mode = InMode;

    template< class OtherType, ESPMode OtherMode > friend class TSharedRef;
    template< class OtherType, ESPMode OtherMode > friend class TSharedPtr;
    template< class OtherType, ESPMode OtherMode > friend class TWeakPtr;
private:
    ObjectType* Object;
    SharedPointerInternals::FSharedReferencer< Mode > SharedReferenceCount;

    friend TSharedRef UE::Core::Private::MakeSharedRef<ObjectType, Mode>(ObjectType* InObject, SharedPointerInternals::TReferenceControllerBase<Mode>* InSharedReferenceCount);
};
```

`MakeSharedRef` 是为实现 `MakeShared` 函数而提供的辅助方法，用于构造 `TSharedRef`。Unreal 推荐使用 `MakeShared`，因为它允许直接用 `auto` 获取返回值，并且采用了侵入式引用控制块，这会将引用计数和对象本身放在同一块堆内存中，而不是分开分配。

```cpp
template <typename InObjectType, ESPMode InMode = ESPMode::ThreadSafe, typename... InArgTypes>
[[nodiscard]] FORCEINLINE TSharedRef<InObjectType, InMode> MakeShared(InArgTypes&&... Args)
{
    SharedPointerInternals::TIntrusiveReferenceController<InObjectType, InMode>* Controller = SharedPointerInternals::NewIntrusiveReferenceController<InMode, InObjectType>(Forward<InArgTypes>(Args)...);
    return UE::Core::Private::MakeSharedRef<InObjectType, InMode>(Controller->GetObjectPtr(), (SharedPointerInternals::TReferenceControllerBase<InMode>*)Controller);
}
```

`TSharedRef` 也可以通过 `TRawPtrProxy` 隐式构造，而 `MakeShareable` 也能方便地创建 `Ref` 或 `Ptr` 类型。

```cpp
template <
    typename OtherType,
    typename = decltype(ImplicitConv<ObjectType*>((OtherType*)nullptr))
>
FORCEINLINE TSharedRef( SharedPointerInternals::TRawPtrProxy< OtherType > const& InRawPtrProxy )
    : Object( InRawPtrProxy.Object )
    , SharedReferenceCount( SharedPointerInternals::NewDefaultReferenceController< Mode >( InRawPtrProxy.Object ) )
{
    check( InRawPtrProxy.Object != nullptr );

    SharedPointerInternals::EnableSharedFromThis( this, InRawPtrProxy.Object, InRawPtrProxy.Object );
}
```

此外，Unreal 也实现了类似于 C++ 标准库中的 `std::static_pointer_cast`，这里称为 `StaticCastSharedPtr`。虽然还实现了 `ConstCastSharedPtr`，但并没有实现 `std::dynamic_pointer_cast`，因此在进行下行转型时需要特别小心，可能会导致崩溃。

## TSharedFromThis

前面提到过 类似C++ 标准库的 `shared_from_this` 。

其实现原理是通过存储当前对象的弱指针 (WeakThis)，当需要将当前对象封装为共享指针时，使用 `AsShared` 函数即可。

```cpp
template< class ObjectType, ESPMode Mode >
class TSharedFromThis
{
public:
    [[nodiscard]] TSharedRef< ObjectType, Mode > AsShared()
    {
        TSharedPtr< ObjectType, Mode > SharedThis( WeakThis.Pin() );
        return MoveTemp( SharedThis ).ToSharedRef();
    }

    [[nodiscard]] TWeakPtr< ObjectType, Mode > AsWeak()
    {
        TWeakPtr< ObjectType, Mode > Result = WeakThis;
        return Result;
    }
protected:
    template< class OtherType >
    [[nodiscard]] FORCEINLINE static TSharedRef< OtherType, Mode > SharedThis( OtherType* ThisPtr )
    {
        return StaticCastSharedRef< OtherType >( ThisPtr->AsShared() );
    }
private:
    mutable TWeakPtr< ObjectType, Mode > WeakThis;	
};
```

两个内部函数用于存储 `WeakThis`，它们会在调用 `SharedPointerInternals::EnableSharedFromThis` 时被触发，并在智能指针构造过程中使用。

```cpp
template< class SharedPtrType, class OtherType >
FORCEINLINE void UpdateWeakReferenceInternal( TSharedPtr< SharedPtrType, Mode > const* InSharedPtr, OtherType* InObject ) const
{
    if( !WeakThis.IsValid() )
    {
        WeakThis = TSharedPtr< ObjectType, Mode >( *InSharedPtr, InObject );
    }
}

template< class SharedRefType, class OtherType >
FORCEINLINE void UpdateWeakReferenceInternal( TSharedRef< SharedRefType, Mode > const* InSharedRef, OtherType* InObject ) const
{
    if( !WeakThis.IsValid() )
    {
        WeakThis = TSharedRef< ObjectType, Mode >( *InSharedRef, InObject );
    }
}
```

## TUniquePtr

`TUniquePtr` 提供了两个模板：一个是普通对象，另一个是 C 风格数组的偏特化版本。

```cpp
template <typename T, typename Deleter = TDefaultDelete<T>>
class TUniquePtr : private Deleter;
template <typename T, typename Deleter>
class TUniquePtr<T[], Deleter> : private Deleter;
```

包含一个成员。

```cpp
T* Ptr;
```

不同的删除器会调用不同的 `delete` 方式，例如 C 风格数组会调用 `delete []`。

TUniquePtr 禁止拷贝构造和拷贝赋值，在析构时会调用删除器释放内存，这部分实现非常简洁，就略过吧。