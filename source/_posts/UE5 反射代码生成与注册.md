---
title: UE5 反射代码生成与注册
categories: UE
date: 2025-01-11 22:17:20
keywords: UE5, 反射, UClass, UFunction, UE5反射
tags: [UE5, 反射]
---

本文以 UE5.4 为基准，剖析反射代码的生成内容和注册流程。

## 简介

UE5 的 C++ 需要各种宏来辅助开发，在编译时使用 `UHT` 工具扫描这些宏来生成 `XXX.generated.h` 和 `XXX.gen.cpp` 两个文件，接下来将分析UHT生成的文件，来学习反射具体做了什么。代码将会删减掉热更相关的内容，只关注核心逻辑。

## 反射代码

### Enum

枚举的声明在C++中有三种方式，C风格、namespace、enum class。

```cpp
enum class ECppForm
{
    Regular,
    Namespaced,
    EnumClass
};
```

为了减小本文篇幅，此处只看 enum class。在一个新文件中定义完该 enum class 后，进行构建。

```cpp
UENUM(BlueprintType)
enum class EMyEnumClass:uint8
{
    Enum1	UMETA(DisplayName = "DisplayInBlueprint"),
    Enum2,
};
```

最终会生成 `generated.h` 和 `gen.cpp` 两个文件。

`generated.h` 的内容如下，仅仅只是一些模板全特化，便于开发。

```cpp
#define FOREACH_ENUM_EMYENUMCLASS(op) \
    op(EMyEnumClass::Enum1) \
    op(EMyEnumClass::Enum2) 

enum class EMyEnumClass : uint8;
template<> struct TIsUEnumClass<EMyEnumClass> { enum { Value = true }; };
template<> REFLECTION_API UEnum* StaticEnum<EMyEnumClass>();
```

<!-- more -->

`gen.cpp` 的内容偏多，将从上往下进行注释讲解。

```cpp
// 一个空函数，避免被编译器误认为该文件没有需要编译的内容而跳过
void EmptyLinkFunctionForGeneratedCodeMyEnumClass() {}
```

前置声明，内部构建 UEnum 和 UPackage。 UPackage 是个代码包，会将同一模块内的所有反射类组织到一起 。反射的代码都是以 `Z_` 开头，因为 `Z` 是字母最后一位，避免代码提示里提示过靠前。

```cpp
// 看返回值就知道 是构建 UEnum 的
REFLECTION_API UEnum* Z_Construct_UEnum_Reflection_EMyEnumClass();
// 构建该 UEnum 所属的 Package, 避免 Package 没构建出来
UPackage* Z_Construct_UPackage__Script_Reflection();
```

此处才是真正对外构建 UEnum 的接口，其内部最终会调用到 `Z_Construct_UEnum_Reflection_EMyEnumClass` ，但此时还没看到该函数的定义先略过。还有一点需要注意 调用 `GetStaticEnum` 时，已经显式的调用 `Z_Construct_UPackage__Script_Reflection()` 来确保 UPackage 一定存在了。

剧透一下 `GetStaticEnum` 实际上就是执行第一个参数的函数，用内部函数构建出 `UEnum` 。

```cpp
static FEnumRegistrationInfo Z_Registration_Info_UEnum_EMyEnumClass;
static UEnum* EMyEnumClass_StaticEnum()
{
    if (!Z_Registration_Info_UEnum_EMyEnumClass.OuterSingleton)
    {
        Z_Registration_Info_UEnum_EMyEnumClass.OuterSingleton = GetStaticEnum(
            Z_Construct_UEnum_Reflection_EMyEnumClass,
            (UObject*)Z_Construct_UPackage__Script_Reflection(),
            TEXT("EMyEnumClass")
        );
    }
    return Z_Registration_Info_UEnum_EMyEnumClass.OuterSingleton;
}
template<> REFLECTION_API UEnum* StaticEnum<EMyEnumClass>()
{
    return EMyEnumClass_StaticEnum();
}
```

此处是一些元数据， `FEnumParams` 就是后面用来构建 UEnum 的参数。

```cpp
struct Z_Construct_UEnum_Reflection_EMyEnumClass_Statics
{
#if WITH_METADATA
    static constexpr UECodeGen_Private::FMetaDataPairParam Enum_MetaDataParams[] = {
        { "BlueprintType", "true" },
#if !UE_BUILD_SHIPPING
        { "Comment", "/**\n * \n */" },
#endif
        { "Enum1.Comment", "/**\n * \n */" },
        { "Enum1.DisplayName", "DisplayInBlueprint" },
        { "Enum1.Name", "EMyEnumClass::Enum1" },
        { "Enum2.Comment", "/**\n * \n */" },
        { "Enum2.Name", "EMyEnumClass::Enum2" },
        { "ModuleRelativePath", "Public/Enum/MyEnumClass.h" },
	};
#endif // WITH_METADATA
    static constexpr UECodeGen_Private::FEnumeratorParam Enumerators[] = {
        { "EMyEnumClass::Enum1", (int64)EMyEnumClass::Enum1 },
        { "EMyEnumClass::Enum2", (int64)EMyEnumClass::Enum2 },
    };
    static const UECodeGen_Private::FEnumParams EnumParams;
};
```

```cpp
const UECodeGen_Private::FEnumParams Z_Construct_UEnum_Reflection_EMyEnumClass_Statics::EnumParams = {
    (UObject*(*)())Z_Construct_UPackage__Script_Reflection,
    nullptr,
    "EMyEnumClass",
    "EMyEnumClass",
    Z_Construct_UEnum_Reflection_EMyEnumClass_Statics::Enumerators,
    RF_Public|RF_Transient|RF_MarkAsNative, // 包外可见、不需要序列化、标记为原生类
    UE_ARRAY_COUNT(Z_Construct_UEnum_Reflection_EMyEnumClass_Statics::Enumerators),
    EEnumFlags::None,
    (uint8)UEnum::ECppForm::EnumClass, // 之前提到过的 创建 Enum 的三种方式
    METADATA_PARAMS(UE_ARRAY_COUNT(Z_Construct_UEnum_Reflection_EMyEnumClass_Statics::Enum_MetaDataParams), Z_Construct_UEnum_Reflection_EMyEnumClass_Statics::Enum_MetaDataParams)
};
struct FEnumParams
{
    UObject*                  (*OuterFunc)();
    FText                     (*DisplayNameFunc)(int32);
    const char*                 NameUTF8;
    const char*                 CppTypeUTF8;
    const FEnumeratorParam*     EnumeratorParams;
    EObjectFlags                ObjectFlags;
    int16                       NumEnumerators;
    EEnumFlags                  EnumFlags;
    uint8                       CppForm; // this is of type UEnum::ECppForm
#if WITH_METADATA
    uint16                      NumMetaData;
    const FMetaDataPairParam*   MetaDataArray;
#endif
};
```

内部真正构造 UEnum 的函数，Outer 最终就是调用该函数 完成 Inner 的构建。

```cpp
UEnum* Z_Construct_UEnum_Reflection_EMyEnumClass()
{
    if (!Z_Registration_Info_UEnum_EMyEnumClass.InnerSingleton)
    {
        UECodeGen_Private::ConstructUEnum(Z_Registration_Info_UEnum_EMyEnumClass.InnerSingleton, Z_Construct_UEnum_Reflection_EMyEnumClass_Statics::EnumParams);
    }
    return Z_Registration_Info_UEnum_EMyEnumClass.InnerSingleton;
}
```

注册相关代码，可以看出它是以文件为单位，将整个文件的内容都放到一起，这个文件只有一个枚举，所以内容就比较少，如果还有 UStruct 的话 也会在此处被列出。

```cpp
struct Z_CompiledInDeferFile_FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Enum_MyEnumClass_h_Statics
{
    static constexpr FEnumRegisterCompiledInInfo EnumInfo[] = {
        { EMyEnumClass_StaticEnum, TEXT("EMyEnumClass"), 
            &Z_Registration_Info_UEnum_EMyEnumClass,
            CONSTRUCT_RELOAD_VERSION_INFO(FEnumReloadVersionInfo, 4010083278U)
        },
    };
};
static FRegisterCompiledInInfo Z_CompiledInDeferFile_FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Enum_MyEnumClass_h_2660371430(
    TEXT("/Script/Reflection"),
    nullptr, 0,
    nullptr, 0,
    Z_CompiledInDeferFile_FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Enum_MyEnumClass_h_Statics::EnumInfo, 
    UE_ARRAY_COUNT(Z_CompiledInDeferFile_FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Enum_MyEnumClass_h_Statics::EnumInfo)
);
struct FEnumRegisterCompiledInInfo
{
    class UEnum* (*OuterRegister)();
    const TCHAR* Name;
    FEnumRegistrationInfo* Info;
    FEnumReloadVersionInfo VersionInfo;
};
```

### Struct

为了本文主体逻辑能够简单理解，只声明定义一个属性。

```cpp
USTRUCT(BlueprintType)
struct FMyStruct
{
    GENERATED_BODY()

    UPROPERTY()
    int32 MyInt32 = 0;
};
```

`GENERATED_BODY` 本质就是将其替换为 `文件名_行号_GENERATED_BODY` 。

```cpp
#define BODY_MACRO_COMBINE_INNER(A,B,C,D) A##B##C##D
#define BODY_MACRO_COMBINE(A,B,C,D) BODY_MACRO_COMBINE_INNER(A,B,C,D)
#define GENERATED_BODY(...) BODY_MACRO_COMBINE(CURRENT_FILE_ID,_,__LINE__,_GENERATED_BODY);
```

