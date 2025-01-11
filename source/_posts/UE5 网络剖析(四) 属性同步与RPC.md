---
title: UE5 网络剖析(四) 属性同步与RPC
categories: UE
keywords: 'UE5, UDP, Bunch, Replicator'
tags:
  - UE5
  - 网络
date: 2024-12-07 10:59:20
---

本文主要剖析 UE5 网络中是如何进行属性同步和RPC的。

## 同步 Actor

要进行属性同步，首先就要先同步 Actor，但更要知道哪些 Actor 需要网络同步。

### 哪些 Actor 需要网络同步

Actor 需要设置 `bReplicates` 为 true，才会进行同步，

以 Spawn Pawn 为例，玩家登录之后会由 `GameMode` 创建 Pawn 实例。

```cpp
AActor* UWorld::SpawnActor( UClass* Class, FVector const* Location, FRotator const* Rotation, const FActorSpawnParameters& SpawnParameters )
{
    ...
    AActor* const Actor = NewObject<AActor>(LevelToSpawnIn, Class, NewActorName, ActorFlags, Template, false/*bCopyTransientsFromClassDefaults*/, nullptr/*InInstanceGraph*/, ExternalPackage);
    // Add this newly spawned actor to the network actor list. Do this after PostSpawnInitialize so that actor has "finished" spawning.
    AddNetworkActor( Actor );
    return Actor;
}
```

若 `bReplicates` 为 true，则 RemoteRole 为 ROLE_SimulatedProxy，表示是远端为模拟代理。

```cpp
void AActor::PostInitProperties()
{
    Super::PostInitProperties();
    RemoteRole = (bReplicates ? ROLE_SimulatedProxy : ROLE_None);
}
```

将需要同步的 Actor 加入到 NetDriver中的一个集合里， 至此就找到了要网络同步的 Actor，需要注意一点是 `Replicate` 是支持动态开关的。

<!-- more -->

```cpp
void UNetDriver::AddNetworkActor(AActor* Actor)
{
    if (!IsDormInitialStartupActor(Actor))
    {
        GetNetworkObjectList().FindOrAdd(Actor, this);
    }
}
```

### 当前帧要同步哪些 Actor

找出了所有要网络同步的 Actor 后，就需要确认当前帧要同步哪些 Actor，毕竟不可能每帧都同步所有 Actor，带宽和计算成本都接受不了。

```cpp
void UNetDriver::TickFlush(float DeltaSeconds)
{
    ServerReplicateActors(DeltaSeconds);
}
```

经过代码裁剪，得出以下核心代码。

```cpp
int32 UNetDriver::ServerReplicateActors(float DeltaSeconds)
{
    const int32 NumClientsToTick = ServerReplicateActors_PrepConnections( DeltaSeconds );
    // Build the consider list (actors that are ready to replicate)
    ServerReplicateActors_BuildConsiderList( ConsiderList, ServerTickTime );

    for ( int32 i=0; i < ClientConnections.Num(); i++ )
    {
        const bool bProcessConsiderListIsBound = OnProcessConsiderListOverride.IsBound();
        if (Connection->ViewTarget)
        {
            if (!bProcessConsiderListIsBound)
            {
                FActorPriority* PriorityList = NULL;
                FActorPriority** PriorityActors = NULL;

                // Get a sorted list of actors for this connection
                const int32 FinalSortedCount = ServerReplicateActors_PrioritizeActors(Connection, ConnectionViewers, ConsiderList, bCPUSaturated, PriorityList, PriorityActors);

                // Process the sorted list of actors for this connection
                TInterval<int32> ActorsIndexRange(0, FinalSortedCount);
                const int32 LastProcessedActor = ServerReplicateActors_ProcessPrioritizedActorsRange(Connection, ConnectionViewers, PriorityActors, ActorsIndexRange, Updated);

                ServerReplicateActors_MarkRelevantActors(Connection, ConnectionViewers, LastProcessedActor, FinalSortedCount, PriorityActors);
            }
        }
    }
}
```

`ServerReplicateActors_PrepConnections` 是用于计算此处需要给几个客户端同步，通常用于 `ListenServer` ，因为玩家的机器通常性能不会太好，而 `Dedicated Server` 当然是选择给所有客户端全部同步，因此此处逻辑不重要。

`ServerReplicateActors_BuildConsiderList` 看名字就能猜到，是计算哪些 Actor 可以被纳入考虑同步名单，主要是根据检查 Actor 的一些属性，比如该 Actor所属 NetDriver 和当前 NetDriver 是否一致，是否即将被删除。

有了考虑名单，就要根据优先级来排序 Actor， `ServerReplicateActors_PrioritizeActors` 就是来做这一部分工作的，其中会调用 `Actor::IsNetRelevantFor` 和 `AActor::GetNetPriority` 。

`Actor::IsNetRelevantFor` 是检查该 Actor 是否和当前 观察者 是否相关的，比如 `NetCullDistanceSquared` 这个参数就是在此刻用上的，检查和观察者的距离。

`AActor::GetNetPriority` 是获取 Actor 网络优先级，这部分逻辑比较有趣，所以单独拉出来看看。

```cpp
float AActor::GetNetPriority(const FVector& ViewPos, const FVector& ViewDir, AActor* Viewer, AActor* ViewTarget, UActorChannel* InChannel, float Time, bool bLowBandwidth)
{
    if (bNetUseOwnerRelevancy && Owner)
    {
        // If we should use our owner's priority, pass it through
        return Owner->GetNetPriority(ViewPos, ViewDir, Viewer, ViewTarget, InChannel, Time, bLowBandwidth);
    }

    if (ViewTarget && (this == ViewTarget || GetInstigator() == ViewTarget))
    {
        // If we're the view target or owned by the view target, use a high priority
        Time *= 4.f;
    }
    else if (!IsHidden() && GetRootComponent() != NULL)
    {
        // If this actor has a location, adjust priority based on location
        FVector Dir = GetActorLocation() - ViewPos;
        float DistSq = Dir.SizeSquared();

        // Adjust priority based on distance and whether actor is in front of viewer
        if ((ViewDir | Dir) < 0.f)
        {
            if (DistSq > NEARSIGHTTHRESHOLDSQUARED)
            {
                Time *= 0.2f;
            }
            else if (DistSq > CLOSEPROXIMITYSQUARED)
            {
                Time *= 0.4f;
            }
        }
        else if ((DistSq < FARSIGHTTHRESHOLDSQUARED) && (FMath::Square(ViewDir | Dir) > 0.5f * DistSq))
        {
            // Compute the amount of distance along the ViewDir vector. Dir is not normalized
            // Increase priority if we're being looked directly at
            Time *= 2.f;
        }
        else if (DistSq > MEDSIGHTTHRESHOLDSQUARED)
        {
            Time *= 0.4f;
        }
    }

    return NetPriority * Time;
}
```

默认会根据 Actor 处于观察者的位置来计算优先级，如果 DotProduct < 0 则是背面，根据距离来调整优先级，若在正面，且视线相近则放大。

前面几篇提到过，Actor 是基于 ActorChannel 同步的，服务端需要通知客户端创建一个 ActorChannel，然后专门为该 Actor 进行同步。

首次同步，会为该 Actor 在本地创建 ActorChannel。

