---
title: UE5 UnLua 脚本方案原理
categories: UE
date: 2025-10-24 23:21:20
keywords: UE5, UnLua
tags: [UE5, UnLua]
---

本文剖析 UnLua 是如何将 Lua 接入到 UE5中。尽可能少贴代码，将部分 Lua C API 的操作转为 Lua 伪代码，同时每个小节只关注主线内容，方便阅读和理解。
## 对象绑定
本小节只关注当 UE5 创建一个对象时，是如何将其和 Lua 脚本给绑定起来的。
### 1. 创建虚拟机
我们需要创建一个 Lua 虚拟机来执行游戏逻辑，但有时又希望每个 `GameInstance` 各自拥有自己的虚拟机，这样会更方便调试和管理，这就意味着需要确定每个 `Object` 会被分配到哪个虚拟机（以后为和代码保持一致，会简称为 `Env`），抽象出 `ULuaEnvLocator`  用于定位 `Object` 所属 `Env`，并创建 `Env`，`Env` 的一些简单操作会封装到 `FLuaEnv` 中。
大部分情况下，只需认为整个客户端只会开启一个 Lua 虚拟机就可以了，基于这个前提，甚至可以去掉这个类。
```c++
class UNLUA_API ULuaEnvLocator : public UObject
{
    GENERATED_BODY()
public:
    virtual UnLua::FLuaEnv* Locate(const UObject* Object);
    TSharedPtr<UnLua::FLuaEnv, ESPMode::ThreadSafe> Env;
};
```
定位当前 Object 属于哪个 Env
```c++
EnvLocator = NewObject<ULuaEnvLocator>(GetTransientPackage(), EnvLocatorClass);
const auto Env = EnvLocator->Locate(Class);
```
从以上代码能看出 `FLuaEnv` 就是虚拟机本身的封装类。
### 2. 绑定 UE 反射对象到 Lua
通过继承以下两个类，来进行监听当前创建、销毁哪些 `UObject` ，从而实现绑定，内部实现为了解耦，会在多处监听。
```C++
class FUnLuaModule : public IUnLuaModule,  
                     public FUObjectArray::FUObjectCreateListener,  
                     public FUObjectArray::FUObjectDeleteListener

GUObjectArray.AddUObjectCreateListener(this);
GUObjectArray.AddUObjectDeleteListener(this);
```
知道了哪些对象创建出来后，还需要知道该对象跟哪份 Lua 文件进行绑定，`Unlua` 有好几种方案，第一种是最好理解的，要求实现 `IUnLuaInterface` 接口：
```c++
class UNLUA_API IUnLuaInterface
{
    GENERATED_BODY()
public:
    UFUNCTION(BlueprintNativeEvent)
    FString GetModuleName() const;
};
```

<!-- more -->

`UnLua` 能通过`GetModuleName` 得知当前对象绑定的 Lua Module Path。
但这样又不够灵活，最好是通过一个字符串路径告知我创建的对象绑定哪份 Lua 文件最好，因此 引出了 `FLuaDynamicBinding` 这个动态绑定辅助类，支持你在 Lua 中写出以下代码：
```lua
NewObject(WidgetClass, self, nil, "Tutorials.IconWidget")
```
本质是个栈结构。此处不重要，只是个扩展，这是第二种方案。
```c++
struct FLuaDynamicBinding
{
    struct FLuaDynamicBindingStackNode
    {
        UClass *Class;
        FString ModuleName;
        int32 InitializerTableRef;
    };
    TArray<FLuaDynamicBindingStackNode> Stack;
};
```
#### 尝试绑定
尝试绑定逻辑很简单，一个是避免该 `Object` 是旧的（编辑器模式下），另一个是避免是骨架类（`SKEL` 如有疑问，可以看看蓝图编译）。
```c++
bool FLuaEnv::TryBind(UObject* Object)
{
    const auto Class = Object->IsA<UClass>() ? static_cast<UClass*>(Object) : Object->GetClass();
    if (Class->HasAnyClassFlags(CLASS_NewerVersionExists))
    {
        return false;
    }

    static UClass* InterfaceClass = UUnLuaInterface::StaticClass();
    const bool bImplUnluaInterface = Class->ImplementsInterface(InterfaceClass);

    if (IsInAsyncLoadingThread())
    {
        if (bImplUnluaInterface || (!bImplUnluaInterface && GLuaDynamicBinding.IsValid(Class)))
        {
            FScopeLock Lock(&CandidatesLock);
            Candidates.AddUnique(Object);
            return false;
        }
    }

    if (!bImplUnluaInterface)
    {
        if (!GLuaDynamicBinding.IsValid(Class))
            return false;

        return GetManager()->Bind(Object, *GLuaDynamicBinding.ModuleName, GLuaDynamicBinding.InitializerTableRef);
    }

    if (Class->GetName().Contains(TEXT("SKEL_")))
        return false;

    const auto ModuleName = ModuleLocator->Locate(Object);
    if (ModuleName.IsEmpty())
        return false;
        
	return GetManager()->Bind(Object, *ModuleName, GLuaDynamicBinding.InitializerTableRef);
```
最后是我们在静态绑定下需要调用 `GetModuleName` ，这个操作被封装到了 `ModuleLocator` 中。之所以需要封装，是作者希望提供一种根据蓝图资源的路径映射到对应 Lua 文件路径的方式，省的每个文件都需要自己实现一下那个 `GetModuleName` 接口，初次阅读的读者可以忽略，只需要知道有这种用法即可。
```c++
FString ULuaModuleLocator::Locate(const UObject* Object)
{
    const UObject* CDO;
    if (Object->HasAnyFlags(RF_ClassDefaultObject | RF_ArchetypeObject))
    {
        CDO = Object;
    }
    else
    {
        const auto Class = Cast<UClass>(Object);
        CDO = Class ? Class->GetDefaultObject() : Object->GetClass()->GetDefaultObject();
    }
    // 各种检查...
    return IUnLuaInterface::Execute_GetModuleName(CDO);
}
```
#### 导出类描述
现在我们认为这个对象可以被绑定了。
在 UE 的反射系统里：
> **`UClass` 是“类的对象（类的描述体）”，`UObject` 是“实例”。**