最后会被替换 `FID_Project_Source_Reflection_Public_Struct_MyStruct_h_13_GENERATED_BODY` 

再看 `generated.h` 的内容

```cpp
#define FID_Project_Source_Reflection_Public_Struct_MyStruct_h_13_GENERATED_BODY \
    friend struct Z_Construct_UScriptStruct_FMyStruct_Statics; \
    REFLECTION_API static class UScriptStruct* StaticStruct();

template<> REFLECTION_API UScriptStruct* StaticStruct<struct FMyStruct>();
```

宏展开之后得到

```cpp
template<> REFLECTION_API UScriptStruct* StaticStruct<struct FMyStruct>();

USTRUCT(BlueprintType)
struct FMyStruct
{
    friend struct Z_Construct_UScriptStruct_FMyStruct_Statics;
    REFLECTION_API static class UScriptStruct* StaticStruct();

    UPROPERTY()
    int32 MyInt32 = 0;
};
```

`gen.cpp` 内容如下，但不会再次解释了，很多都在 Enum 那解释过了。

```cpp
void EmptyLinkFunctionForGeneratedCodeMyStruct() {}
// 前置声明
REFLECTION_API UScriptStruct* Z_Construct_UScriptStruct_FMyStruct();
UPackage* Z_Construct_UPackage__Script_Reflection();
```

对外的构造 Struct 接口。

```cpp
static FStructRegistrationInfo Z_Registration_Info_UScriptStruct_MyStruct;
class UScriptStruct* FMyStruct::StaticStruct()
{
    if (!Z_Registration_Info_UScriptStruct_MyStruct.OuterSingleton)
    {
        Z_Registration_Info_UScriptStruct_MyStruct.OuterSingleton = GetStaticStruct(
            Z_Construct_UScriptStruct_FMyStruct,
            (UObject*)Z_Construct_UPackage__Script_Reflection(),
            TEXT("MyStruct")
        );
    }
    return Z_Registration_Info_UScriptStruct_MyStruct.OuterSingleton;
}
template<> REFLECTION_API UScriptStruct* StaticStruct<FMyStruct>()
{
    return FMyStruct::StaticStruct();
}
```

反射元数据，其中 `NewStructOps` 提供了结构体反射、序列化、复制比较功能。

```cpp
struct Z_Construct_UScriptStruct_FMyStruct_Statics
{
#if WITH_METADATA
    static constexpr UECodeGen_Private::FMetaDataPairParam Struct_MetaDataParams[] = {
        { "BlueprintType", "true" },
#if !UE_BUILD_SHIPPING
        { "Comment", "/**\n * \n */" },
#endif
        { "ModuleRelativePath", "Public/Struct/MyStruct.h" },
    };
    static constexpr UECodeGen_Private::FMetaDataPairParam NewProp_MyInt32_MetaData[] = {
        { "ModuleRelativePath", "Public/Struct/MyStruct.h" },
    };
#endif // WITH_METADATA
    static const UECodeGen_Private::FIntPropertyParams NewProp_MyInt32;
    static const UECodeGen_Private::FPropertyParamsBase* const PropPointers[];
    static void* NewStructOps()
    {
        return (UScriptStruct::ICppStructOps*)new UScriptStruct::TCppStructOps<FMyStruct>();
    }
    static const UECodeGen_Private::FStructParams StructParams;
};
```

属性，我们只有一个属性，可以看到会在这记录该属性在 Struct 中的偏移量，同时 属性个数不得超过 2048个。

```cpp
const UECodeGen_Private::FIntPropertyParams Z_Construct_UScriptStruct_FMyStruct_Statics::NewProp_MyInt32 = {
    "MyInt32",
    nullptr,
    (EPropertyFlags)0x0010000000000000,
    UECodeGen_Private::EPropertyGenFlags::Int,
    RF_Public|RF_Transient|RF_MarkAsNative,
    nullptr,
    nullptr,
    1,
    STRUCT_OFFSET(FMyStruct, MyInt32),
    METADATA_PARAMS(UE_ARRAY_COUNT(NewProp_MyInt32_MetaData),
    NewProp_MyInt32_MetaData)
};
const UECodeGen_Private::FPropertyParamsBase* const Z_Construct_UScriptStruct_FMyStruct_Statics::PropPointers[] = {
    (const UECodeGen_Private::FPropertyParamsBase*)&Z_Construct_UScriptStruct_FMyStruct_Statics::NewProp_MyInt32,
};
static_assert(UE_ARRAY_COUNT(Z_Construct_UScriptStruct_FMyStruct_Statics::PropPointers) < 2048);
```

构造 Struct 的参数。

```cpp
const UECodeGen_Private::FStructParams Z_Construct_UScriptStruct_FMyStruct_Statics::StructParams = {
    (UObject* (*)())Z_Construct_UPackage__Script_Reflection,
    nullptr, // 父类
    &NewStructOps,
    "MyStruct",
    Z_Construct_UScriptStruct_FMyStruct_Statics::PropPointers,
    UE_ARRAY_COUNT(Z_Construct_UScriptStruct_FMyStruct_Statics::PropPointers),
    sizeof(FMyStruct),
    alignof(FMyStruct),
    RF_Public|RF_Transient|RF_MarkAsNative,
    EStructFlags(0x00000001), // STRUCT_Native
    METADATA_PARAMS(UE_ARRAY_COUNT(Z_Construct_UScriptStruct_FMyStruct_Statics::Struct_MetaDataParams), Z_Construct_UScriptStruct_FMyStruct_Statics::Struct_MetaDataParams)
};
struct FStructParams
{
    UObject*                          (*OuterFunc)();
    UScriptStruct*                    (*SuperFunc)();
    void*                             (*StructOpsFunc)(); // really returns UScriptStruct::ICppStructOps*
    const char*                         NameUTF8;
    const FPropertyParamsBase* const*   PropertyArray;
    uint16                              NumProperties;
    uint16                              SizeOf;
    uint8                               AlignOf;
    EObjectFlags                        ObjectFlags;
    uint32                              StructFlags; // EStructFlags
#if WITH_METADATA
    uint16                              NumMetaData;
    const FMetaDataPairParam*           MetaDataArray;
#endif
};
```

同个文件内的反射内容都会注册到这，这个文件只有 Struct。

```cpp
struct Z_CompiledInDeferFile_FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Struct_MyStruct_h_Statics
{
    static constexpr FStructRegisterCompiledInInfo ScriptStructInfo[] = {
       { FMyStruct::StaticStruct, Z_Construct_UScriptStruct_FMyStruct_Statics::NewStructOps,
            TEXT("MyStruct"), &Z_Registration_Info_UScriptStruct_MyStruct,
            CONSTRUCT_RELOAD_VERSION_INFO(FStructReloadVersionInfo, sizeof(FMyStruct), 221546749U)
        },
    };
};
struct FStructRegisterCompiledInInfo
{
    class UScriptStruct* (*OuterRegister)();
    void* (*CreateCppStructOps)();
    const TCHAR* Name;
    FStructRegistrationInfo* Info;
    FStructReloadVersionInfo VersionInfo;
};
```

注册参数。

```cpp
static FRegisterCompiledInInfo Z_CompiledInDeferFile_FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Struct_MyStruct_h_1968461662(
    TEXT("/Script/Reflection"),
    nullptr,
    0,
    Z_CompiledInDeferFile_FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Struct_MyStruct_h_Statics::ScriptStructInfo,
    UE_ARRAY_COUNT(Z_CompiledInDeferFile_FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Struct_MyStruct_h_Statics::ScriptStructInfo),
    nullptr,
    0
);
```

### Class

Class 和 Struct 其实差不太多，但它支持成员方法，同时成员方法还支持给蓝图调用。下面只定义一个成员方法，但它支持参数和返回值。

```cpp
UCLASS()
class REFLECTION_API UMyObject : public UObject
{
    GENERATED_BODY()
public:
    UFUNCTION()
    int32 MyFunc(int32 i) { return i++; }
private:
    UPROPERTY()
    int32 MyInt32 = 0;
};
```

`GENERATED_BODY()` 生成出以下内容

```cpp
#define FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Object_MyObject_h_14_GENERATED_BODY \
public: \
    FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Object_MyObject_h_14_RPC_WRAPPERS_NO_PURE_DECLS \
    FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Object_MyObject_h_14_INCLASS_NO_PURE_DECLS \
    FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Object_MyObject_h_14_ENHANCED_CONSTRUCTORS \
private:
```

`RPC_WRAPPERS_NO_PURE_DECLS` 会生成 UFunction 方法的包装，为了让蓝图也能调用，其实就将参数和返回值改放到 `FFrame` 栈中。

```cpp
#define DECLARE_FUNCTION(func) static void func( UObject* Context, FFrame& Stack, RESULT_DECL )

#define FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Object_MyObject_h_14_RPC_WRAPPERS_NO_PURE_DECLS \
    DECLARE_FUNCTION(execMyFunc);
    
#define FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Object_MyObject_h_14_RPC_WRAPPERS_NO_PURE_DECLS \
    static void execMyFunc( UObject* Context, FFrame& Stack, RESULT_DECL );
```

`INCLASS_NO_PURE_DECLS` 声明一些类的基础别名、序列化等。比如 `Super` 就是在这被设置为父类别名的。

```cpp
#define FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Object_MyObject_h_14_INCLASS_NO_PURE_DECLS \
private: \
    static void StaticRegisterNativesUMyObject(); \
    friend struct Z_Construct_UClass_UMyObject_Statics; \
public: \
    DECLARE_CLASS(UMyObject, UObject, COMPILED_IN_FLAGS(0), CASTCLASS_None, TEXT("/Script/Reflection"), NO_API) \
    DECLARE_SERIALIZER(UMyObject)
```