```cpp
int32 UNetDriver::ServerReplicateActors_ProcessPrioritizedActorsRange( UNetConnection* Connection, const TArray<FNetViewer>& ConnectionViewers, FActorPriority** PriorityActors, const TInterval<int32>& ActorsIndexRange, int32& OutUpdated, bool bIgnoreSaturation )
{
    for (...)
    {
        // Create a new channel for this actor.
        Channel = (UActorChannel*)Connection->CreateChannelByName( NAME_Actor, EChannelCreateFlags::OpenedLocally );
        if ( Channel )
        {
            Channel->SetChannelActor(Actor, ESetChannelActorFlags::None);
        }
        if ( Channel->ReplicateActor() )
        {
        }
    }
}
```

`SetChannelActor` 是属性同步和RPC的重点，但此处先跳过，后面会回来。但至少现在，已经找出当前帧要同步的 Actor，并为它创建了本地 ActorChannel。

### 序列化 Actor

同步一个东西通常都是用序列化的方式进行，UE5 也不例外，调用 `Channel->ReplicateActor()` ，进而使用 PackageMapClient 来序列化 Actor。

```cpp
int64 UActorChannel::ReplicateActor()
{
    if (RepFlags.bNetInitial && OpenedLocally)
    {
        Connection->PackageMap->SerializeNewActor(Bunch, this, static_cast<AActor*&>(Actor));
        bWroteSomethingImportant = true;

        Actor->OnSerializeNewActor(Bunch);
    }
}
```

`PackageMapClient` 在网络剖析的前面几篇提到过，每个连接有一个，就是专门用来序列化 Actor 的。

在深入序列化 Actor 之前，需要先了解 `NetGUID` ，这是用于表示某个 Object 的，无论在客户端还是服务端都是相同的，都能够指向同一个对象。

简单看一下 `NetGUID` 分配方式，根据是否为动态对象，划分出两个数组，每次分配都是递增。

```cpp
FNetworkGUID FNetGUIDCache::AssignNewNetGUID_Server( UObject* Object )
{
    // Generate new NetGUID and assign it
    const int32 IsStatic = IsDynamicObject( Object ) ? 0 : 1;

    const FNetworkGUID NewNetGuid = FNetworkGUID::CreateFromIndex(++NetworkGuidIndex[IsStatic], IsStatic != 0);

    RegisterNetGUID_Server( NewNetGuid, Object );

    return NewNetGuid;
}
```

```cpp
static FNetworkGUID CreateFromIndex(uint64 NetIndex, bool bIsStatic)
{
    FNetworkGUID NewGuid;
    NewGuid.ObjectId = NetIndex << 1 | (bIsStatic ? 1 : 0);

    return NewGuid;
}
```

序列化 Actor 是一个递归的过程，为了方便后续的理解，这里简单阐述一下序列化的过程。

比如我们要序列化一个已经 Spawn 的 Actor，最直观的思路就是序列化当前 Actor 的一些属性，比如位置，旋转，速度，但这样实际上还不够，因为对方还不知道这个 Actor 是基于什么东西构造出来的，应该还要序列化出它的 CDO 类，CDO 可以理解为这个 Actor 的原型，根据这个原型 Archetype 实例化出这个 Actor，这个原型要么是 C++文件，要么是蓝图文件，所以是一定有路径的，因此要想序列化 Actor，需要先把它的原型给序列化好，不然就找不到它的原型无法构造它出来，在代码结构中称之为 ObjOuter。

因此序列化 Actor，会先打入 Actor 的 GUID，然后打入 Actor→Outer 的 GUID，发现 Outer 对端也没有收到过，这时就会打入  Outer 的路径，最后才是当前 Actor 的路径。

从发的角度可能很难理解，但是从客户端接收的角度就会好理解些，先是收到 Actor 的 GUID，暂存下来，然后递归函数继续收到 Actor 的 Outer 的 GUID 也暂存下来，继续递归发现没有新的 GUID 了，返回，开始读取 Outer 的路径，路径读完，返回递归，最后读取 Actor 的其他信息。

总之先是知道儿子的名字，然后查一下父亲的名字和地址，构造完父亲后，此时数据流中就只剩下儿子的地址，就可以构造出儿子。

简单结构如下(省略其他属性)：

```cpp
Character GUID | BP_Characer GUID | BP_Character Path | Character Path | Character localtion ...
```

`UActorChannel::ReplicateActor` 调用 `UPackageMapClient::SerializeNewActor` 开始序列化一个 Actor。

```cpp
bool UPackageMapClient::SerializeNewActor(FArchive& Ar, class UActorChannel *Channel, class AActor*& Actor)
{
    FNetworkGUID NetGUID;
    UObject *NewObj = Actor;
    SerializeObject(Ar, AActor::StaticClass(), NewObj, &NetGUID);
    Channel->ActorNetGUID = NetGUID;

    Actor = Cast<AActor>(NewObj);
    if ( NetGUID.IsDynamic() )
    {
        UObject* Archetype = nullptr;
        UObject* ActorLevel = nullptr;
        FVector Location = FVector::ZeroVector;
        FVector Scale = FVector::OneVector;
        FVector Velocity = FVector::ZeroVector;
        FRotator Rotation = FRotator::ZeroRotator;
        ....
    }
}
```

`InternalWriteObject` 会写入当前 Actor 信息，但是此时由于还未处于 导出 NetGUID 模式下，所以只会简单写入 GUID。

```cpp

bool UPackageMapClient::SerializeObject( FArchive& Ar, UClass* Class, UObject*& Object, FNetworkGUID *OutNetGUID)
{
    if (Ar.IsSaving())
    {
        FNetworkGUID NetGUID = GuidCache->GetOrAssignNetGUID( Object );

        // Write out NetGUID to caller if necessary
        if (OutNetGUID)
        {
            *OutNetGUID = NetGUID;
        }

        // Write object NetGUID to the given FArchive
        InternalWriteObject( Ar, NetGUID, Object, TEXT( "" ), NULL );

        // If we need to export this GUID (its new or hasnt been ACKd, do so here)
        if (!NetGUID.IsDefault() && Object && ShouldSendFullPath(Object, NetGUID))
        {
            if ( !ExportNetGUID( NetGUID, Object, TEXT(""), NULL ) )
            {
                UE_LOG( LogNetPackageMap, Verbose, TEXT( "Failed to export in ::SerializeObject %s"), *Object->GetName() );
            }
        }

        return true;
    }
}
```

`!NetGUID.IsValid()` 说明已经写完了，没有更外层的对象需要序列化， `IsExportingNetGUIDBunch` 为 true 时才会一层层导出 Actor，该变量在 `ExportNetGUID` 中被设置。