也就是说，`UClass` 自身就是一个 `UObject`，但代表的是“类型”，而不是“实体对象”。
因此假定我要绑定 `AMyActor`，首先要把 `UClass(AMyActor)` 的信息导出出去，作为 `AMyActor` 这个实例的 `Metatable`，进而能访问该类的属性、方法。
```c++
bool UUnLuaManager::Bind(UObject *Object, const TCHAR *InModuleName, int32 InitializerTableRef)
{
    const auto Class = Object->IsA<UClass>() ? static_cast<UClass*>(Object) : Object->GetClass();
    lua_State *L = Env->GetMainState();
    if (!Env->GetClassRegistry()->Register(Class))
        return false;
```
此处逻辑过长，有兴趣的读者可以去阅读 `FClassRegistry` 这个类，它会绑定以下 `MetaMethod`：
```c++
/**
 * Functions to handle UClass */
int32 Class_Index(lua_State* L);
int32 Class_NewIndex(lua_State* L);
int32 Class_StaticClass(lua_State *L);
int32 Class_Cast(lua_State* L);

/**
 * Functions to handle UScriptStruct */
int32 ScriptStruct_Index(lua_State *L);
int32 ScriptStruct_New(lua_State *L);
int32 ScriptStruct_Delete(lua_State *L);
int32 ScriptStruct_Copy(lua_State *L);
int32 ScriptStruct_CopyFrom(lua_State *L);
int32 ScriptStruct_Compare(lua_State *L);
```
值得注意的是，它允许你通过 `TExportedClassBase` 来增加属性、函数，这样就能用来补充要导出的类，无论是否是反射类，一旦发现 Export 它会递归的将父类先进行注册。
此处我觉得有必要多说几句，假定我们有个 `AMyActor` 它的父类是 `AActor`，若你没有为 `AActor` 导出到 Lua 的话，它是不会将递归走进去的 `ExportedClass = nullptr` 。
```c++
TArray<IExportedClass*> ExportedClasses;
for (int32 i = ClassDescChain.Num() - 1; i > -1; --i)
{
    auto ExportedClass = FindExportedReflectedClass(*ClassDescChain[i]->GetName());
    if (ExportedClass)
        ExportedClass->Register(L);
}
```
#### 加载 Lua 模块
`UnLua::Call` 封装了一些简单的 Lua 操作，调用了 `require "InModuleName"` ，获取到覆写的 Lua Table，为了篇幅简单，本文不会提及任何关于 Lua C API 封装的剖析，因为没有意义，现在的AI都很好用了。
```c++
UnLua::FLuaRetValues RetValues = UnLua::Call(L, "require", TCHAR_TO_UTF8(InModuleName));

BindClass(Class, InModuleName, Error);
```
#### 重写函数
加载到了 Lua 模块，就要让 UE5 的函数路径能够执行到 Lua，换句话说就是 Lua 函数能覆盖 UE5 的函数。
首先完整的拷贝一份 Lua Module Table 出来，作为实例的 Metatable，并将其存入 Lua 注册表里，保持强引用，因为可能会有多个实例，比如多个 `AMyActor` 绑定同一个 Lua Module Table，为了防止 Metatable 被更改，自然就会拷贝多份 Lua Module Table。
```c++
bool UUnLuaManager::BindClass(UClass* Class, const FString& InModuleName, FString& Error)
{
    if (Class->HasAnyFlags(RF_NeedPostLoad | RF_NeedPostLoadSubobjects))
        return false;

    const auto  L = Env->GetMainState();
    const auto Top = lua_gettop(L);
    const auto Type = UnLua::LowLevel::GetLoadedModule(L, TCHAR_TO_UTF8(*InModuleName));

    if (!Class->IsChildOf<UBlueprintFunctionLibrary>())
    {
        lua_newtable(L);
        lua_pushnil(L);
        while (lua_next(L, -3) != 0)
        {
            lua_pushvalue(L, -2);
            lua_insert(L, -2);
            lua_settable(L, -4);
        }
    }

    lua_pushvalue(L, -1);
    const auto Ref = luaL_ref(L, LUA_REGISTRYINDEX);
    lua_settop(L, Top);

    auto& BindInfo = Classes.Add(Class);
    BindInfo.Class = Class;
    BindInfo.ModuleName = InModuleName;
    BindInfo.TableRef = Ref;
```
找出所有的 Lua 函数和可重写的 UE 函数，使用 `ULuaFunction` 来替换掉原本 `UFunction`。
```c++
UnLua::LowLevel::GetFunctionNames(Env->GetMainState(), Ref, BindInfo.LuaFunctions);
ULuaFunction::GetOverridableFunctions(Class, BindInfo.UEFunctions);

// 用LuaTable里所有的函数来替换Class上对应的UFunction
for (const auto& LuaFuncName : BindInfo.LuaFunctions)
{
    UFunction** Func = BindInfo.UEFunctions.Find(LuaFuncName);
    if (Func)
    {
        UFunction* Function = *Func;
        ULuaFunction::Override(Function, Class, LuaFuncName);
    }
}
```
此时函数已经替换完成，为了保证思路连贯，此处暂时不解释是怎么替换掉 `UFunction` 的，先暂时认为它就能做到，后面会有详细分析。
#### 创建实例(表)
最后一步创建实例（表），为当前绑定的 `UObject` 创建一个 table，来驱动游戏逻辑。
```c++
Env->GetObjectRegistry()->Bind(Class);
Env->GetObjectRegistry()->Bind(Object);
```
内部创建实例表，代码几乎都是 Lua C API，就不贴出来了，我给出翻译成 Lua 的伪代码：
```lua
local INSTANCE = {}
```
`INSTANCE` 我们新创建的实例表，一开始是空的，随后放入 `Object` 字段。
```lua
local RAW_UOBJECT = -- From C++
INSTANCE.Object = RAW_UOBJECT
```
设置 Metatable，别怕我会解释的。
```lua
local REQUIRED_MODULE = REGISTRY_BY_REF[ClassBoundRef]
local METATABLE_UOBJECT = getmetatable(RAW_UOBJECT)
setmetatable(REQUIRED_MODULE, METATABLE_UOBJECT)
INSTANCE.Overridden = METATABLE_UOBJECT
setmetatable(INSTANCE, REQUIRED_MODULE)
```
`REQUIRED_MODULE` 就是开发者自己写的那份 Lua 代码，里面有函数原型信息，比如以下代码：
```lua
local M = UnLua.Class()
function M:ReceiveBeginPlay()
end
return M
```
`INSTANCE` 你可以理解为几乎是一张空表，里面没有函数，那自然找不到 `ReceiveBeginPlay` 的函数定义，所以需要 `setmetatable(INSTANCE, REQUIRED_MODULE)` ，让其能找到函数信息。
能找到用户自己实现的函数信息还不够，我们希望能通过 `INSTANCE` 访问到 `UObject` 的 `Property` 和 `Function`，`METATABLE_UOBJECT` 就是 “导出类描述“ 这一小节中导出的内容，里面只是简单的定义了一些 Metamethod 比如 `Class_Index` 从而能正确的找到属性、函数，因此还需要 `setmetatable(REQUIRED_MODULE, METATABLE_UOBJECT)` ，这就能串起一条调用链。
`INSTANCE.Overridden = METATABLE_UOBJECT` 至于这句，就是为了能访问到被 Lua 覆写前的函数。
```lua
function M:SayHi(name)
    self.Overridden.SayHi(self, name)
end
```
![](/images/UE5_UnLua_脚本方案原理-1760930848012.png)
我个人觉得，只需要创建出 `Object` 的实例表就够了，但这确实是创建多了一个 `Class` 实例表，简单删了这句，好像也没有问题，如果有熟悉这块的可以给我解答一下。
## 属性、函数查找
前面已经熟悉了 UE5 怎么把对象和 Lua 脚本绑定关联起来，但从始至终我们都没有导出过任何一个属性、函数到 Lua，只导出了一些元方法出去，因为 UnLua 是动态导出的，只有访问到的东西才会导出，并添加缓存。
现在就要关注如何通过 `INSTANCE` 实例表，查找出属性、函数这些内容。
假设现在要查找 `INSTANCE.name` 这一字符串内容，首先会在 `INSTANCE` 表里查找，显然找不到，此时会访问它的 Metatable 也就是 `REQUIRED_MODULE`。
`REQUIRED_MODULE` 里自然也找不到，于是触发了它的 `__index` 元方法。
这一切都是这么的自然，以至于会下意识认为这个 `__index` 是 `Class_Index` 这个元方法，实际上并不是，允许我在这展开一下，在创建 Lua 虚拟机时，会执行以下逻辑：
```C++
static void LegacySupport(lua_State* L)
{
    static const char* Chunk = R"(
    local rawget = _G.rawget
    local rawset = _G.rawset
    local rawequal = _G.rawequal
    local type = _G.type
    local getmetatable = _G.getmetatable
    local require = _G.require

    local GetUProperty = GetUProperty
    local SetUProperty = SetUProperty

    local NotExist = {}

    local function Index(t, k)
        local mt = getmetatable(t)
        local super = mt
        while super do
            local v = rawget(super, k)
            if v ~= nil and not rawequal(v, NotExist) then
                rawset(t, k, v)
                return v
            end
            super = rawget(super, "Super")
        end

        local p = mt[k]
        if p ~= nil then
            if type(p) == "userdata" then
                return GetUProperty(t, p)
            elseif type(p) == "function" then
                rawset(t, k, p)
            elseif rawequal(p, NotExist) then
                return nil
            end
        else
            rawset(mt, k, NotExist)
        end

        return p
    end

    local function NewIndex(t, k, v)
        local mt = getmetatable(t)
        local p = mt[k]
        if type(p) == "userdata" then
            return SetUProperty(t, p, v)
        end
        rawset(t, k, v)
    end

    local function Class(super_name)
        local super_class = nil
        if super_name ~= nil then
            super_class = require(super_name)
        end

        local new_class = {}
        new_class.__index = Index
        new_class.__newindex = NewIndex
        new_class.Super = super_class

        return new_class
    end

    _G.Class = Class
    _G.GetUProperty = GetUProperty
    _G.SetUProperty = SetUProperty
    )";

    lua_register(L, "UEPrint", LogInfo);
    luaL_loadstring(L, Chunk);
    lua_newtable(L);
    lua_getglobal(L, LUA_GNAME);
    lua_setfield(L, -2, LUA_GNAME);
    luaL_setfuncs(L, UnLua_LegacyFunctions, 0);
    lua_setupvalue(L, -2, 1);
    lua_pcall(L, 0, LUA_MULTRET, 0);
    lua_getglobal(L, "Class");
    lua_setfield(L, -2, "Class");
}
```
这段代码比较长，简单来看就是提供了一个默认的 Lua Class 封装，它重写了 `__newIndex` 和 `__index` ，使得属性访问能够更简单，这就是为什么我们总是需要在 Lua 中写出：
```lua
local M = UnLua.Class()
return M
```
这样的代码，这里的 `M` 就是 `REQUIRED_MODULE` ，那么 `REQUIRED_MODULE` 的 `__index` 就是这里的 `local function Index(t, k)` ，这就清晰了，它首先会在 Lua 侧的父类进行查找，若找不到则
查找到 `METATABLE_UOBJECT` ，此时这里面肯定也是找不到的，就会触发到它的元方法，也就是 `Class_Index` 。
直接通过字段名进行查找：
```C++
FProperty* Property = Struct->FindPropertyByName(FieldName);  
UFunction* Function = (!Property && bIsClass) ? AsClass()->FindFunctionByName(FieldName) : nullptr;
```
如果找不到，有可能是因为蓝图里的 `Struct` 的字段名会被加上一串 `GUID`，需要手动做删除对比。
```c++
bool bValid = Property || Function;  
if (!bValid && bIsScriptStruct && !Struct->IsNative())  
{  
    FString FieldNameStr = FieldName.ToString();  
    const int32 GuidStrLen = 32;  
    const int32 MinimalPostfixlen = GuidStrLen + 3;  
    for (TFieldIterator<FProperty> PropertyIt(Struct.Get(), EFieldIteratorFlags::ExcludeSuper, EFieldIteratorFlags::ExcludeDeprecated); PropertyIt; ++PropertyIt)  
    {
        // ...
    }
```
还找不到，就尝试去 `UClass` 中查找了。
![](/images/UE5_UnLua_脚本方案原理-1760941234186.png)
#### 找到属性（Property）
假设已经找到了一个 `Property`，此时 Lua 栈顶上会存放一个 `userdata`：
```c++
TSharedPtr<FPropertyDesc> Property = Field->AsProperty();  
Env.GetObjectRegistry()->Push(L, Property); // 等同于 new(Userdata) TSharedPtr<FPropertyDesc>(Property);
```
`FPropertyDesc` 是对 `FProperty` 的一层包装，内部封装了 Lua 栈操作的 API，方便将属性值推向Lua 栈，或是从 Lua 栈中读出到 `FProperty`。
```c++
class FPropertyDesc : public UnLua::ITypeInterface
{
public:
    static FPropertyDesc* Create(FProperty *InProperty);
    virtual void ReadValue_InContainer(lua_State *L, const void *ContainerPtr, bool bCreateCopy) const override;
    virtual void ReadValue(lua_State *L, const void *ValuePtr, bool bCreateCopy) const override;
    virtual bool WriteValue_InContainer(lua_State *L, void *ContainerPtr, int32 IndexInStack, bool bCreateCopy) const override;
    virtual bool WriteValue(lua_State *L, void *ValuePtr, int32 IndexInStack, bool bCreateCopy) const override;
    union
    {
        FProperty *Property;
        FNumericProperty *NumericProperty;
        FEnumProperty *EnumProperty;
        FBoolProperty *BoolProperty;
        FObjectPropertyBase *ObjectBaseProperty;
        FSoftObjectProperty *SoftObjectProperty;
        FInterfaceProperty *InterfaceProperty;
        FNameProperty *NameProperty;
        FStrProperty *StringProperty;
        FTextProperty *TextProperty;
        FArrayProperty *ArrayProperty;
        FMapProperty *MapProperty;
        FSetProperty *SetProperty;
        FStructProperty *StructProperty;
        FDelegateProperty *DelegateProperty;
        FMulticastDelegateProperty *MulticastDelegateProperty;
    };
    TWeakFieldPtr<FProperty> PropertyPtr;
    int8 PropertyType;
};
```
由于里面都是 Lua 栈操作，繁琐又枯燥，并不是很难，就跳过吧。值得一提的是，这个 `union` 是 C语言模拟多态的做法，Lua 源码中很常见这种写法。
现在我们 Lua 栈顶上是 `TSharedPtr<FPropertyDesc>(Ptr)` 显然是不够方便读写的，因此 `LegacySupport` 很贴心的为其包装了 `SetUProperty` 和 `GetUProperty` 确保用户拿到的就是 Lua 对象，而不是 `TSharedPtr<FPropertyDesc>(Ptr)` 。
```c++
int32 GetUProperty(lua_State* L)
{
    auto Ptr = lua_touserdata(L, 2);
    auto Property = static_cast<TSharedPtr<UnLua::ITypeOps>*>(Ptr);
    (*Property)->ReadValue_InContainer(L, Self, false);
    return 1;
}
```
#### 找到函数（Function）
将 `TSharedPtr<FFunctionDesc>` 作为 upvalue 藏在辅助函数 closure 中，当从 Lua 调用 UE 函数时，本质上调用的是 closure `Class_CallUFunction` 。
```c++
TSharedPtr<FFunctionDesc> Function = Field->AsFunction();
Env.GetObjectRegistry()->Push(L, Function);
if (Function->IsLatentFunction())
{
    lua_pushcclosure(L, Class_CallLatentFunction, 1);
}
else
{
    lua_pushcclosure(L, Class_CallUFunction, 1);
}
```
使用 `FFunctionDesc` 的  `CallUE` 方法执行到真正的 UE 函数。这里我们还是先跳过 `Latent` 函数的处理方法，以及跳过 `CallUE` 函数的细节，至少到这里，我们已经理解了如何在 Lua 代码中找到 UE函数。
```c++
int32 Class_CallUFunction(lua_State *L)
{
    auto& Env = UnLua::FLuaEnv::FindEnvChecked(L);
    auto Function = Env.GetObjectRegistry()->Get<FFunctionDesc>(L, lua_upvalueindex(1));
    int32 NumParams = lua_gettop(L);
    int32 NumResults = Function->CallUE(L, NumParams);
    return NumResults;
}
```
## 调用 UFunction
根据参数个数和是否静态函数找出第一个参数索引。
```c++
int32 FFunctionDesc::CallUE(lua_State *L, int32 NumParams, void *Userdata)
{
    UObject* Object;
    int32 FirstParamIndex;
    if (bStaticFunc)
    {
        Object = Function->GetOuterUClass()->GetDefaultObject();
        FirstParamIndex = 1;
    }
    else if (NumParams > 0)
    {
        Object = UnLua::GetUObject(L, 1, false);
        FirstParamIndex = 2;
        --NumParams;
    }
    else
    {
        Object = nullptr;
        FirstParamIndex = 1;
    }
```
根据 `Callspace` 决定是直接分发，还是走 RPC 调用。`Func_NetMuticast` 则先本地调用再远端调用。
```c++
    int32 Callspace = Object->GetFunctionCallspace(Function.Get(), nullptr);
    bool bRemote = Callspace & FunctionCallspace::Remote;
    bool bLocal = Callspace & FunctionCallspace::Local;

    FFlagArray CleanupFlags;
    const auto Params = Buffer->Get(); 
    PreCall(L, NumParams, FirstParamIndex, CleanupFlags, Params, Userdata);
    auto FinalFunction = bInterfaceFunc
                             ? Object->GetClass()->FindFunctionByName(Function->GetFName())
                             : Function.Get();

    if (!Function->HasAnyFunctionFlags(FUNC_Net))
    {
        const auto LuaFunction = ULuaFunction::Get(Function.Get());
        if (LuaFunction && LuaFunction->GetOverridden())
            FinalFunction = LuaFunction->GetOverridden();
    }

    if (bLocal)
    {   
        Object->UObject::ProcessEvent(FinalFunction, Params);
    }
    if (bRemote && !bLocal)
    {
        Object->CallRemoteFunction(FinalFunction, Params, nullptr, nullptr);
    }

    int32 NumReturnValues = PostCall(L, NumParams, FirstParamIndex, Params, CleanupFlags);
    Buffer->Pop(Params);
    return NumReturnValues;
}
```
`PreCall` 和 `PostCall` 只是参数和返回值读入写出操作，如果 Lua 传递的参数不足，则考虑用函数声明的默认值去填充，若连函数声明的默认值也没有，就用初始化值。
![](/images/UE5_UnLua_脚本方案原理-1760959091705.png)
## Latent 函数
是一种 **可以在蓝图或 C++ 中异步执行的函数**，可以简单理解为开了个协程。
以下为 `UKismetSystemLibrary` 的 `Delay` 函数声明。
```c++
UFUNCTION(BlueprintCallable, Category="Utilities|FlowControl", meta=(Latent, WorldContext="WorldContextObject", LatentInfo="LatentInfo", Duration="0.2", Keywords="sleep"))  
static void Delay(const UObject* WorldContextObject, float Duration, struct FLatentActionInfo LatentInfo );
```
声明一个 Latent 函数，需要在元标签处写出 `meta = (Latent, LatentInfo = "LatentInfo")`。
其实也没有什么特别的，就是 Lua 执行 Latent 函数之后，应该让出时间片，然后等执行完后被唤醒就行，这些功能 Lua 本身就有。
```c++
int32 Class_CallLatentFunction(lua_State *L)
{
    auto& Env = UnLua::FLuaEnv::FindEnvChecked(L);
    auto Function = Env.GetObjectRegistry()->Get<FFunctionDesc>(L, lua_upvalueindex(1));

    auto ThreadRef = Env.FindOrAddThread(L); // lua_pushthread

    int32 NumParams = lua_gettop(L);
    int32 NumResults = Function->CallUE(L, NumParams, &ThreadRef);
    return lua_yield(L, NumResults);
}
```
Lua 调用 Latent 的时候，UnLua 会帮它填充 `FLatentActionInfo` ，使其执行完后回调回来。
```C++
FLatentActionInfo LatentActionInfo(ThreadRef, GetTypeHash(FGuid::NewGuid()), TEXT("OnLatentActionCompleted"), (Env.GetManager()));
```
`OnLatentActionCompleted` 函数内部负责唤醒该 Lua 协程。
```c++
int NResults = 0;  
int32 Status = lua_resume(Thread, L, 0, &NResults);
```
## Delegate
`Delegate` 的本质是记录对象地址和需要触发的函数名：
```c++
TScriptDelegate() 
    : Object( nullptr ),
      FunctionName( NAME_None ) { }
```
因此只要正确填充这里面的内容就可以被执行到，现在唯一的问题是，Lua 函数填充不了。因此 UnLua 创建了 `ULuaDelegateHandler` 这个类作为代理中转。
```c++
UCLASS()
class UNLUA_API ULuaDelegateHandler : public UObject
{
    GENERATED_BODY()
public:
    UFUNCTION()
    void Dummy();

    virtual void ProcessEvent(UFunction* Function, void* Parms) override;
private:
    TWeakObjectPtr<UObject> SelfObject;
    UnLua::FDelegateRegistry* Registry;
    int32 LuaRef;
    void* Delegate;
};
```
每个 `FScriptDelegate` 都为其创建一个 `ULuaDelegateHandler` ，并绑定到 `Dummy` 函数内。
```c++
InDelegate->BindUFunction(this, NAME_Dummy);
```
同时重写了 `ProcessEvent` 当代理触发时，转发给 Lua 函数。
```c++
void ULuaDelegateHandler::ProcessEvent(UFunction* Function, void* Parms)
{
    if (Registry)
        Registry->Execute(this, Parms); // SignatureDesc->CallLua(L, Handler->LuaRef, Params, Handler->SelfObject.Get());
}
```
## 覆写函数流程
前面讲解对象绑定到 Lua Module 时，为了思路连贯，跳过了覆写函数的具体实现，现在再回过头来看。
```c++
bool UUnLuaManager::BindClass(UClass* Class, const FString& InModuleName, FString& Error)
{
    // ......
    UnLua::LowLevel::GetFunctionNames(Env->GetMainState(), Ref, BindInfo.LuaFunctions);
```
`GetFunctionNames` 遍历 Lua Module Table，找出所有函数，会遍历父类。
找出所有可以被重写的 UE 函数，包括 `RepNotify`。
```c++
    ULuaFunction::GetOverridableFunctions(Class, BindInfo.UEFunctions);
```
![](/images/UE5_UnLua_脚本方案原理-1761016392303.png)
判定规则为：
```c++
bool ULuaFunction::IsOverridable(const UFunction* Function)  
{  
    static constexpr uint32 FlagMask = FUNC_Native | FUNC_Event | FUNC_Net;  
    static constexpr uint32 FlagResult = FUNC_Native | FUNC_Event;  
    return Function->HasAnyFunctionFlags(FUNC_BlueprintEvent) || (Function->FunctionFlags & FlagMask) == FlagResult;  
}
```
`BlueprintEvent` 对应的 UE 声明方式为：
```c++
UFUNCTION(BlueprintImplementableEvent)
void DoSomething();

UFUNCTION(BlueprintNativeEvent)
void DoSomething();
```
Blueprint Event 系列函数本身就是可被蓝图重写的函数，所以这类自然被认为“可 Lua override”。
`FUNC_Native | FUNC_Event` 对应 UE 声明方式为：
```c++
UFUNCTION()
virtual void OnAction();
```
- 不可覆写的类型
	- 含 `FUNC_Net` 标志：`UFUNCTION(Server)` / `UFUNCTION(Client)` / `UFUNCTION(NetMulticast)`
	- 没有 `FUNC_Event` 标志：`UFUNCTION()` 普通函数（非虚）