`ENHANCED_CONSTRUCTORS` 从名字也能看出是提供多一些构造函数。

```cpp
#define FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Object_MyObject_h_14_ENHANCED_CONSTRUCTORS \
    /** Standard constructor, called after all reflected properties have been initialized */ \
    NO_API UMyObject(const FObjectInitializer& ObjectInitializer = FObjectInitializer::Get()); \
private: \
    /** Private move- and copy-constructors, should never be used */ \
    UMyObject(UMyObject&&); \
    UMyObject(const UMyObject&); \
public: \
    DECLARE_VTABLE_PTR_HELPER_CTOR(NO_API, UMyObject); \
    DEFINE_VTABLE_PTR_HELPER_CTOR_CALLER(UMyObject); \
    DEFINE_DEFAULT_OBJECT_INITIALIZER_CONSTRUCTOR_CALL(UMyObject) \
    NO_API virtual ~UMyObject();
```

`GENERATED_BODY()` 将宏完整展开生成代码如下：

```cpp
UCLASS()
class REFLECTION_API UMyObject : public UObject
{
public:
    static void execMyFunc( UObject* Context, FFrame& Stack, RESULT_DECL );
private:
    static void StaticRegisterNativesUMyObject();
    friend struct Z_Construct_UClass_UMyObject_Statics;
public:
    // DECLARE_CLASS(UMyObject, UObject, COMPILED_IN_FLAGS(0), CASTCLASS_None, TEXT("/Script/Reflection"), NO_API)
    static constexpr EClassFlags StaticClassFlags = EClassFlags((0 | CLASS_Intrinsic));
    typedef UObject Super;
    typedef UMyObject ThisClass;
    inline static UClass* StaticClass() { return GetPrivateStaticClass(); }
    inline static const TCHAR* StaticPackage() { return L"/ Script/ Reflection"; }
    inline static EClassCastFlags StaticClassCastFlags() { return CASTCLASS_None; }
    inline void* operator new(const size_t InSize, EInternal InInternalOnly,
                                UObject* InOuter = (UObject*)GetTransientPackage(), FName InName = NAME_None,
                                EObjectFlags InSetFlags = RF_NoFlags)
    {
        return StaticAllocateObject(StaticClass(), InOuter, InName, InSetFlags);
    }

    inline void* operator new(const size_t InSize, EInternal* InMem) { return (void*)InMem; }
    inline void operator delete(void* InMem) { ::operator delete(InMem); }
    // DECLARE_CLASS END

    // DECLARE_SERIALIZER(UMyObject)
    friend FArchive& operator<<(FArchive& Ar, UMyObject*& Res) { return Ar << (UObject*&)Res; }
    friend void operator<<(FStructuredArchive::FSlot InSlot, UMyObject*& Res) { InSlot << (UObject*&)Res; }
    // DECLARE_SERIALIZER END

    NO_API UMyObject(const FObjectInitializer& ObjectInitializer = FObjectInitializer::Get());
private:
    /** Private move- and copy-constructors, should never be used */
    UMyObject(UMyObject&&);
    UMyObject(const UMyObject&);
public:
    // 热更用的 跳过
    DECLARE_VTABLE_PTR_HELPER_CTOR(NO_API, UMyObject);
    DEFINE_VTABLE_PTR_HELPER_CTOR_CALLER(UMyObject);

    // DEFINE_DEFAULT_OBJECT_INITIALIZER_CONSTRUCTOR_CALL(UMyObject)
    static void __DefaultConstructor(const FObjectInitializer& X) { new((EInternal*)X.GetObj())UMyObject(X); }
    // DEFINE_DEFAULT_OBJECT_INITIALIZER_CONSTRUCTOR_CALL END

    NO_API virtual ~UMyObject();
public:
    int32 MyFunc(int32 i) { return i++; }
private:
    int32 MyInt32 = 0;
};
```

`gen.cpp`  前置声明。

```cpp
void EmptyLinkFunctionForGeneratedCodeMyObject() {}

COREUOBJECT_API UClass* Z_Construct_UClass_UObject();
REFLECTION_API UClass* Z_Construct_UClass_UMyObject();
REFLECTION_API UClass* Z_Construct_UClass_UMyObject_NoRegister();
UPackage* Z_Construct_UPackage__Script_Reflection();
```

成员函数反射信息，为返回值和参数都构造属性。

```cpp
struct Z_Construct_UFunction_UMyObject_MyFunc_Statics
{
    struct MyObject_eventMyFunc_Parms
    {
        int32 i;
        int32 ReturnValue;
    };
#if WITH_METADATA
    static constexpr UECodeGen_Private::FMetaDataPairParam Function_MetaDataParams[] = {
        { "ModuleRelativePath", "Public/Object/MyObject.h" },
    };
#endif // WITH_METADATA
    static const UECodeGen_Private::FIntPropertyParams NewProp_i;
    static const UECodeGen_Private::FIntPropertyParams NewProp_ReturnValue;
    static const UECodeGen_Private::FPropertyParamsBase* const PropPointers[];
    static const UECodeGen_Private::FFunctionParams FuncParams;
};
const UECodeGen_Private::FIntPropertyParams Z_Construct_UFunction_UMyObject_MyFunc_Statics::NewProp_i = { "i", nullptr, (EPropertyFlags)0x0010000000000080, UECodeGen_Private::EPropertyGenFlags::Int, RF_Public|RF_Transient|RF_MarkAsNative, nullptr, nullptr, 1, STRUCT_OFFSET(MyObject_eventMyFunc_Parms, i), METADATA_PARAMS(0, nullptr) };
const UECodeGen_Private::FIntPropertyParams Z_Construct_UFunction_UMyObject_MyFunc_Statics::NewProp_ReturnValue = { "ReturnValue", nullptr, (EPropertyFlags)0x0010000000000580, UECodeGen_Private::EPropertyGenFlags::Int, RF_Public|RF_Transient|RF_MarkAsNative, nullptr, nullptr, 1, STRUCT_OFFSET(MyObject_eventMyFunc_Parms, ReturnValue), METADATA_PARAMS(0, nullptr) };
const UECodeGen_Private::FPropertyParamsBase* const Z_Construct_UFunction_UMyObject_MyFunc_Statics::PropPointers[] = {
    (const UECodeGen_Private::FPropertyParamsBase*)&Z_Construct_UFunction_UMyObject_MyFunc_Statics::NewProp_i,
    (const UECodeGen_Private::FPropertyParamsBase*)&Z_Construct_UFunction_UMyObject_MyFunc_Statics::NewProp_ReturnValue,
};
static_assert(UE_ARRAY_COUNT(Z_Construct_UFunction_UMyObject_MyFunc_Statics::PropPointers) < 2048);
const UECodeGen_Private::FFunctionParams Z_Construct_UFunction_UMyObject_MyFunc_Statics::FuncParams = { (UObject*(*)())Z_Construct_UClass_UMyObject, nullptr, "MyFunc", nullptr, nullptr, Z_Construct_UFunction_UMyObject_MyFunc_Statics::PropPointers, UE_ARRAY_COUNT(Z_Construct_UFunction_UMyObject_MyFunc_Statics::PropPointers), sizeof(Z_Construct_UFunction_UMyObject_MyFunc_Statics::MyObject_eventMyFunc_Parms), RF_Public|RF_Transient|RF_MarkAsNative, (EFunctionFlags)0x00020401, 0, 0, METADATA_PARAMS(UE_ARRAY_COUNT(Z_Construct_UFunction_UMyObject_MyFunc_Statics::Function_MetaDataParams), Z_Construct_UFunction_UMyObject_MyFunc_Statics::Function_MetaDataParams) };
static_assert(sizeof(Z_Construct_UFunction_UMyObject_MyFunc_Statics::MyObject_eventMyFunc_Parms) < MAX_uint16);
```

成员函数的构造方法

```cpp
UFunction* Z_Construct_UFunction_UMyObject_MyFunc()
{
    static UFunction* ReturnFunction = nullptr;
    if (!ReturnFunction)
    {
        UECodeGen_Private::ConstructUFunction(&ReturnFunction, Z_Construct_UFunction_UMyObject_MyFunc_Statics::FuncParams);
    }
    return ReturnFunction;
}
```

成员函数的 thunk 函数定义，里面 P 开头的是虚拟机的辅助宏。

```cpp
#define RESULT_PARAM Z_Param__Result
#define RESULT_DECL void*const RESULT_PARAM
void UMyObject::execMyFunc( UObject* Context, FFrame& Stack, RESULT_DECL )
{
    P_GET_PROPERTY(FIntProperty,Z_Param_i);
    P_FINISH;
    P_NATIVE_BEGIN;
    *(int32*)Z_Param__Result=P_THIS->MyFunc(Z_Param_i);
    P_NATIVE_END;
}
```

注册成员函数和对应的 thunk 函数的绑定。

```cpp
void UMyObject::StaticRegisterNativesUMyObject()
{
    UClass* Class = UMyObject::StaticClass();
    static const FNameNativePtrPair Funcs[] = {
        { "MyFunc", &UMyObject::execMyFunc },
    };
    FNativeFunctionRegistrar::RegisterFunctions(Class, Funcs, UE_ARRAY_COUNT(Funcs));
}
```

`GetPrivateStaticClass` 就是 `StaticClass` 也是 `InnerRegister` 。