```cpp
void UPackageMapClient::InternalWriteObject(FArchive & Ar, FNetworkGUID NetGUID, UObject* Object, FString ObjectPathName, UObject* ObjectOuter)
{
    Ar << NetGUID;
    NET_CHECKSUM(Ar);

    if (!NetGUID.IsValid())
    {
        // We're done writing
        return;
    }

    // Write export flags
    //   note: Default NetGUID is implied to always send path
    FExportFlags ExportFlags;

    ExportFlags.bHasNetworkChecksum = (GuidCache->NetworkChecksumMode != FNetGUIDCache::ENetworkChecksumMode::None) ? 1 : 0;

    if (NetGUID.IsDefault())
    {
        // Only the client sends default guids
        check(!IsNetGUIDAuthority());
        ExportFlags.bHasPath = 1;

        Ar << ExportFlags.Value;
    }
    else if (GuidCache->IsExportingNetGUIDBunch)
    {
        // Only the server should be exporting guids
        check(IsNetGUIDAuthority());

        if (Object != nullptr)
        {
            ExportFlags.bHasPath = ShouldSendFullPath(Object, NetGUID) ? 1 : 0;
        }
        else
        {
            ExportFlags.bHasPath = ObjectPathName.IsEmpty() ? 0 : 1;
        }

        ExportFlags.bNoLoad	= bNoLoad ? 1 : 0;

        Ar << ExportFlags.Value;
    }

    if (ExportFlags.bHasPath)
    {
        if (Object != nullptr)
        {
            // If the object isn't nullptr, expect an empty path name, then fill it out with the actual info
            check(ObjectOuter == nullptr);
            check(ObjectPathName.IsEmpty());
            ObjectPathName = Object->GetName();
            ObjectOuter = Object->GetOuter();
        }

        const bool bIsPackage = (NetGUID.IsStatic() && Object != nullptr && Object->GetOuter() == nullptr);

        // Serialize reference to outer. This is basically a form of compression.
        FNetworkGUID OuterNetGUID = GuidCache->GetOrAssignNetGUID(ObjectOuter);

        InternalWriteObject(Ar, OuterNetGUID, ObjectOuter, TEXT( "" ), nullptr);
    }
}

```

最后是导出的 NetGUID 会被放入到 `ExportBunches` ，发送 Bunch 时，如果这里有值，则会将它放到 Bunch 的最前面发送出去。

到这里 Actor 同步的主要流程就都清楚了，后续就是补充上面未提到的一些东西。在首次序列化 Actor 时 允许重写 OnSerializeNewActor 来追加你想传递的信息，比如 PlayerController 就追加了 `NetPlayerIndex` ，当首次同步 Actor 时，可以通过 `OnActorChannelOpen` 将其读出。

```cpp
/**
	* SerializeNewActor has just been called on the actor before network replication (server side)
	* @param OutBunch Bunch containing serialized contents of actor prior to replication
	*/
virtual void AActor::OnSerializeNewActor(class FOutBunch& OutBunch) {};

	/** 
	* Allows for a specific response from the actor when the actor channel is opened (client side)
	* @param InBunch Bunch received at time of open
	* @param Connection the connection associated with this actor
	*/
virtual void AActor::OnActorChannelOpen(class FInBunch& InBunch, class UNetConnection* Connection) {};
```

读取同步 Actor 的 Bunch逻辑在 `void UActorChannel::ProcessBunch( FInBunch & Bunch )` 此处就不再重复了，都是同样的几个函数，根据 Ar 读取写入模式来区分逻辑。

## 属性同步

属性同步的前提是要感知属性的变化，通常比较麻烦的做法就是每次修改完某个属性，就手动置脏，这种方式麻烦，但是性能高，因此 UE4.25 也支持了这个功能，叫做 push model。还有一种常见做法就是设置回调，每次修改属性时触发修改回调，来感知该属性的变化，通常在 `lua` `C#` 这类语言中比较好实现。UE5的框架采用了一种更特殊的方式，即直接对比前后两次的内存。

要想实现对比前后两次的内存，首先就需要找到什么字段需要同步，以及需要同步的字段所在Actor中的内存地址。

![UE5_network_replicator1.png](images/UE5_network_replicator1.png)

### 找出需要同步的属性

`FRepLayout` 就是来记录 Replicator 属性布局的，从它的函数声明中就可以看出，它可以根据 Class、Struct、Function 中构造出来，Function 就是后面要提到的 RPC。

```cpp
/** Creates a new FRepLayout for the given class. */
ENGINE_API static TSharedPtr<FRepLayout> CreateFromClass(UClass* InObjectClass, const UNetConnection* ServerConnection = nullptr, const ECreateRepLayoutFlags Flags = ECreateRepLayoutFlags::None);

/** Creates a new FRepLayout for the given struct. */
ENGINE_API static TSharedPtr<FRepLayout> CreateFromStruct(UStruct * InStruct, const UNetConnection* ServerConnection = nullptr, const ECreateRepLayoutFlags Flags = ECreateRepLayoutFlags::None);

/** Creates a new FRepLayout for the given function. */
static TSharedPtr<FRepLayout> CreateFromFunction(UFunction* InFunction, const UNetConnection* ServerConnection = nullptr, const ECreateRepLayoutFlags Flags = ECreateRepLayoutFlags::None);
```

```cpp
TSharedPtr<FRepLayout> FRepLayout::CreateFromClass(
    UClass* InClass,
    const UNetConnection* ServerConnection,
    const ECreateRepLayoutFlags CreateFlags)
{
    TSharedPtr<FRepLayout> RepLayout = MakeShareable<FRepLayout>(new FRepLayout());
    RepLayout->InitFromClass(InClass, ServerConnection, CreateFlags);
    return RepLayout;
}
```

`InitFromClass` 会调用 `UClass::SetUpRuntimeReplicationData` 来收集需要同步的字段，这个函数会在蓝图创建或每次编译时执行，这也就是蓝图实现同步变量的原理。

![UE5_network_replicator2.png](images/UE5_network_replicator2.png)

通过遍历该类的所有字段，找出需要同步的字段。

```cpp
void UClass::SetUpRuntimeReplicationData()
{
    NetFields.Empty();

    if (UClass* SuperClass = GetSuperClass())
    {
        SuperClass->SetUpRuntimeReplicationData();
        ClassReps = SuperClass->ClassReps;
        FirstOwnedClassRep = ClassReps.Num();
    }
    else
    {
        ClassReps.Empty();
        FirstOwnedClassRep = 0;
    }

    // Track properties so me can ensure they are sorted by offsets at the end
    TArray<FProperty*> NetProperties;
    for (TFieldIterator<FField> It(this, EFieldIteratorFlags::ExcludeSuper); It; ++It)
    {
        if (FProperty* Prop = CastField<FProperty>(*It))
        {
            if ((Prop->PropertyFlags & CPF_Net) && Prop->GetOwner<UObject>() == this)
            {
                NetProperties.Add(Prop);
            }
        }
    }
}
```

这里找出所有 RPC函数。

```cpp
for(TFieldIterator<UField> It(this,EFieldIteratorFlags::ExcludeSuper); It; ++It)
{
    if (UFunction * Func = Cast<UFunction>(*It))
    {
        // When loading reflection data (e.g. from blueprints), we may have references to placeholder functions, or reflection data 
        // in children may be out of date. In that case we cannot enforce this check, but that is ok because reflection data will
        // be regenerated by compile on load anyway:
        const bool bCanCheck = (!GIsEditor && !IsRunningCommandlet()) || !Func->HasAnyFlags(RF_WasLoaded);
        check(!bCanCheck || (!Func->GetSuperFunction() || (Func->GetSuperFunction()->FunctionFlags&FUNC_NetFuncFlags) == (Func->FunctionFlags&FUNC_NetFuncFlags)));
        if ((Func->FunctionFlags&FUNC_Net) && !Func->GetSuperFunction())
        {
            NetFields.Add(Func);
        }
    }
}
```