遍历所有 Lua Module 函数，检查是否有相同名字的 UE 函数，此时进行覆写。
```c++
for (const auto& LuaFuncName : BindInfo.LuaFunctions)
{
    UFunction** Func = BindInfo.UEFunctions.Find(LuaFuncName);
    if (Func)
    {
        UFunction* Function = *Func;
        ULuaFunction::Override(Function, Class, LuaFuncName);
    }
}
```
想要覆写 `UFunction` ，自然的想法是改写 `UFunction` 的字节码，但这只适用于覆写蓝图实现的函数，不适用于 `FUNC_Native | FUNC_Event` 的函数。
那就只剩下一条路，创建一个山寨的 `UFunction` 事实上 UnLua 就是这样做的，它创建了个 `ULuaFunction` 并继承自原始的 `UFunction` 。
```c++
UCLASS()
class UNLUA_API ULuaFunction : public UFunction
{
    GENERATED_BODY()
private:
    TWeakObjectPtr<UFunction> From;

    UPROPERTY()
    UFunction* Overridden;

    uint8 bAdded : 1;
    uint8 bActivated : 1;
    TSharedPtr<FFunctionDesc> Desc;
};
```
但创建出来的 `ULuaFunction` 挂在哪里？一种简单的想法是挂在 `INSTANCE` 的 `StaticClass` 中，UnLua 估计认为这样做不好管理（考虑如果要还原的情况），于是又引出了另一个概念 `ULuaOverridesClass` 。
```c++
UCLASS(Transient)
class UNLUA_API ULuaOverridesClass : public UClass
{
    GENERATED_BODY()
public:
    static ULuaOverridesClass* Create(UClass* Class);
};
```
每个需要覆写的 `UClass` 都会创建一个 `ULuaOverridesClass`，将所有 `ULuaFunction` 挂接在里面，这样可以很方便的激活、还原覆写。
```c++
void ULuaOverridesClass::SetActive(const bool bActive)  
{
    for (TFieldIterator<ULuaFunction> It(this, EFieldIteratorFlags::ExcludeSuper); It; ++It)
    {
        const auto LuaFunction = *It;
        LuaFunction->SetActive(bActive);
    }
}
```
而 `ULuaOverridesClass` 自身会作为一个字段，存储在我们覆写过的 `UClass` 下。
```c++
void ULuaOverridesClass::AddToOwner()  
{
    auto Field = &(Class->Children);
    while (*Field)
    {
        if (*Field == this)
        {
            Field = nullptr;
            break;
        }
        Field = &(*Field)->Next;
    }
    if (Field)
        *Field = this;
}
```
理清了设计思路，现在的问题是怎么用创建的 `ULuaFunction` 去替代 `UFunction` 使得逻辑走到我们想要的地方去。
覆写函数有两种情况：
1. 该函数本身就在当前类中，此时覆写为非新增函数。
2. 该函数不在当前类中，是从父类继承下来的，此时覆写为新增函数。