```cpp
// IMPLEMENT_CLASS_NO_AUTO_REGISTRATION(UMyObject);
UClass* UMyObject::GetPrivateStaticClass() 
{ 
    if (!Z_Registration_Info_UClass_UMyObject.InnerSingleton) 
    { 
        /* this could be handled with templates, but we want it external to avoid code bloat */ 
        GetPrivateStaticClassBody( 
        StaticPackage(), 
        (TCHAR*)TEXT("UMyObject") + 1 + ((StaticClassFlags & CLASS_Deprecated) ? 11 : 0), 
        Z_Registration_Info_UClass_UMyObject.InnerSingleton, 
        StaticRegisterNativesUMyObject,
        sizeof(UMyObject), 
        alignof(UMyObject), 
        UMyObject::StaticClassFlags, 
        UMyObject::StaticClassCastFlags(), 
        UMyObject::StaticConfigName(), 
        (UClass::ClassConstructorType)InternalConstructor<UMyObject>, 
        (UClass::ClassVTableHelperCtorCallerType)InternalVTableHelperCtorCaller<UMyObject>, 
        UOBJECT_CPPCLASS_STATICFUNCTIONS_FORCLASS(UMyObject), 
        &UMyObject::Super::StaticClass, 
        &UMyObject::WithinClass::StaticClass 
        ); 
    } 
    return Z_Registration_Info_UClass_UMyObject.InnerSingleton; 
}
```

```cpp
UClass* Z_Construct_UClass_UMyObject_NoRegister()
{
    return UMyObject::StaticClass();
}
```

类的反射信息，包含成员变量和成员方法。

```cpp
struct Z_Construct_UClass_UMyObject_Statics
{
#if WITH_METADATA
    static constexpr UECodeGen_Private::FMetaDataPairParam Class_MetaDataParams[] = {
#if !UE_BUILD_SHIPPING
        { "Comment", "/**\n * \n */" },
#endif
        { "IncludePath", "Object/MyObject.h" },
        { "ModuleRelativePath", "Public/Object/MyObject.h" },
    };
    static constexpr UECodeGen_Private::FMetaDataPairParam NewProp_MyInt32_MetaData[] = {
        { "ModuleRelativePath", "Public/Object/MyObject.h" },
    };
#endif // WITH_METADATA
    static const UECodeGen_Private::FIntPropertyParams NewProp_MyInt32;
    static const UECodeGen_Private::FPropertyParamsBase* const PropPointers[];
    static UObject* (*const DependentSingletons[])();
    static constexpr FClassFunctionLinkInfo FuncInfo[] = {
        { &Z_Construct_UFunction_UMyObject_MyFunc, "MyFunc" }, // 1049028917
    };
    static_assert(UE_ARRAY_COUNT(FuncInfo) < 2048);
    static constexpr FCppClassTypeInfoStatic StaticCppClassTypeInfo = {
        TCppClassTypeTraits<UMyObject>::IsAbstract,
    };
    static const UECodeGen_Private::FClassParams ClassParams;
};
```

成员变量反射信息

```cpp
const UECodeGen_Private::FIntPropertyParams Z_Construct_UClass_UMyObject_Statics::NewProp_MyInt32 = { "MyInt32", nullptr, (EPropertyFlags)0x0040000000000000, UECodeGen_Private::EPropertyGenFlags::Int, RF_Public|RF_Transient|RF_MarkAsNative, nullptr, nullptr, 1, STRUCT_OFFSET(UMyObject, MyInt32), METADATA_PARAMS(UE_ARRAY_COUNT(NewProp_MyInt32_MetaData), NewProp_MyInt32_MetaData) };
const UECodeGen_Private::FPropertyParamsBase* const Z_Construct_UClass_UMyObject_Statics::PropPointers[] = {
    (const UECodeGen_Private::FPropertyParamsBase*)&Z_Construct_UClass_UMyObject_Statics::NewProp_MyInt32,
};
static_assert(UE_ARRAY_COUNT(Z_Construct_UClass_UMyObject_Statics::PropPointers) < 2048);
```

构造该 Class 的依赖项，至少要构造 UObject 因为是它子类，其次是 UPackage。

```cpp
UObject* (*const Z_Construct_UClass_UMyObject_Statics::DependentSingletons[])() = {
    (UObject* (*)())Z_Construct_UClass_UObject,
    (UObject* (*)())Z_Construct_UPackage__Script_Reflection,
};
static_assert(UE_ARRAY_COUNT(Z_Construct_UClass_UMyObject_Statics::DependentSingletons) < 16);
```

类的构造参数。

```cpp
const UECodeGen_Private::FClassParams Z_Construct_UClass_UMyObject_Statics::ClassParams = {
    &UMyObject::StaticClass,
    nullptr, // 配置类的文件名
    &StaticCppClassTypeInfo, // 是抽象类吗
    DependentSingletons, // 依赖项
    FuncInfo, // 成员函数信息
    Z_Construct_UClass_UMyObject_Statics::PropPointers, // 成员变量
    nullptr, // 接口信息
    UE_ARRAY_COUNT(DependentSingletons),
    UE_ARRAY_COUNT(FuncInfo),
    UE_ARRAY_COUNT(Z_Construct_UClass_UMyObject_Statics::PropPointers),
    0,
    0x001000A0u, // CLASS_RequiredAPI | CLASS_Native | CLASS_MatchedSerializers
    METADATA_PARAMS(UE_ARRAY_COUNT(Z_Construct_UClass_UMyObject_Statics::Class_MetaDataParams), Z_Construct_UClass_UMyObject_Statics::Class_MetaDataParams)
};
struct FClassParams
{
    UClass*                                   (*ClassNoRegisterFunc)();
    const char*                                 ClassConfigNameUTF8;
    const FCppClassTypeInfoStatic*              CppClassInfo;
    UObject*                           (*const *DependencySingletonFuncArray)();
    const FClassFunctionLinkInfo*               FunctionLinkArray;
    const FPropertyParamsBase* const*           PropertyArray;
    const FImplementedInterfaceParams*          ImplementedInterfaceArray;
    uint32                                      NumDependencySingletons : 4;
    uint32                                      NumFunctions : 11;
    uint32                                      NumProperties : 11;
    uint32                                      NumImplementedInterfaces : 6;
    uint32                                      ClassFlags; // EClassFlags
#if WITH_METADATA
    uint16                                      NumMetaData;
    const FMetaDataPairParam*                   MetaDataArray;
#endif
};
```

构造函数定义。

```cpp
UMyObject::UMyObject(const FObjectInitializer& ObjectInitializer) : Super(ObjectInitializer) {}
DEFINE_VTABLE_PTR_HELPER_CTOR(UMyObject);
UMyObject::~UMyObject() {}
```

真正构造该 Class 的地方。

```cpp
UClass* Z_Construct_UClass_UMyObject()
{
    if (!Z_Registration_Info_UClass_UMyObject.OuterSingleton)
    {
        UECodeGen_Private::ConstructUClass(Z_Registration_Info_UClass_UMyObject.OuterSingleton, Z_Construct_UClass_UMyObject_Statics::ClassParams);
    }
    return Z_Registration_Info_UClass_UMyObject.OuterSingleton;
}
template<> REFLECTION_API UClass* StaticClass<UMyObject>()
{
    return UMyObject::StaticClass();
}
```

一样的，同一个文件的所有反射都会记录在这，这个文件只有一个类。

```cpp
struct Z_CompiledInDeferFile_FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Object_MyObject_h_Statics
{
    static constexpr FClassRegisterCompiledInInfo ClassInfo[] = {
        { Z_Construct_UClass_UMyObject,
        UMyObject::StaticClass,
        TEXT("UMyObject"),
        &Z_Registration_Info_UClass_UMyObject,
        CONSTRUCT_RELOAD_VERSION_INFO(FClassReloadVersionInfo, sizeof(UMyObject), 1556497845U)},
    };
};
struct FClassRegisterCompiledInInfo
{
    class UClass* (*OuterRegister)();
    class UClass* (*InnerRegister)();
    const TCHAR* Name;
    FClassRegistrationInfo* Info;
    FClassReloadVersionInfo VersionInfo;
};
```

最终注册。

```cpp
static FRegisterCompiledInInfo Z_CompiledInDeferFile_FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Object_MyObject_h_1505249514(
    TEXT("/Script/Reflection"),
    Z_CompiledInDeferFile_FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Object_MyObject_h_Statics::ClassInfo,
    UE_ARRAY_COUNT(Z_CompiledInDeferFile_FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Object_MyObject_h_Statics::ClassInfo),
    nullptr,
    0,
    nullptr,
    0
);
```

### Interface

先创建一个 Interface，并声明两个成员方法，两个方法皆能被蓝图和C++所调用，但其中一个只能被蓝图实现。

```cpp
// This class does not need to be modified.
UINTERFACE(MinimalAPI)
class UMyInterface : public UInterface
{
    GENERATED_BODY()
};
class REFLECTION_API IMyInterface
{
    GENERATED_BODY()
public:
    // 仅能在蓝图实现
    UFUNCTION(BlueprintCallable, BlueprintImplementableEvent )
    void IBlueprintImplementableEvent();
    // 可在C++或蓝图实现
    UFUNCTION(BlueprintCallable, BlueprintNativeEvent)
    void IBlueprintNativeEvent();
};
```

随后创建一个 Class 实现 该 Interface。

```cpp
UCLASS()
class REFLECTION_API UMyInterfaceObj : public UObject, public IMyInterface
{
    GENERATED_BODY()
public:
    void IBlueprintNativeEvent_Implementation() override {}
};
```

`UMyInterface` 这个 UE 自动帮我们生成的 Class 可以跳过，因为和上面讲过得 Class 一样的逻辑。