蓝图也就是 非 `CLASS_Native` 则需要对属性进行一次稳定排序，保证之后的内存布局顺序是一致的。

```cpp
const bool bIsNativeClass = HasAnyClassFlags(CLASS_Native);
if (!bIsNativeClass)
{
    // Sort NetProperties so that their ClassReps are sorted by memory offset
    struct FComparePropertyOffsets
    {
        FORCEINLINE bool operator()(FProperty* A, FProperty* B) const
        {
            // Ensure stable sort
            if (A->GetOffset_ForGC() == B->GetOffset_ForGC())
            {
                return A->GetName() < B->GetName();
            }

            return A->GetOffset_ForGC() < B->GetOffset_ForGC();
        }
    };

    Algo::Sort(NetProperties, FComparePropertyOffsets());
}
```

对静态数组的处理则是每个槽位都先占位，并将存在 ClassReps 里。

```cpp
ClassReps.Reserve(ClassReps.Num() + NetProperties.Num());
for (int32 i = 0; i < NetProperties.Num(); i++)
{
    NetProperties[i]->RepIndex = (uint16)ClassReps.Num();
    for (int32 j = 0; j < NetProperties[i]->ArrayDim; j++)
    {
        ClassReps.Emplace(NetProperties[i], j);
    }
}
check(ClassReps.Num() <= 65535);

NetFields.Shrink();

Algo::SortBy(NetFields, &UField::GetFName, FNameLexicalLess());

ClassFlags |= CLASS_ReplicationDataIsSetUp;
```

ClassReps 存的内容很简单，一个是属性的指针，另一个是索引。

```cpp
/** List of replication records */
TArray<FRepRecord> ClassReps;
struct FRepRecord
{
    FProperty* Property;
    int32 Index;
};
```

现在已经找出了所有需要同步的字段，以及 RPC 函数，但根据一开始的思路，还需要一段内存来存储上一次刷新的属性，这样才能做内存比对，知道哪些属性有变更。

### 计算每个属性在 ShadowBuffer 的位置

ShadowBuffer 就是一段用来存储上一次刷新时的属性的一段内存，每个 Actor 都有一个，既然知道要用它来存储同步属性，那么首先要计算属性应该被放到 ShadowBuffer 的哪一处，也就是内存偏移，这就是 Cmd 的作用。

Cmd 分为 `FRepParentCmd`和`FRepLayoutCmd` ，每个 RepParentCmd 包含一个或多个 RepLayoutCmd，之所以需要这样，是因为需要同步的属性有可能是个 `Struct` 或者是 `Array` ，需要更确切的知道每个槽位的内存偏移，如果同步的都是 int 这种平坦的内存，那自然就不需要多弄一层 Cmd。

`FRepParentCmd` 的结构如下，其中 `CmdStart` 和 `CmdEnd` 指的是这个 ParentCmd 包含的 LayoutCmd 的左右边界。

```cpp
class FRepParentCmd
{
public:
    FProperty* Property;

    /**
        * If the Property is a C-Style fixed size array, then a command will be created for every element in the array.
        * This is the index of the element in the array for which the command represents.
        *
        * This will always be 0 for non array properties.
        */
    int32 ArrayIndex;

    /** Absolute offset of property in Object Memory. */
    int32 Offset;

    /** Absolute offset of property in Shadow Memory. */
    int32 ShadowOffset;

    /**
        * CmdStart and CmdEnd define the range of FRepLayoutCommands (by index in FRepLayouts Cmd array) of commands
        * that are associated with this Parent Command.
        *
        * This is used to track and access nested Properties from the parent.
        */
    uint16 CmdStart;

    /** @see CmdStart */
    uint16 CmdEnd;
};
```

```cpp
class FRepLayoutCmd
{
public:
    /** Pointer back to property, used for NetSerialize calls, etc. */
    FProperty* Property;

    /** For arrays, this is the cmd index to jump to, to skip this arrays inner elements. */
    uint16 EndCmd;

    /** For arrays, element size of data. */
    uint16 ElementSize;

    /** Absolute offset of property in Object Memory. */
    int32 Offset;

    /** Absolute offset of property in Shadow Memory. */
    int32 ShadowOffset;

    /** Handle relative to start of array, or top list. */
    uint16 RelativeHandle;

    /** Index into Parents. */
    uint16 ParentIndex;
};
```

此处就是根据 `ClassReps` 构建 ParentCmd 和 LayoutCmd。

```cpp
void FRepLayout::InitFromClass(
	UClass* InObjectClass,
	const UNetConnection* ServerConnection,
	const ECreateRepLayoutFlags CreateFlags)
{
    for (int32 i = 0; i < InObjectClass->ClassReps.Num(); i++)
    {
        FProperty * Property = InObjectClass->ClassReps[i].Property;
        const int32 ArrayIdx = InObjectClass->ClassReps[i].Index;

        const int32 ParentHandle = AddParentProperty(Parents, Property, ArrayIdx);

        check(ParentHandle == i);
        check(Parents[i].Property->RepIndex + Parents[i].ArrayIndex == i);

        const int32 ParentOffset = Property->ElementSize * ArrayIdx;

        FInitFromPropertySharedParams SharedParams
        {
            /*Cmds=*/Cmds,
            /*ServerConnection=*/ServerConnection,
            /*ParentIndex=*/ParentHandle,
            /*Parent=*/Parents[ParentHandle],
            /*bHasObjectProperties=*/false,
            /*bHasNetSerializeProperties=*/false,
            /*NetSerializeLayouts=*/GbTrackNetSerializeObjectReferences ? &TempNetSerializeLayouts : nullptr,
        };

        FInitFromPropertyStackParams StackParams
        {
            /*Property=*/Property,
            /*Offset=*/ParentOffset, // 当前属性的 offset 根据元素大小Elementsize*arrayIdx算出
            /*RelativeHandle=*/RelativeHandle, //Cmd在Cmds数组中的下标+1
            /*ParentChecksum=*/0,
            /*StaticArrayIndex=*/ArrayIdx // arrayIdx
        };

        Parents[ParentHandle].CmdStart = Cmds.Num();
        RelativeHandle = InitFromProperty_r<ERepBuildType::Class>(SharedParams, StackParams);
        Parents[ParentHandle].CmdEnd = Cmds.Num();
        Parents[ParentHandle].Flags |= ERepParentFlags::IsConditional;
        // parentoffset 是因为有可能是固定数组，固定数组的元素是会被拆分成一个个 parent的
        Parents[ParentHandle].Offset = GetOffsetForProperty<ERepBuildType::Class>(*Property) + ParentOffset;
    }
}
```

在继续之前，需要知道支持属性同步的类型是不包括 `TMap` 和 `TSet` 的。对普通类型的处理非常简单，就是一个 ParentCmd 对应一个 LayoutCmd。

```
// Add actual property
++StackParams.RelativeHandle;
StackParams.Offset += GetOffsetForProperty<BuildType>(*StackParams.Property);

AddPropertyCmd(SharedParams, StackParams);
```

对 Array 属性的特殊处理，可以看出 Array 的 LayoutCmd 最后一个 Cmd 为 ReturnCmd。