以下的 `bAddNew` 就表明是否是新增函数，同时从 `UFunction` 中拷贝一份作为 `ULuaFunction`：
```c++
void FLuaOverrides::Override(UFunction* Function, UClass* Class, FName NewName)
{
    const auto OverridesClass = GetOrAddOverridesClass(Class);

    ULuaFunction* LuaFunction;
    const auto bAddNew = Function->GetOuter() != Class;

    const auto OriginalFunctionFlags = Function->FunctionFlags;
    Function->FunctionFlags &= (~EFunctionFlags::FUNC_Native);

    FObjectDuplicationParameters DuplicationParams(Function, OverridesClass);
    DuplicationParams.InternalFlagMask &= ~EInternalObjectFlags::Native;
    DuplicationParams.DestName = NewName;
    DuplicationParams.DestClass = ULuaFunction::StaticClass();
    LuaFunction = static_cast<ULuaFunction*>(StaticDuplicateObjectEx(DuplicationParams));

    Function->FunctionFlags = OriginalFunctionFlags;
    LuaFunction->FunctionFlags = OriginalFunctionFlags;

    LuaFunction->Next = OverridesClass->Children;
    OverridesClass->Children = LuaFunction;

    LuaFunction->StaticLink(true);
    LuaFunction->Initialize();
    LuaFunction->Override(Function, Class, bAddNew);
    LuaFunction->Bind();
}
```
为了实现还原的功能，在 `ULuaFunction` 内还复制了一份 `UFunction` 到 `Overridden` 中：
```c++
void ULuaFunction::Override(UFunction* Function, UClass* Class, bool bAddNew)
{
    if (Function->GetNativeFunc() == execScriptCallLua)
    {
    }
    else
    {
        const auto DestName = FString::Printf(TEXT("%s__Overridden"), *Function->GetName());
        if (Function->HasAnyFunctionFlags(FUNC_Native))
            GetOuterUClass()->AddNativeFunction(*DestName, *Function->GetNativeFunc());
        Overridden = static_cast<UFunction*>(StaticDuplicateObject(Function, GetOuter(), *DestName));
        Overridden->ClearInternalFlags(EInternalObjectFlags::Native);
        Overridden->StaticLink(true);
        Overridden->SetNativeFunc(Function->GetNativeFunc());
    }
    SetActive(true);
}
```
我们现在什么都不缺了：
![](/images/UE5_UnLua_脚本方案原理-1761028762295.jpg)
可以开始劫持执行流了，`SetActive` 就是做这个的。
现在只考虑新增函数，也就是前面提到过的这个函数来自于父类，劫持方法是直接将该 `ULuaFunction` 改为 `FUNC_Native` 函数，使得调用时必须走到 `execCallLua` ，并将自身函数添加到 `UClass`。
```c++
void ULuaFunction::SetActive(const bool bActive)
{
    const auto Class = Cast<ULuaOverridesClass>(GetOuter())->GetOwner();
    if (bAdded)
    {
        SetSuperStruct(Function);
        FunctionFlags |= FUNC_Native;
        ClearInternalFlags(EInternalObjectFlags::Native);
        SetNativeFunc(execCallLua);

        Class->AddFunctionToFunctionMap(this, *GetName());
        if (Function->HasAnyFunctionFlags(FUNC_Native))
            Class->AddNativeFunction(*GetName(), &ULuaFunction::execCallLua);
    }
```
`execCallLua` 实质上是个 `Thunk` 函数，可以简单理解为一个跳板函数。
```c++
DECLARE_FUNCTION(execCallLua);
DEFINE_FUNCTION(ULuaFunction::execCallLua)
{
    const auto LuaFunction = Cast<ULuaFunction>(Stack.CurrentNativeFunction);
    const auto Env = IUnLuaModule::Get().GetEnv(Context);
    if (!Env)
    {
        return;
    }
    Env->GetFunctionRegistry()->Invoke(LuaFunction, Context, Stack, RESULT_PARAM);
}
```
`Invoke` 内部会处理好入参，然后调用 Lua 函数，并处理返回值。
`SetActive` 还有种情况，函数本身就存在于 `UClass`，此时不能简单的将自身添加进去，只能在 `UFunction` 自身做文章，在这里则是强行加上一段字节码，里面是真正的 `ULuaFunction` 的指针地址。
```c++
    else
    {
        SetSuperStruct(Function->GetSuperStruct());
        Script = Function->Script;
        Children = Function->Children;
        ChildProperties = Function->ChildProperties;
        PropertyLink = Function->PropertyLink;

        Function->FunctionFlags |= FUNC_Native;
        Function->SetNativeFunc(&execScriptCallLua);
        Function->GetOuterUClass()->AddNativeFunction(*Function->GetName(), &execScriptCallLua);
        Function->Script.Empty();
        Function->Script.AddUninitialized(ScriptMagicHeaderSize + sizeof(ULuaFunction*));
        const auto Data = Function->Script.GetData();
        FPlatformMemory::Memcpy(Data, ScriptMagicHeader, ScriptMagicHeaderSize);
        FPlatformMemory::WriteUnaligned<ULuaFunction*>(Data + ScriptMagicHeaderSize, this);
    }
```
从字节码中找出真正的 `ULuaFunction` 地址。
```c++
DECLARE_FUNCTION(execScriptCallLua);
DEFINE_FUNCTION(ULuaFunction::execScriptCallLua)
{
    const auto Data = Function->Script.GetData();
    const auto LuaFunction = FPlatformMemory::ReadUnaligned<ULuaFunction*>(Data + ScriptMagicHeaderSize);
    // ......
}
```
## 生命周期
几乎可以说所有的 UnLua 创建的 Lua 对象，都会放在 Lua 注册表内保持强引用（如果是不需要绑定的 `UObject` 被 Push 进 Lua，则不会强引用），因此不会触发垃圾回收。只有 UE侧释放了这个 `UObject` 时，才会反注册，同时对 `userdata` 指针设置为已释放标识，避免后续 Lua 访问导致崩溃。
```c++
*((void**)Userdata) = (void*)LowLevel::ReleasedPtr;
```
Push 进 Lua 的 `UObject` 都是二级指针的形式。
`ULuaDelegateHandler` 是个特例，在创建之后会放入 `FObjectReferencer AutoObjectReference;` 保持 UE的强引用，`__gc` 的时候会触发一下删除。
## 最后
UnLua 还有容器的导出、静态类导出，自动绑定输入这些功能，难度不大就留给读者自己去探索了。 