而 `IMyInterface` 的 `GENERATED_BODY()` 最终会生成如下代码。

```cpp
#define FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Interface_MyInterface_h_13_RPC_WRAPPERS_NO_PURE_DECLS \
    virtual void IBlueprintNativeEvent_Implementation() {}; \
    DECLARE_FUNCTION(execIBlueprintNativeEvent);
#define FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Interface_MyInterface_h_13_CALLBACK_WRAPPERS

#define FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Interface_MyInterface_h_13_INCLASS_IINTERFACE_NO_PURE_DECLS \
protected: \
    virtual ~IMyInterface() {} \
public: \
    typedef UMyInterface UClassType; \
    typedef IMyInterface ThisClass; \
    static void Execute_IBlueprintImplementableEvent(UObject* O); \
    static void Execute_IBlueprintNativeEvent(UObject* O); \
    virtual UObject* _getUObject() const { return nullptr; }

#define FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Interface_MyInterface_h_10_PROLOG
#define FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Interface_MyInterface_h_21_GENERATED_BODY \
public: \
    FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Interface_MyInterface_h_13_RPC_WRAPPERS_NO_PURE_DECLS \
    FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Interface_MyInterface_h_13_CALLBACK_WRAPPERS \
    FID_Users_yuerer_Desktop_reflection_Source_Reflection_Public_Interface_MyInterface_h_13_INCLASS_IINTERFACE_NO_PURE_DECLS \
private:
```

将其展开后得到：

```cpp
class REFLECTION_API IMyInterface
{
public:
    // 供 C++ 实现该接口
    virtual void IBlueprintNativeEvent_Implementation() {};
    // 供蓝图 调用 C++ 接口, 因为 BlueprintNativeEvent 可以在 C++ 中实现
    static void execIBlueprintNativeEvent( UObject* Context, FFrame& Stack, RESULT_DECL );
protected:
    virtual ~IMyInterface() {}
public:
    typedef UMyInterface UClassType;
    typedef IMyInterface ThisClass;
    // 供 C++ 调用 蓝图接口, 这里的 UObject 就是 UMyInterface
    static void Execute_IBlueprintImplementableEvent(UObject* O);
    static void Execute_IBlueprintNativeEvent(UObject* O);
    virtual UObject* _getUObject() const { return nullptr; }
public:
    void IBlueprintImplementableEvent();
    void IBlueprintNativeEvent();
};
```

`gen.cpp` 中的内容如下：

先是 `IBlueprintImplementableEvent` 相关的反射内容。

`BlueprintImplement` 的接口 默认生成一个检测函数，避免C++直接调用原来的函数，因为无论是C++还是蓝图调用的接口都是被改名过的 thunk 函数。

```cpp
void IMyInterface::IBlueprintImplementableEvent()
{
    check(0 && "Do not directly call Event functions in Interfaces. Call Execute_IBlueprintImplementableEvent instead.");
}
```

但需要让C++能够调用到蓝图实现的接口。

```cpp
static FName NAME_UMyInterface_IBlueprintImplementableEvent = FName(TEXT("IBlueprintImplementableEvent"));
void IMyInterface::Execute_IBlueprintImplementableEvent(UObject* O)
{
    check(O != NULL);
    check(O->GetClass()->ImplementsInterface(UMyInterface::StaticClass()));
    UFunction* const Func = O->FindFunction(NAME_UMyInterface_IBlueprintImplementableEvent);
    if (Func)
    {
        O->ProcessEvent(Func, NULL);
    }
}
```

构造 `IBlueprintImplementableEvent` 这个 UFunction 。

```cpp
const UECodeGen_Private::FFunctionParams Z_Construct_UFunction_UMyInterface_IBlueprintImplementableEvent_Statics::FuncParams = { (UObject*(*)())Z_Construct_UClass_UMyInterface, nullptr, "IBlueprintImplementableEvent", nullptr, nullptr, nullptr, 0, 0, RF_Public|RF_Transient|RF_MarkAsNative, (EFunctionFlags)0x0C020800, 0, 0, METADATA_PARAMS(UE_ARRAY_COUNT(Z_Construct_UFunction_UMyInterface_IBlueprintImplementableEvent_Statics::Function_MetaDataParams), Z_Construct_UFunction_UMyInterface_IBlueprintImplementableEvent_Statics::Function_MetaDataParams) };
UFunction* Z_Construct_UFunction_UMyInterface_IBlueprintImplementableEvent()
{
    static UFunction* ReturnFunction = nullptr;
    if (!ReturnFunction)
    {
        UECodeGen_Private::ConstructUFunction(&ReturnFunction, Z_Construct_UFunction_UMyInterface_IBlueprintImplementableEvent_Statics::FuncParams);
    }
    return ReturnFunction;
}
```

另一个接口 `IBlueprintNativeEvent` ，同样需要避免被直接调用。

```cpp
void IMyInterface::IBlueprintNativeEvent()
{
    check(0 && "Do not directly call Event functions in Interfaces. Call Execute_IBlueprintNativeEvent instead.");
}
```

既可以被蓝图实现，也能被C++实现，所以都要判断一下，不过可以看出如果蓝图有实现，优先用蓝图的实现。

```cpp
static FName NAME_UMyInterface_IBlueprintNativeEvent = FName(TEXT("IBlueprintNativeEvent"));
void IMyInterface::Execute_IBlueprintNativeEvent(UObject* O)
{
    check(O != NULL);
    check(O->GetClass()->ImplementsInterface(UMyInterface::StaticClass()));
    UFunction* const Func = O->FindFunction(NAME_UMyInterface_IBlueprintNativeEvent);
    if (Func)
    {
        O->ProcessEvent(Func, NULL);
    }
    else if (auto I = (IMyInterface*)(O->GetNativeInterfaceAddress(UMyInterface::StaticClass())))
    {
        I->IBlueprintNativeEvent_Implementation();
    }
}
```

构造该 UFunction 的辅助函数。

```cpp
UFunction* Z_Construct_UFunction_UMyInterface_IBlueprintNativeEvent()
{
    static UFunction* ReturnFunction = nullptr;
    if (!ReturnFunction)
    {
        UECodeGen_Private::ConstructUFunction(&ReturnFunction, Z_Construct_UFunction_UMyInterface_IBlueprintNativeEvent_Statics::FuncParams);
    }
    return ReturnFunction;
}
```

最后由于这个接口可以被蓝图调用，需要提供一个蓝图调用接口。

```cpp
void IMyInterface::execInterfaceBlueprintNativeEvent( UObject* Context, FFrame& Stack, RESULT_DECL )
{
    P_FINISH;
    P_NATIVE_BEGIN;
    P_THIS->IBlueprintNativeEvent_Implementation();
    P_NATIVE_END;
}
```

最后则是将C++可实现的接口注册到 `UMyInterface` 这个UE自动帮我们生成的 Object 中，这也就解释了为什么 Interface 需要生成一个 Object。

## 反射代码注册

在每个 `gen.cpp` 文件下都使用了一个 `FRegisterCompiledInInfo` struct，反射代码的注册都是通过这个结构体的构造函数进行。

```cpp
struct FRegisterCompiledInInfo
{
    template <typename ... Args>
    FRegisterCompiledInInfo(Args&& ... args)
    {
        RegisterCompiledInInfo(std::forward<Args>(args)...);
    }
};
```

每个文件最终都会进入这一统一的注册入口，然后将文件中的 `Class` `Stuct` `Enum` 分别注册进去。

```cpp
void RegisterCompiledInInfo(const TCHAR* PackageName, const FClassRegisterCompiledInInfo* ClassInfo, size_t NumClassInfo, const FStructRegisterCompiledInInfo* StructInfo, size_t NumStructInfo, const FEnumRegisterCompiledInInfo* EnumInfo, size_t NumEnumInfo)
{
    for (size_t Index = 0; Index < NumClassInfo; ++Index)
    {
        const FClassRegisterCompiledInInfo& Info = ClassInfo[Index];
        RegisterCompiledInInfo(Info.OuterRegister, Info.InnerRegister, PackageName, Info.Name, *Info.Info, Info.VersionInfo);
    }

    for (size_t Index = 0; Index < NumStructInfo; ++Index)
    {
        const FStructRegisterCompiledInInfo& Info = StructInfo[Index];
        RegisterCompiledInInfo(Info.OuterRegister, PackageName, Info.Name, *Info.Info, Info.VersionInfo);
        if (Info.CreateCppStructOps != nullptr)
        {
            UScriptStruct::DeferCppStructOps(FTopLevelAssetPath(FName(PackageName), FName(Info.Name)), (UScriptStruct::ICppStructOps*)Info.CreateCppStructOps());
        }
    }

    for (size_t Index = 0; Index < NumEnumInfo; ++Index)
    {
        const FEnumRegisterCompiledInInfo& Info = EnumInfo[Index];
        RegisterCompiledInInfo(Info.OuterRegister, PackageName, Info.Name, *Info.Info, Info.VersionInfo);
    }
}
```

`Class` 版本的 RegisterCompiledInInfo：

大致就是将其加入到 `FClassDeferredRegistry` 列表中，同时发起一个事件记录这个 Class 和 这个Class 的 CDO 已添加，后续用来检查有哪些数据是未完成注册用的，后面不再强调了。