```cpp
const uint32 ArrayChecksum = AddArrayCmd(SharedParams, StackParams);

FInitFromPropertyStackParams NewStackParams{
    /*Property=*/ArrayProp->Inner,
    /*Offset=*/0,
    /*RelativeHandle=*/0,
    /*ParentChecksum=*/ArrayChecksum,
    /*StaticArrayIndex=*/0,
    /*RecursingNetSerializeStruct=*/StackParams.RecursingNetSerializeStruct
};

InitFromProperty_r<BuildType>(SharedParams, NewStackParams);

AddReturnCmd(SharedParams.Cmds);
```

对 Struct 的特殊处理，实现了NetDeltaSerialize函数的 Struct，不会生成 LayoutCmd，原因如注释所示。

- `*These structs will not have Child Rep Commands, but they will still have Parent Commands. This is because we generally don't care about their Memory Layout, but we need to be able to initialize them properly.*`

这是提供了一个方法来用用户自定义如何进行计算增量逻辑，若无这个函数，则会默认用 `UStructProperty::NetDeltaSerializeItem` ，最经典的使用是 FastArray，因为普通的 Array 属性同步时，若增删了其中一个值，则需要发送该 Array 剩下的所有值。

Struct 若实现了 NetSerialize 则表明是自己决定如何序列化的，只会生成一个 LayoutCmd。

- `*These structs will have a single Child Rep Command for the FStructProperty. Similar to NetDeltaSerialize, we don't really care about the memory layout of NetSerialize structs, but we still need to know where they live so we can diff them, etc.`*

```cpp
UScriptStruct* Struct = StructProp->Struct;

StackParams.Offset += GetOffsetForProperty<BuildType>(*StructProp);
if (EnumHasAnyFlags(Struct->StructFlags, STRUCT_NetSerializeNative))
{
    UE_CLOG(EnumHasAnyFlags(Struct->StructFlags, STRUCT_NetDeltaSerializeNative), LogRep, Warning, TEXT("RepLayout InitFromProperty_r: Struct marked both NetSerialize and NetDeltaSerialize: %s"), *StructProp->GetName());

    SharedParams.bHasNetSerializeProperties = true;
    if (ERepBuildType::Class == BuildType && GbTrackNetSerializeObjectReferences && nullptr != SharedParams.NetSerializeLayouts && !EnumHasAnyFlags(Struct->StructFlags, STRUCT_IdenticalNative))
    {
        // We can't directly rely on FProperty::Identical because it's not safe for GC'd objects.
        // So, we'll recursively build up set of layout commands for this struct, and if any
        // are Objects, we'll use that for storing items in Shadow State and comparison.
        // Otherwise, we'll fall back to the old behavior.
        const int32 PrevCmdNum = SharedParams.Cmds.Num();

        TArray<FRepLayoutCmd> TempCmds;
        TArray<FRepLayoutCmd>* NewCmds = &TempCmds;
        
        FInitFromPropertyStackParams NewStackParams{
            /*Property=*/StackParams.Property,
            /*Offset=*/0,
            /*RelativeHandle=*/StackParams.RelativeHandle,
            /*ParentChecksum=*/StackParams.ParentChecksum,
            /*StaticArrayIndex=*/StackParams.StaticArrayIndex,
            /*RecursingNetSerialize=*/StructProp->GetFName()
            
        };

        if (StackParams.RecursingNetSerializeStruct != NAME_None)
        {
            NewCmds = &SharedParams.Cmds;
            NewStackParams.RelativeHandle = 0;
        }

        FInitFromPropertySharedParams NewSharedParams{
            /*Cmds=*/*NewCmds,
            /*ServerConnection=*/SharedParams.ServerConnection,
            /*ParentIndex=*/SharedParams.ParentIndex,
            /*Parent=*/SharedParams.Parent,
            /*bHasObjectProperties=*/false,
            /*bHasNetSerializeProperties=*/false,
            /*NetSerializeLayouts=*/SharedParams.NetSerializeLayouts
        };

        const int32 NetSerializeStructOffset = InitFromStructProperty<BuildType>(NewSharedParams, NewStackParams, StructProp, Struct);

        if (StackParams.RecursingNetSerializeStruct == NAME_None)
        {
            if (NewSharedParams.bHasObjectProperties)
            {
                // If this is a top level Net Serialize Struct, and we found any any objects,
                // then we need to make sure this is tracked in our map.
                SharedParams.NetSerializeLayouts->Add(SharedParams.Cmds.Num(), MoveTemp(TempCmds));
                StackParams.bNetSerializeStructWithObjects = true;
            }
        }
        else if (!NewSharedParams.bHasObjectProperties)
        {
            // If this wasn't a top level Net Serialize Struct, and we didn't find any objects,
            // we need to remove any nested entries we added to the Net Serialize Struct's layout.
            // Instead, we'll assume this layout is FProperty safe, and add it as single command (below).
            SharedParams.Cmds.SetNum(PrevCmdNum);
        }
        else
        {
            // This wasn't a top level Net Serialize Struct, but we did find some objects.
            // We want to keep the layout we generated, so keep that layout
            return NetSerializeStructOffset;
        }
    }

    ++StackParams.RelativeHandle;
    AddPropertyCmd(SharedParams, StackParams);

    return StackParams.RelativeHandle;
}
```

简单的图示如下：

```cpp
+------------------+------------------+
|     int a        |  TArray<int> b   |
+------------------+------------------+
```

```cpp
+------------------+------------------+
|RepParentCmd a    |RepParentCmd b   |
|Offset:0          |Offset:4         |
|CmdStart:0        |CmdStart:1       |
|CmdEnd:1          |CmdEnd:3         |
+------------------+------------------+
```

此处**设置同步条件**，并赋值给 ParentCmd，比如说是不是初始化同步，或者是只同步给 Owner 之类的条件。

```cpp
// Initialize lifetime props
// Properties that replicate for the lifetime of the channel
TArray<FLifetimeProperty> LifetimeProps;
LifetimeProps.Reserve(Parents.Num());

UObject* Object = InObjectClass->GetDefaultObject();

Object->GetLifetimeReplicatedProps(LifetimeProps);
```

建立Handle到Cmd数组的映射，主要因为动态Array需要特殊处理，存到 `TArray<FHandleToCmdIndex> BaseHandleToCmdIndex;`

```cpp
if (!ServerConnection || EnumHasAnyFlags(CreateFlags, ECreateRepLayoutFlags::MaySendProperties))
{
    BuildHandleToCmdIndexTable_r(0, Cmds.Num() - 1, BaseHandleToCmdIndex);
}
```

最后计算 ShadowOffset 也就是在 ShadowBuffer 的偏移。

```cpp
BuildShadowOffsets<ERepBuildType::Class>(InObjectClass, Parents, Cmds, ShadowDataBufferSize);
```

按内存对齐，减小内存占用。

```cpp
template<ERepBuildType ShadowType>
static void BuildShadowOffsets(
	UStruct* Owner,
	TArray<FRepParentCmd>& Parents,
	TArray<FRepLayoutCmd>& Cmds,
	int32& ShadowOffset)
{
    struct FParentCmdIndexAndAlignment
    {
        FParentCmdIndexAndAlignment(int32 ParentIndex, const FRepParentCmd& Parent):
            Index(ParentIndex),
            Alignment(Parent.Property->GetMinAlignment())
        {
        }

        const int32 Index;
        const int32 Alignment;

        // Needed for sorting.
        bool operator< (const FParentCmdIndexAndAlignment& RHS) const
        {
            return Alignment < RHS.Alignment;
        }
    };

    TArray<FParentCmdIndexAndAlignment> IndexAndAlignmentArray;
    IndexAndAlignmentArray.Reserve(Parents.Num());
    for (int32 i = 0; i < Parents.Num(); ++i)
    {
        IndexAndAlignmentArray.Emplace(i, Parents[i]);
    }

    IndexAndAlignmentArray.StableSort();
}
```