```cpp
void RegisterCompiledInInfo(class UClass* (*InOuterRegister)(), class UClass* (*InInnerRegister)(), const TCHAR* InPackageName, const TCHAR* InName, FClassRegistrationInfo& InInfo, const FClassReloadVersionInfo& InVersionInfo)
{
    FClassDeferredRegistry::AddResult result = FClassDeferredRegistry::Get().AddRegistration(InOuterRegister, InInnerRegister, InPackageName, InName, InInfo, InVersionInfo);

    FString NoPrefix(UObjectBase::RemoveClassPrefix(InName));
    NotifyRegistrationEvent(InPackageName, *NoPrefix, ENotifyRegistrationType::NRT_Class, ENotifyRegistrationPhase::NRP_Added, (UObject * (*)())(InOuterRegister), false);
    NotifyRegistrationEvent(InPackageName, *(FString(DEFAULT_OBJECT_PREFIX) + NoPrefix), ENotifyRegistrationType::NRT_ClassCDO, ENotifyRegistrationPhase::NRP_Added, (UObject * (*)())(InOuterRegister), false);
}
```

`Struct` 版本同理，记录到 `FStructDeferredRegistry` 中。

```cpp
void RegisterCompiledInInfo(class UScriptStruct* (*InOuterRegister)(), const TCHAR* InPackageName, const TCHAR* InName, FStructRegistrationInfo& InInfo, const FStructReloadVersionInfo& InVersionInfo)
{
    FStructDeferredRegistry::Get().AddRegistration(InOuterRegister, nullptr, InPackageName, InName, InInfo, InVersionInfo);
    NotifyRegistrationEvent(InPackageName, InName, ENotifyRegistrationType::NRT_Struct, ENotifyRegistrationPhase::NRP_Added, (UObject * (*)())(InOuterRegister), false);
}
```

`Enum` 同理。

```cpp
void RegisterCompiledInInfo(class UEnum* (*InOuterRegister)(), const TCHAR* InPackageName, const TCHAR* InName, FEnumRegistrationInfo& InInfo, const FEnumReloadVersionInfo& InVersionInfo)
{
    FEnumDeferredRegistry::Get().AddRegistration(InOuterRegister, nullptr, InPackageName, InName, InInfo, InVersionInfo);
    NotifyRegistrationEvent(InPackageName, InName, ENotifyRegistrationType::NRT_Enum, ENotifyRegistrationPhase::NRP_Added, (UObject * (*)())(InOuterRegister), false);
}
```

这些反射数据采集完成后，会在引擎初始化时，调用 `ProcessNewlyLoadedUObjects` 方法。

```cpp
void ProcessNewlyLoadedUObjects(FName Package, bool bCanProcessNewlyLoadedObjects)
{
    FPackageDeferredRegistry& PackageRegistry = FPackageDeferredRegistry::Get();
    FClassDeferredRegistry& ClassRegistry = FClassDeferredRegistry::Get();
    FStructDeferredRegistry& StructRegistry = FStructDeferredRegistry::Get();
    FEnumDeferredRegistry& EnumRegistry = FEnumDeferredRegistry::Get();

    UClassRegisterAllCompiledInClasses();
}
```

将所有的 Class 都进行注册，此处使用的 `InnerRegister` 。

```cpp
void UClassRegisterAllCompiledInClasses()
{
    FClassDeferredRegistry& Registry = FClassDeferredRegistry::Get();
    for (const FClassDeferredRegistry::FRegistrant& Registrant : Registry.GetRegistrations())
    {
        UClass* RegisteredClass = FClassDeferredRegistry::InnerRegister(Registrant);
    }
}
```

```cpp
static constexpr FClassRegisterCompiledInInfo ClassInfo[] = {
    { Z_Construct_UClass_UMyObject, // Outer
    UMyObject::StaticClass, // Inner
    TEXT("UMyObject"),
    &Z_Registration_Info_UClass_UMyObject,
    CONSTRUCT_RELOAD_VERSION_INFO(FClassReloadVersionInfo, sizeof(UMyObject), 1556497845U)},
};
```

此时调用 `InnerRegister` 本质就是调用 `UMyObject::StaticClass` ，最终调用的`GetPrivateStaticClass` 。

使用 `GUObjectAllocator` 分配内存，并使用 placement new 构造出该 Class，并设置属性。

`InitializePrivateStaticClass` 会调用 `Register` 将 Class 注册到 `GFirstPendingRegistrant` 链表中，这主要是为了之后能够保证每个 `Object` 都能被加入到一张全局的 Globals Table，最后注册 thunk 函数。这就把 Class Object 给构造出来了。

```cpp
void GetPrivateStaticClassBody(
	const TCHAR* PackageName,
	const TCHAR* Name,
	UClass*& ReturnClass,
	void(*RegisterNativeFunc)(),
	uint32 InSize,
	uint32 InAlignment,
	EClassFlags InClassFlags,
	EClassCastFlags InClassCastFlags,
	const TCHAR* InConfigName,
	UClass::ClassConstructorType InClassConstructor,
	UClass::ClassVTableHelperCtorCallerType InClassVTableHelperCtorCaller,
	FUObjectCppClassStaticFunctions&& InCppClassStaticFunctions,
	UClass::StaticClassFunctionType InSuperClassFn,
	UClass::StaticClassFunctionType InWithinClassFn
	)
{
    ReturnClass = (UClass*)GUObjectAllocator.AllocateUObject(sizeof(UClass), alignof(UClass), true);
    ReturnClass = ::new (ReturnClass)
        UClass
        (
        EC_StaticConstructor,
        Name,
        InSize,
        InAlignment,
        InClassFlags,
        InClassCastFlags,
        InConfigName,
        EObjectFlags(RF_Public | RF_Standalone | RF_Transient | RF_MarkAsNative | RF_MarkAsRootSet),
        InClassConstructor,
        InClassVTableHelperCtorCaller,
        MoveTemp(InCppClassStaticFunctions)
        );

    InitializePrivateStaticClass(
        InSuperClassFn(),
        ReturnClass,
        InWithinClassFn(),
        PackageName,
        Name
        );

    // Register the class's native functions.
    RegisterNativeFunc();
}
```

在本文中注册的是 `MyFunc` ，因为它需要被蓝图调用。

```cpp
void UMyObject::StaticRegisterNativesUMyObject()
{
    UClass* Class = UMyObject::StaticClass();
    static const FNameNativePtrPair Funcs[] = {
        { "MyFunc", &UMyObject::execMyFunc },
    };
    FNativeFunctionRegistrar::RegisterFunctions(Class, Funcs, UE_ARRAY_COUNT(Funcs));
}
```

回到 `ProcessNewlyLoadedUObjects` 中， `UObjectProcessRegistrants` 就是将之前放入链表的 `Object` 取出来并放入一张全局的 Objects Table，同时还会将该 `Class` 所属的 `Package` 提前创建好，但不初始化，这点尤为重要。这段逻辑在 `UObjectBase::DeferredRegister` 。

```cpp
void ProcessNewlyLoadedUObjects(FName Package, bool bCanProcessNewlyLoadedObjects)
{
    // ......
    UClassRegisterAllCompiledInClasses();

    bool bNewUObjects = false;
    TArray<UClass*> AllNewClasses;
    while (GFirstPendingRegistrant ||
        ClassRegistry.HasPendingRegistrations() ||
        StructRegistry.HasPendingRegistrations() ||
        EnumRegistry.HasPendingRegistrations())
    {
        bNewUObjects = true;
        UObjectProcessRegistrants();
        UObjectLoadAllCompiledInStructs();

        FCoreUObjectDelegates::CompiledInUObjectsRegisteredDelegate.Broadcast(Package);

        UObjectLoadAllCompiledInDefaultProperties(AllNewClasses);
    }
}
```

`DoPendingPackageRegistrations` 其实就会提前创建好 Package，和 Class 一样，提前创建好，但不初始化。

```cpp
static void UObjectLoadAllCompiledInStructs()
{
    FEnumDeferredRegistry& EnumRegistry = FEnumDeferredRegistry::Get();
    FStructDeferredRegistry& StructRegistry = FStructDeferredRegistry::Get();
    {
        SCOPED_BOOT_TIMING("UObjectLoadAllCompiledInStructs -  CreatePackages (could be optimized!)");
        // 创建 Package
        EnumRegistry.DoPendingPackageRegistrations();
        StructRegistry.DoPendingPackageRegistrations();
    }

    // Load Structs
    EnumRegistry.DoPendingOuterRegistrations(true);
    StructRegistry.DoPendingOuterRegistrations(true);
}
```

最后调用 `Enum` 和 `Struct` 的 OuterRegister。

```cpp
void DoPendingOuterRegistrations(bool UpdateCounter)
{
    int32 Num = Registrations.Num();
    for (int32 Index = ProcessedRegistrations; Index < Num; ++Index)
    {
        OuterRegister(Registrations[Index]);
    }

    if (UpdateCounter)
    {
        ProcessedRegistrations = Num;
    }
}
```

在这把 OuterRegister 取出来，方便阅读，无论是调用 `GetStaticEnum` 还是 `GetStaticStruct` 最后都是调用 `InnerRegister` ，但此处需要注意在这我们将 `UPackage` 给初始化了， `UPackage` 一定是先创建好 但不初始化，等到此处才初始化 `UPackage` 然后调用内部的 `InnerRegister` 将其构造出来。