还会对 bool 进行特殊处理，每个 bool 值只占 1bit，具体可以查阅 `BuildShadowOffsets_r` ，就不一一列出了。至此解决了属性应该如何存放到 ShadowBuffer 的问题。

`FRepLayout` 会被存放到 `NetDriver` 中，而不是只放到 `NetConnection` 中，因为一个 Actor 可能同步给多个 Client，没必要比较多次。

### 理解同步过程中所需的数据结构

在继续往下学习属性同步之前，需要先理解以下一些数据结构。

- FObjectReplicator

可以理解为对象的同步器，内部存有 `FRepLayout`、`FRepState`、`FReplicationChangelistMgr`，将这些功能串联起来。

- FRepLayout

描述同步属性的信息和内存布局，NetDriver 中存放，可给多条连接共享。

- FRepState

表示该对象在一条连接下的发送接收状态，因为每条连接的同步速率可能是不同的，所以需要单独记录。

- FReplicationChangelistMgr

里面有个 `RepChangelistState` 是用来做属性对比的，里面还会记录历史变更。

- FRepChangedPropertyTracker

因为属性同步是有条件的，比如同步条件是仅在初始化时同步，那么之后就不需要同步该属性了，这个类就是用来跟踪哪些属性的同步条件发生了变更的。

这些数据结构会在 `UActorChannel::SetChannelActor` 中构造，前面为 Actor 创建 ActorChannel 时提到过，此处重点在于 创建了 `FObjectReplicator` 。

```cpp
void UActorChannel::SetChannelActor(AActor* InActor, ESetChannelActorFlags Flags)
{
    if (!EnumHasAnyFlags(Flags, ESetChannelActorFlags::SkipReplicatorCreation))
    {
        ActorReplicator = FindOrCreateReplicator(Actor);
    }
}
```

```cpp
TSharedPtr<FObjectReplicator> UNetConnection::CreateReplicatorForNewActorChannel(UObject* Object)
{
    TSharedPtr<FObjectReplicator> NewReplicator = MakeShareable(new FObjectReplicator());
    NewReplicator->InitWithObject( Object, this, true );
    return NewReplicator;
}
```

随后创建了 `FRepState` ，用于记录该连接下的属性发送接收状态信息。

在 `FObjectReplicator` StartReplicating 时，先构造出 `FReplicationChangelistMgr` 然后立刻构造出  `FRepChangelistState` 它就是用来做属性比对的，自然 ShadowBuffer 就是它构造的。

```cpp
void FObjectReplicator::StartReplicating(class UActorChannel * InActorChannel)
{
    if (WorldNetDriver && WorldNetDriver->IsServer())
    {
        ChangelistMgr = WorldNetDriver->GetReplicationChangeListMgr(Object);
    }
}
```

```cpp
FRepChangelistState::FRepChangelistState(
    const TSharedRef<const FRepLayout>& InRepLayout,
    const uint8* InSource,
    const UObject* InRepresenting,
    FCustomDeltaChangelistState* InDeltaChangelistState)

    : CustomDeltaChangelistState(InDeltaChangelistState)
    , HistoryStart(0)
    , HistoryEnd(0)
    , CompareIndex(0)
    , StaticBuffer(InRepLayout->CreateShadowBuffer(InSource))
}
```

构造出 ShadowBuffer，里面就是需要同步的属性的内存，

### 比较属性

比较属性的调用路径如下：

```cpp
bool FObjectReplicator::ReplicateProperties(FOutBunch& Bunch, FReplicationFlags RepFlags)
{
    LLM_SCOPE_BYTAG(NetObjReplicator);
    FNetBitWriter Writer(Bunch.PackageMap, 8192);
    return ReplicateProperties_r(Bunch, RepFlags, Writer);
}
```

```cpp
bool FObjectReplicator::ReplicateProperties_r( FOutBunch & Bunch, FReplicationFlags RepFlags, FNetBitWriter& Writer)
{
    UObject* Object = GetObject();

    FSendingRepState* SendingRepState = (bUseCheckpointRepState && CheckpointRepState.IsValid()) ? CheckpointRepState->GetSendingRepState() : RepState->GetSendingRepState();

    const ERepLayoutResult UpdateResult = FNetSerializeCB::UpdateChangelistMgr(*RepLayout, SendingRepState, *ChangelistMgr, Object, Connection->Driver->ReplicationFrame, RepFlags, OwningChannel->bForceCompareProperties || bUseCheckpointRepState);
}
```

```cpp
ERepLayoutResult FRepLayout::UpdateChangelistMgr(
	FSendingRepState* RESTRICT RepState,
	FReplicationChangelistMgr& InChangelistMgr,
	const UObject* InObject,
	const uint32 ReplicationFrame,
	const FReplicationFlags& RepFlags,
	const bool bForceCompare) const
{
    Result = CompareProperties(RepState, &InChangelistMgr.RepChangelistState, (const uint8*)InObject, RepFlags, bForceCompare);
    return Result;
}
```

在比较属性之前，通过循环队列开辟一个新的 changeHistory，记录这次的属性变更。

```cpp
ERepLayoutResult FRepLayout::CompareProperties(
	FSendingRepState* RESTRICT RepState,
	FRepChangelistState* RESTRICT RepChangelistState,
	const FConstRepObjectDataBuffer Data,
	const FReplicationFlags& RepFlags,
	const bool bForceCompare) const
{
    RepChangelistState->CompareIndex++;

    const int32 HistoryIndex = RepChangelistState->HistoryEnd % FRepChangelistState::MAX_CHANGE_HISTORY;
    FRepChangedHistory& NewHistoryItem = RepChangelistState->ChangeHistory[HistoryIndex];

    TArray<uint16>& Changed = NewHistoryItem.Changed;
    Changed.Empty(1);

    ERepLayoutResult Result = ERepLayoutResult::Success;

    CompareParentProperties(SharedParams, StackParams);

    // Null terminator
    Changed.Add(0);

    // Move end pointer
    RepChangelistState->HistoryEnd++;
}
```

若 变更记录满了，则进行合并。

```cpp
if ((RepChangelistState->HistoryEnd - RepChangelistState->HistoryStart) == FRepChangelistState::MAX_CHANGE_HISTORY)
{
    const int32 FirstHistoryIndex = RepChangelistState->HistoryStart % FRepChangelistState::MAX_CHANGE_HISTORY;

    RepChangelistState->HistoryStart++;

    const int32 SecondHistoryIndex = RepChangelistState->HistoryStart % FRepChangelistState::MAX_CHANGE_HISTORY;

    TArray<uint16>& FirstChangelistRef = RepChangelistState->ChangeHistory[FirstHistoryIndex].Changed;
    TArray<uint16> SecondChangelistCopy = MoveTemp(RepChangelistState->ChangeHistory[SecondHistoryIndex].Changed);

    MergeChangeList(Data, FirstChangelistRef, SecondChangelistCopy, RepChangelistState->ChangeHistory[SecondHistoryIndex].Changed);
}
```