```cpp
static UEnum* EMyEnumClass_StaticEnum()
{
    if (!Z_Registration_Info_UEnum_EMyEnumClass.OuterSingleton)
    {
        Z_Registration_Info_UEnum_EMyEnumClass.OuterSingleton = GetStaticEnum(
            Z_Construct_UEnum_Reflection_EMyEnumClass,
            (UObject*)Z_Construct_UPackage__Script_Reflection(),
            TEXT("EMyEnumClass")
        );
    }
    return Z_Registration_Info_UEnum_EMyEnumClass.OuterSingleton;
}

class UScriptStruct* FMyStruct::StaticStruct()
{
    if (!Z_Registration_Info_UScriptStruct_MyStruct.OuterSingleton)
    {
        Z_Registration_Info_UScriptStruct_MyStruct.OuterSingleton = GetStaticStruct(
            Z_Construct_UScriptStruct_FMyStruct,
            (UObject*)Z_Construct_UPackage__Script_Reflection(),
            TEXT("MyStruct")
        );
    }
    return Z_Registration_Info_UScriptStruct_MyStruct.OuterSingleton;
}
```

构造 `UEnum` ，调用 `SetEnums` 时会默认帮你加一个 `_MAX` 枚举项，同时将枚举注册到对应 `PackageName` 的 map 中。

```cpp
void ConstructUEnum(UEnum*& OutEnum, const FEnumParams& Params)
{
    UObject* (*OuterFunc)() = Params.OuterFunc;

    UObject* Outer = OuterFunc ? OuterFunc() : nullptr;

    if (OutEnum)
    {
        return;
    }

    UEnum* NewEnum = new (EC_InternalUseOnlyConstructor, Outer, UTF8_TO_TCHAR(Params.NameUTF8), Params.ObjectFlags) UEnum(FObjectInitializer());
    OutEnum = NewEnum;

    TArray<TPair<FName, int64>> EnumNames;
    EnumNames.Reserve(Params.NumEnumerators);
    for (const FEnumeratorParam* Enumerator = Params.EnumeratorParams, *EnumeratorEnd = Enumerator + Params.NumEnumerators; Enumerator != EnumeratorEnd; ++Enumerator)
    {
        EnumNames.Emplace(UTF8_TO_TCHAR(Enumerator->NameUTF8), Enumerator->Value);
    }

    const bool bAddMaxKeyIfMissing = true;
    NewEnum->SetEnums(EnumNames, (UEnum::ECppForm)Params.CppForm, Params.EnumFlags, bAddMaxKeyIfMissing);
    NewEnum->CppType = UTF8_TO_TCHAR(Params.CppTypeUTF8);

    if (Params.DisplayNameFunc)
    {
        NewEnum->SetEnumDisplayNameFn(Params.DisplayNameFunc);
    }
}
```

构造 `Struct` ， `ConstructFProperties` 构造里面的属性，属性没有数据，只有函数，属性的数据最终还是存放到 `Struct` 或者 `Class` 中，属性里面会记录数据存放的偏移值，计算偏移值的操作在 `StaticLink` 中实现，同时还会将 Property分类放到不同链表中，比如需要析构的 Property，需要构造后做一些事情的 Property(Config) 。

```cpp
void ConstructUScriptStruct(UScriptStruct*& OutStruct, const FStructParams& Params)
{
    UObject*                      (*OuterFunc)()     = Params.OuterFunc;
    UScriptStruct*                (*SuperFunc)()     = Params.SuperFunc;
    UScriptStruct::ICppStructOps* (*StructOpsFunc)() = (UScriptStruct::ICppStructOps* (*)())Params.StructOpsFunc;

    UObject*                      Outer     = OuterFunc     ? OuterFunc() : nullptr;
    UScriptStruct*                Super     = SuperFunc     ? SuperFunc() : nullptr;
    UScriptStruct::ICppStructOps* StructOps = StructOpsFunc ? StructOpsFunc() : nullptr;

    if (OutStruct)
    {
        return;
    }

    UScriptStruct* NewStruct = new(EC_InternalUseOnlyConstructor, Outer, UTF8_TO_TCHAR(Params.NameUTF8), Params.ObjectFlags) UScriptStruct(FObjectInitializer(), Super, StructOps, (EStructFlags)Params.StructFlags, Params.SizeOf, Params.AlignOf);
    OutStruct = NewStruct;

    ConstructFProperties(NewStruct, Params.PropertyArray, Params.NumProperties);

    NewStruct->StaticLink();
}
```

回到 `ProcessNewlyLoadedUObjects` 函数中，`UObjectLoadAllCompiledInDefaultProperties` 是最后一个重点函数，它执行了所有 Class 的 OuterRegister，同时通知该 Class 注册完成。

`DoPendingOuterRegistrations` 就是执行了 OuterRegister。

```cpp
static void UObjectLoadAllCompiledInDefaultProperties(TArray<UClass*>& OutAllNewClasses)
{
    static FName LongEnginePackageName(TEXT("/Script/Engine"));

    FClassDeferredRegistry& ClassRegistry = FClassDeferredRegistry::Get();

    if (ClassRegistry.HasPendingRegistrations())
    {
        SCOPED_BOOT_TIMING("UObjectLoadAllCompiledInDefaultProperties");
        TArray<UClass*> NewClasses;
        TArray<UClass*> NewClassesInCoreUObject;
        TArray<UClass*> NewClassesInEngine;
        ClassRegistry.DoPendingOuterRegistrations(true, [&OutAllNewClasses, &NewClasses, &NewClassesInCoreUObject, &NewClassesInEngine](const TCHAR* PackageName, UClass& Class) -> void
            {
                UE_LOG(LogUObjectBootstrap, Verbose, TEXT("UObjectLoadAllCompiledInDefaultProperties After Registrant %s %s"), PackageName, *Class.GetName());

                if (Class.GetOutermost()->GetFName() == GLongCoreUObjectPackageName)
                {
                    NewClassesInCoreUObject.Add(&Class);
                }
                else if (Class.GetOutermost()->GetFName() == LongEnginePackageName)
                {
                    NewClassesInEngine.Add(&Class);
                }
                else
                {
                    NewClasses.Add(&Class);
                }

                OutAllNewClasses.Add(&Class);
            }); 

        auto NotifyClassFinishedRegistrationEvents = [](TArray<UClass*>& Classes)
        {
            for (UClass* Class : Classes)
            {
                TCHAR PackageName[FName::StringBufferSize];
                TCHAR ClassName[FName::StringBufferSize];
                Class->GetOutermost()->GetFName().ToString(PackageName);
                Class->GetFName().ToString(ClassName);
                NotifyRegistrationEvent(PackageName, ClassName, ENotifyRegistrationType::NRT_Class, ENotifyRegistrationPhase::NRP_Finished, nullptr, false, Class);
            }
        };

        // notify async loader of all new classes before creating the class default objects
        {
            SCOPED_BOOT_TIMING("NotifyClassFinishedRegistrationEvents");
            NotifyClassFinishedRegistrationEvents(NewClassesInCoreUObject);
            NotifyClassFinishedRegistrationEvents(NewClassesInEngine);
            NotifyClassFinishedRegistrationEvents(NewClasses);
        }

        {
            SCOPED_BOOT_TIMING("CoreUObject Classes");
            for (UClass* Class : NewClassesInCoreUObject) // we do these first because we assume these never trigger loads
            {
                UE_LOG(LogUObjectBootstrap, Verbose, TEXT("GetDefaultObject Begin %s %s"), *Class->GetOutermost()->GetName(), *Class->GetName());
                Class->GetDefaultObject();
                UE_LOG(LogUObjectBootstrap, Verbose, TEXT("GetDefaultObject End %s %s"), *Class->GetOutermost()->GetName(), *Class->GetName());
            }
        }
        {
            SCOPED_BOOT_TIMING("Engine Classes");
            for (UClass* Class : NewClassesInEngine) // we do these second because we want to bring the engine up before the game
            {
                UE_LOG(LogUObjectBootstrap, Verbose, TEXT("GetDefaultObject Begin %s %s"), *Class->GetOutermost()->GetName(), *Class->GetName());
                Class->GetDefaultObject();
                UE_LOG(LogUObjectBootstrap, Verbose, TEXT("GetDefaultObject End %s %s"), *Class->GetOutermost()->GetName(), *Class->GetName());
            }
        }
        {
            SCOPED_BOOT_TIMING("Other Classes");
            for (UClass* Class : NewClasses)
            {
                UE_LOG(LogUObjectBootstrap, Verbose, TEXT("GetDefaultObject Begin %s %s"), *Class->GetOutermost()->GetName(), *Class->GetName());
                Class->GetDefaultObject();
                UE_LOG(LogUObjectBootstrap, Verbose, TEXT("GetDefaultObject End %s %s"), *Class->GetOutermost()->GetName(), *Class->GetName());
            }
        }
    }
}
```

Class 的 OuterRegister 如下：

```cpp
UClass* Z_Construct_UClass_UMyObject()
{
    if (!Z_Registration_Info_UClass_UMyObject.OuterSingleton)
    {
        UECodeGen_Private::ConstructUClass(Z_Registration_Info_UClass_UMyObject.OuterSingleton, Z_Construct_UClass_UMyObject_Statics::ClassParams);
    }
    return Z_Registration_Info_UClass_UMyObject.OuterSingleton;
}
```

其实就是执行依赖项，然后通过 InnerRegister 创建一个新类， `UObjectForceRegistration` 注册到全局 Objects Table 中。 `CreateLinkAndAddChildFunctionsToMap` 其实就是执行 `ConstructUFunction` 来创建一个个成员函数，并将其加入到 `FuncMap` ，随后构建属性，并 Link，这部分逻辑和 `Struct` 一致。