属性比较最终会到这，若发生变更，则将 Handle 加入到 Changed 中。

```cpp
static uint16 CompareProperties_r(
	const FComparePropertiesSharedParams& SharedParams,
	FComparePropertiesStackParams& StackParams,
	const uint16 CmdStart,
	const uint16 CmdEnd,
	uint16 Handle)
{
    for (int32 CmdIndex = CmdStart; CmdIndex < CmdEnd; ++CmdIndex)
    {
        const FRepLayoutCmd& Cmd = SharedParams.Cmds[CmdIndex];

        check(Cmd.Type != ERepLayoutCmdType::Return);

        ++Handle;

        const FConstRepObjectDataBuffer Data = StackParams.Data + Cmd;
        FRepShadowDataBuffer ShadowData = StackParams.ShadowData + Cmd;

        if (Cmd.Type == ERepLayoutCmdType::DynamicArray)
        {
            FComparePropertiesStackParams NewStackParams{
                Data,
                ShadowData,
                StackParams.Changed,
                StackParams.Result
            };

            // Once we hit an array, start using a stack based approach
            CompareProperties_Array_r(SharedParams, NewStackParams, CmdIndex, Handle);
            CmdIndex = Cmd.EndCmd - 1;		// The -1 to handle the ++ in the for loop
            continue;
        }
        else if (SharedParams.bForceFail || !PropertiesAreIdentical(Cmd, ShadowData.Data, Data.Data, SharedParams.NetSerializeLayouts))
        {
            StoreProperty(Cmd, ShadowData.Data, Data.Data);
            StackParams.Changed.Add(Handle);
        }
    }

    return Handle;
}

```

这里需要特别注意对动态数组的处理，因为动态数组你不知道具体是有多少个，你只能写入有多少个值变更了，然后写入具体变更的 Handle，计算方式也很简单，`index * 子元素数量 + 改变的子元素handle`，若动态数组存放的是一个 int，则子元素数量为1，可简化为 index + 1。

```cpp
StackParams.Changed.Add(Handle);
StackParams.Changed.Add((uint16)NumChangedEntries);		// This is so we can jump over the array if we need to
StackParams.Changed.Append(ChangedLocal);
StackParams.Changed.Add(0);
```

也有可能数组长度减小，但数组原有的那部分完全一致，就不需要变更。

```cpp
else if (ArrayNum != ShadowArrayNum)
{
    // If nothing below us changed, we either shrunk, or we grew and our inner was an array that didn't have any elements
    check(ArrayNum < ShadowArrayNum || SharedParams.Cmds[CmdIndex + 1].Type == ERepLayoutCmdType::DynamicArray);

    // Array got smaller, send the array handle to force array size change
    StackParams.Changed.Add(Handle);
    StackParams.Changed.Add(0);
    StackParams.Changed.Add(0);
}
```

但数组若出现中间插入或删除值，则需要把后面一连串的数据一起发送，非常浪费，这也是为什么后面引入了 FastArray。

简单看下属性根据类型进行比较。

```cpp
static FORCEINLINE bool PropertiesAreIdenticalNative(
	const FRepLayoutCmd& Cmd,
	const void* A,
	const void* B,
	const TMap<FRepLayoutCmd*, TArray<FRepLayoutCmd>>& NetSerializeLayouts)
{
    switch (Cmd.Type)
    {
        case ERepLayoutCmdType::PropertyBool:
            return CompareBool(Cmd, A, B);

        case ERepLayoutCmdType::PropertyNativeBool:
            return CompareValue<bool>(A, B);

        case ERepLayoutCmdType::PropertyByte:
            return CompareValue<uint8>(A, B);
        ......
    }
}
```

比较属性只需要走一次就可以了，后续同一帧内，不同的连接可以直接复用，所以 `UpdateChangelistMgr` 可以直接返回结果。

```cpp
ERepLayoutResult FRepLayout::UpdateChangelistMgr()
{
    if (!bForceCompare && GShareShadowState && !RepFlags.bNetInitial && RepState->LastCompareIndex > 1 && InChangelistMgr.LastReplicationFrame == ReplicationFrame)
    {
        return Result;
    }
)
```

属性比较完成后，还会将新属性更新到 ShadowBuffer 中。

### 发送变更属性

将所有变更记录，合并到当前连接所属的变更记录中，也就是 RepState 中，还是那句话，每条连接的同步进度是不同的，所以要为每条连接单独弄个 History 循环队列。

```cpp
bool FObjectReplicator::ReplicateProperties_r( FOutBunch & Bunch, FReplicationFlags RepFlags, FNetBitWriter& Writer)
{
    const bool bHasRepLayout = RepLayout->ReplicateProperties(SendingRepState, ChangelistMgr->GetRepChangelistState(), (uint8*)Object, ObjectClass, OwningChannel, Writer, RepFlags);
}
```

```cpp
bool FRepLayout::ReplicateProperties(
	FSendingRepState* RESTRICT RepState,
	FRepChangelistState* RESTRICT RepChangelistState,
	const FConstRepObjectDataBuffer Data,
	UClass* ObjectClass,
	UActorChannel* OwningChannel,
	FNetBitWriter& Writer,
	const FReplicationFlags& RepFlags) const
{
    // Gather all change lists that are new since we last looked, and merge them all together into a single CL
    for (int32 i = RepState->LastChangelistIndex; i < RepChangelistState->HistoryEnd; ++i)
    {
        const int32 HistoryIndex = i % FRepChangelistState::MAX_CHANGE_HISTORY;

        FRepChangedHistory& HistoryItem = RepChangelistState->ChangeHistory[HistoryIndex];

        TArray<uint16> Temp = MoveTemp(Changed);
        MergeChangeList(Data, HistoryItem.Changed, Temp, Changed);
    }

    // Merge in newly active properties so they can be sent.
    if (NewlyActiveChangelist.Num() > 0)
    {
        TArray<uint16> Temp = MoveTemp(Changed);
        MergeChangeList(Data, NewlyActiveChangelist, Temp, Changed);
    }
}
```

`UpdateChangelistHistory` 指的是更新当前 RepState 的 历史记录，就是更新当前连接的历史项，当对方已经确认收到之后，就可以去掉这条历史记录了。

`PreOpenAckHistory` 指的是在对方打开这个 ActorChannel 的过程，产生的变更，需要临时记下来，随着对端创建该 ActorChannel 也要把这些属性变更下发过去。

```cpp
if (Changed.Num() > 0 || RepState->NumNaks > 0 || bFlushPreOpenAckHistory)
{
    RepState->HistoryEnd++;

    UpdateChangelistHistory(RepState, ObjectClass, Data, OwningChannel->Connection, &Changed);

    // Merge in the PreOpenAckHistory (unreliable properties sent before the bunch was initially acked)
    if (bFlushPreOpenAckHistory)
    {
        for (int32 i = 0; i < RepState->PreOpenAckHistory.Num(); i++)
        {
            TArray<uint16> Temp = MoveTemp(Changed);
            MergeChangeList(Data, RepState->PreOpenAckHistory[i].Changed, Temp, Changed);
        }
        RepState->PreOpenAckHistory.Empty();
    }
}
else
{
    // Nothing changed and there are no nak's, so just do normal housekeeping and remove acked history items
    UpdateChangelistHistory(RepState, ObjectClass, Data, OwningChannel->Connection, nullptr);
    return false;
}
```