```cpp
void ConstructUClass(UClass*& OutClass, const FClassParams& Params)
{
    if (OutClass && (OutClass->ClassFlags & CLASS_Constructed))
    {
        return;
    }

    for (UObject* (*const *SingletonFunc)() = Params.DependencySingletonFuncArray, *(*const *SingletonFuncEnd)() = SingletonFunc + Params.NumDependencySingletons; SingletonFunc != SingletonFuncEnd; ++SingletonFunc)
    {
        (*SingletonFunc)();
    }

    UClass* NewClass = Params.ClassNoRegisterFunc();
    OutClass = NewClass;

    if (NewClass->ClassFlags & CLASS_Constructed)
    {
        return;
    }

    UObjectForceRegistration(NewClass);

    UClass* SuperClass = NewClass->GetSuperClass();
    if (SuperClass)
    {
        NewClass->ClassFlags |= (SuperClass->ClassFlags & CLASS_Inherit);
    }

    NewClass->ClassFlags |= (EClassFlags)(Params.ClassFlags | CLASS_Constructed);
    // Make sure the reference token stream is empty since it will be reconstructed later on
    // This should not apply to intrinsic classes since they emit native references before AssembleReferenceTokenStream is called.
    if ((NewClass->ClassFlags & CLASS_Intrinsic) != CLASS_Intrinsic)
    {
        check((NewClass->ClassFlags & CLASS_TokenStreamAssembled) != CLASS_TokenStreamAssembled);
        NewClass->ReferenceSchema.Reset();
    }
    NewClass->CreateLinkAndAddChildFunctionsToMap(Params.FunctionLinkArray, Params.NumFunctions);

    ConstructFProperties(NewClass, Params.PropertyArray, Params.NumProperties);

    if (Params.ClassConfigNameUTF8)
    {
        NewClass->ClassConfigName = FName(UTF8_TO_TCHAR(Params.ClassConfigNameUTF8));
    }

    NewClass->SetCppTypeInfoStatic(Params.CppClassInfo);

    if (int32 NumImplementedInterfaces = Params.NumImplementedInterfaces)
    {
        NewClass->Interfaces.Reserve(NumImplementedInterfaces);
        for (const FImplementedInterfaceParams* ImplementedInterface = Params.ImplementedInterfaceArray, *ImplementedInterfaceEnd = ImplementedInterface + NumImplementedInterfaces; ImplementedInterface != ImplementedInterfaceEnd; ++ImplementedInterface)
        {
            UClass* (*ClassFunc)() = ImplementedInterface->ClassFunc;
            UClass* InterfaceClass = ClassFunc ? ClassFunc() : nullptr;

            NewClass->Interfaces.Emplace(InterfaceClass, ImplementedInterface->Offset, ImplementedInterface->bImplementedByK2);
        }
    }

    NewClass->StaticLink();

    NewClass->SetSparseClassDataStruct(NewClass->GetSparseClassDataArchetypeStruct());
}
```

```cpp
UFunction* Z_Construct_UFunction_UMyObject_MyFunc()
{
    static UFunction* ReturnFunction = nullptr;
    if (!ReturnFunction)
    {
        UECodeGen_Private::ConstructUFunction(&ReturnFunction, Z_Construct_UFunction_UMyObject_MyFunc_Statics::FuncParams);
    }
    return ReturnFunction;
}
```

构造 `UFunction` 的内容就不细说了，Function 的 RPCId 就是在这里设置的，因为 Function 也是有参数的，所以也需要 `StaticLink`。最后将 Function Bind 到 Outer 身上，也就是 Class 身上。

```cpp
FORCEINLINE void ConstructUFunctionInternal(UFunction*& OutFunction, const FFunctionParams& Params, UFunction** SingletonPtr)
{
    UObject*   (*OuterFunc)() = Params.OuterFunc;
    UFunction* (*SuperFunc)() = Params.SuperFunc;

    UObject*   Outer = OuterFunc ? OuterFunc() : nullptr;
    UFunction* Super = SuperFunc ? SuperFunc() : nullptr;

    if (OutFunction)
    {
        return;
    }

    FName FuncName(UTF8_TO_TCHAR(Params.NameUTF8));

    UFunction* NewFunction;
    if (Params.FunctionFlags & FUNC_Delegate)
    {
        if (Params.OwningClassName == nullptr)
        {
            NewFunction = new (EC_InternalUseOnlyConstructor, Outer, FuncName, Params.ObjectFlags) UDelegateFunction(
                FObjectInitializer(),
                Super,
                Params.FunctionFlags,
                Params.StructureSize
            );
        }
        else
        {
            USparseDelegateFunction* NewSparseFunction = new (EC_InternalUseOnlyConstructor, Outer, FuncName, Params.ObjectFlags) USparseDelegateFunction(
                FObjectInitializer(),
                Super,
                Params.FunctionFlags,
                Params.StructureSize
            );
            NewSparseFunction->OwningClassName = FName(Params.OwningClassName);
            NewSparseFunction->DelegateName = FName(Params.DelegateName);
            NewFunction = NewSparseFunction;
        }
    }
    else
    {
        NewFunction = new (EC_InternalUseOnlyConstructor, Outer, FuncName, Params.ObjectFlags) UFunction(
            FObjectInitializer(),
            Super,
            Params.FunctionFlags,
            Params.StructureSize
        );
    }
    OutFunction = NewFunction;

    NewFunction->RPCId = Params.RPCId;
    NewFunction->RPCResponseId = Params.RPCResponseId;

    ConstructFProperties(NewFunction, Params.PropertyArray, Params.NumProperties);

    NewFunction->Bind();
    NewFunction->StaticLink();
}
```

最后是 `UPackage` 的注册。

```cpp
static FPackageRegistrationInfo Z_Registration_Info_UPackage__Script_Reflection;
FORCENOINLINE UPackage* Z_Construct_UPackage__Script_Reflection()
{
    if (!Z_Registration_Info_UPackage__Script_Reflection.OuterSingleton)
    {
        static const UECodeGen_Private::FPackageParams PackageParams = {
            "/Script/Reflection",
            nullptr,
            0,
            PKG_CompiledIn | 0x00000000,
            0xC0294C5F,
            0x8700445F,
            METADATA_PARAMS(0, nullptr)
        };
        UECodeGen_Private::ConstructUPackage(Z_Registration_Info_UPackage__Script_Reflection.OuterSingleton, PackageParams);
    }
    return Z_Registration_Info_UPackage__Script_Reflection.OuterSingleton;
}
struct FPackageParams
{
    const char*                        NameUTF8;
    UObject*                  (*const *SingletonFuncArray)();
    int32                              NumSingletons;
    uint32                             PackageFlags; // EPackageFlags
    uint32                             BodyCRC;
    uint32                             DeclarationsCRC;
#if WITH_METADATA
    uint16                             NumMetaData;
    const FMetaDataPairParam*          MetaDataArray;
#endif
};
```

```cpp
static FRegisterCompiledInInfo Z_CompiledInDeferPackage_UPackage__Script_Reflection(
    Z_Construct_UPackage__Script_Reflection,
    TEXT("/Script/Reflection"),
    Z_Registration_Info_UPackage__Script_Reflection,
    CONSTRUCT_RELOAD_VERSION_INFO(FPackageReloadVersionInfo, 0xC0294C5F, 0x8700445F
);
```

`Package` 不是这个时候创建出来的，而是创建 `Enum` 等其他类型时，就提前创建好了，所以此处只是找出来。此处的 `SingletonFuncArray` 就是 `Delegate` 同一个代码包里的所有 `Delegate` 最终都会归集到这，可以看出它也是 `Object` 。

```cpp
void ConstructUPackage(UPackage*& OutPackage, const FPackageParams& Params)
{
    if (OutPackage)
    {
        return;
    }

    UObject* FoundPackage = StaticFindObjectFast(UPackage::StaticClass(), nullptr, FName(UTF8_TO_TCHAR(Params.NameUTF8)), false);

    checkf(FoundPackage, TEXT("Code not found for generated code (package %s)."), UTF8_TO_TCHAR(Params.NameUTF8));

    UPackage* NewPackage = CastChecked<UPackage>(FoundPackage);
    OutPackage = NewPackage;

    NewPackage->SetPackageFlags(Params.PackageFlags);

    TCHAR PackageName[FName::StringBufferSize];
    NewPackage->GetFName().ToString(PackageName);
    for (UObject* (*const *SingletonFunc)() = Params.SingletonFuncArray, *(*const *SingletonFuncEnd)() = SingletonFunc + Params.NumSingletons; SingletonFunc != SingletonFuncEnd; ++SingletonFunc)
    {
        UObject* Object = (*SingletonFunc)();

        if (Object->GetOuter() == NewPackage)
        {
            // Notify loader of new top level noexport objects like UScriptStruct, UDelegateFunction and USparseDelegateFunction
            TCHAR ObjectName[FName::StringBufferSize];
            Object->GetFName().ToString(ObjectName);
            NotifyRegistrationEvent(PackageName, ObjectName, ENotifyRegistrationType::NRT_NoExportObject, ENotifyRegistrationPhase::NRP_Finished, nullptr, false, Object);
        }
    }
}
```

## 总结

C++ 代码会被 UHT 工具扫描，并将相应的宏替换为辅助代码，同时去掉空宏，最终每个文件都会有一个 `FRegisterCompiledInfo` 的 static struct，执行该构造函数后，将反射信息全都注册到 `TDeferredRegistry` 中。

注册完成之后，引擎启动时，会调用到 `ProcessNewlyLoadedUObject` 。

1. 构建 Class 的 Inner，并创建对应的 Package。
2. 构建 Enum 和 Struct 的 Outer，Outer 会立刻构建 Inner。
3. 构建 Class 的 Outer，构建里面的属性和成员函数。
4. 通知构建完成，在 `NotifyRegistrationComplete` 检查是否都完成创建。