一个小优化，共享序列化好的数据，避免反复序列化。

```cpp
if (!OwningChannel->Connection->IsInternalAck() && (GNetSharedSerializedData != 0))
{
    // if no shared serialization info exists, build it
    if (!RepChangelistState->SharedSerialization.IsValid())
    {
        BuildSharedSerialization(Data, Changed, true, RepChangelistState->SharedSerialization);
    }
}
```

最终将属性发送出去。

```cpp
else if (Changed.Num() > 0)
{
    SendProperties(RepState, ChangeTracker, Data, ObjectClass, Writer, Changed, RepChangelistState->SharedSerialization, RepFlags.bSerializePropertyNames ? ESerializePropertyType::Name : ESerializePropertyType::Handle);
}
```

`WriteContentBlockPayload` 主要用于区分当前数据来自于 Actor 还是 ActorComponent。

```cpp
bool FObjectReplicator::ReplicateProperties_r( FOutBunch & Bunch, FReplicationFlags RepFlags, FNetBitWriter& Writer)
{
    if ( WroteImportantData )
    {
        OwningChannel->WriteContentBlockPayload( Object, Bunch, bHasRepLayout, Writer );
    }

    return WroteImportantData;
}
```

这个 Block 会追加到 真正的属性数据之前，所以才叫 BlockHeader。

```cpp
int32 UActorChannel::WriteContentBlockPayload( UObject* Obj, FNetBitWriter &Bunch, const bool bHasRepLayout, FNetBitWriter& Payload )
{
    const int32 StartHeaderBits = Bunch.GetNumBits();

    // Trace header
    {
        WriteContentBlockHeader( Obj, Bunch, bHasRepLayout );

        uint32 NumPayloadBits = Payload.GetNumBits();

        Bunch.SerializeIntPacked( NumPayloadBits );
    }

    const int32 HeaderNumBits = Bunch.GetNumBits() - StartHeaderBits;

    Bunch.SerializeBits( Payload.GetData(), Payload.GetNumBits() );

    return HeaderNumBits;
}
```

`SendBunch` 之后，会返回 PacketRange，将其和发出的历史记录关联起来，这样丢了什么数据，马上就能查出来。

```cpp
int64 UActorChannel::ReplicateActor()
{
    if (bWroteSomethingImportant)
    {
        // We must exit the collection scope to report data correctly
        FPacketIdRange PacketRange = SendBunch( &Bunch, 1 );

        if (!bIsNewlyReplicationPaused)
        {
            for (auto RepComp = ReplicationMap.CreateIterator(); RepComp; ++RepComp)
            {
                RepComp.Value()->PostSendBunch(PacketRange, Bunch.bReliable);
            }
        }
    }
}
```

### 属性同步丢包

收到 Nak 后，会通知到 ActorChannel，随后通知到该 Packet 所携带的 Actor 的 FObjectReplicator 中。

```cpp
TMap< UObject*, TSharedRef< FObjectReplicator > > ReplicationMap;
void UActorChannel::ReceivedNak( int32 NakPacketId )
{
    UChannel::ReceivedNak(NakPacketId);	
    for (auto CompIt = ReplicationMap.CreateIterator(); CompIt; ++CompIt)
    {
        CompIt.Value()->ReceivedNak(NakPacketId);
    }
}
```

此处会将该属性变更的历史记录的 Resend 标记位 置为 true，等待后续重传(`void FRepLayout::UpdateChangelistHistory`)，属性同步丢了就丢了，反正保证每次同步的是最新的值就行。

```cpp
void FObjectReplicator::ReceivedNak( int32 NakPacketId )
{
    const UObject* Object = GetObject();
    if (!RepLayout->IsEmpty())
    {
        if (FSendingRepState* SendingRepState = RepState.IsValid() ? RepState->GetSendingRepState() : nullptr)
        {
            SendingRepState->CustomDeltaChangeIndex--;
            
            // Go over properties tracked with histories, and mark them as needing to be resent.
            for (int32 i = SendingRepState->HistoryStart; i < SendingRepState->HistoryEnd; ++i)
            {
                const int32 HistoryIndex = i % FSendingRepState::MAX_CHANGE_HISTORY;

                FRepChangedHistory& HistoryItem = SendingRepState->ChangeHistory[HistoryIndex];

                if (!HistoryItem.Resend && HistoryItem.OutPacketIdRange.InRange(NakPacketId))
                {
                    HistoryItem.Resend = true;
                    ++SendingRepState->NumNaks;
                }
            }
        }
    }
}
```

### 同步指针

```cpp
UPROPERTY(Replicated)
AActor* MyActorReference;
```

同步指针，有可能会出现这个对象还未同步给客户端，此时会先将其置空。一种很直观的思路是 记录这个属性在该类的内存偏移，下次当该 Actor 同步过来之后，再将它和这个 Actor 的 GUID 绑定。

收到 `MyActorReference` 属性后，需要将其反序列化，此时找不到该对象，则将其添加到 跟踪列表中。

```cpp
bool UPackageMapClient::SerializeObject( FArchive& Ar, UClass* Class, UObject*& Object, FNetworkGUID *OutNetGUID)
{
    else if (Ar.IsLoading())
        if ( NetGUID.IsValid() && bShouldTrackUnmappedGuids && !GuidCache->IsGUIDBroken( NetGUID, false ) )
        {
            if ( Object == nullptr )
            {
                TrackedUnmappedNetGuids.Add( NetGUID );
            }
            else if ( NetGUID.IsDynamic() )
            {
                TrackedMappedDynamicNetGuids.Add( NetGUID );
            }
        }
    }
}
```

在 `NetDriver::TickFlush` 会调用 `FObjectReplicator::UpdateUnmappedObjects` 最终调用`UpdateUnmappedObjects_r` 来更新 unmapped 的对象。

```cpp
void FRepLayout::UpdateUnmappedObjects_r(
    FReceivingRepState* RESTRICT RepState,
    FGuidReferencesMap* GuidReferencesMap,
    UObject* OriginalObject,
    UNetConnection* Connection,
    FRepShadowDataBuffer ShadowData,
    FRepObjectDataBuffer Data,
    const int32 MaxAbsOffset,
    bool& bCalledPreNetReceive,
    bool& bOutSomeObjectsWereMapped,
    bool& bOutHasMoreUnmapped) const
{
    for (auto It = GuidReferencesMap->CreateIterator(); It; ++It)
    {
        const int32 AbsOffset = It.Key();
        Cmd.Property->NetSerializeItem(Reader, Connection->PackageMap, Data + AbsOffset);
    }
}
```

![UE5_network_replicator3.png](images/UE5_network_replicator3.png)

## RPC

以 `ClientSetHUD` 为例：

```cpp
UFUNCTION(BlueprintCallable, Category="HUD", Reliable, Client)
ENGINE_API void ClientSetHUD(TSubclassOf<AHUD> NewHUDClass);
```

接收RPC 堆栈：

![UE5_network_replicator4.png](images/UE5_network_replicator4.png)

`ClientSetHUD` 其实和属性一样，都有个索引，至于参数也是用的 `FProperty` ，FRepLayout 会为 RPC 函数的参数创建一个单独的内存布局。