---
title: UE5 GameFramework Pawn 源码剖析
categories: UE5
date: 2022-02-20 15:16:20
keywords: UE4, UE5, GameFramework, APawn, Pawn
tags: [UE5, GameFramework, Pawn]
---

`UE5` 为游戏开发提供了一套基础的游戏框架，想要用好 `UE5` 首先就要去熟悉其所提供的 `GameFramework` 的接口，了解它为项目做了什么准备，为什么新建一个项目，就有一个小白人可以操纵？

本文为 `UE5 GameFramework` 的第一篇，以 `Pawn` 为起点，没有以 `Actor` 为起点主要是里面过于复杂，且与业务逻辑没什么关系。从 `Pawn` 开始学习，一是容易产生兴趣，二是稍微轻松一些，这也意味着本文会忽视各种网络同步、输入栈等细节，暂时只要知道它能为我们做什么即可，着重学习 `Pawn` 为我们提供了什么便利的东西。

## APawn

- Pawn的英文翻译过来可以是兵卒，所以如果把UE游戏看作是一场棋盘上的游戏的话，那这些Pawn就可以看作是在UE的3D世界中玩家可以操纵的棋子，而其他的Actor则可以构成棋盘等。 - **[大钊 Inside UE4](https://zhuanlan.zhihu.com/p/23321666?refer=insideue4)**

既然 `Pawn` 可以被操纵就意味着 它一定有控制它的地方，也就是 `Controller`，其次它既然能被控制，那么也需要响应 `Input`，提供给玩家自定义按键输入，记录玩家的按键输入，最后它能够被移动，也就意味着需要支持 `Collision`，避免走出墙外。

除了以上最重要的三点功能，还负责了传递 `PlayerState` 玩家数据给其他机器，支持伤害事件(尽管这是 Actor 本身就支持的)

<!-- more -->

### Controller

Pawn 作为可被操控的对象，当然需要一个控制器去操作它，控制器变更时将会通知到蓝图与代理广播。

```cpp
// 代理广播控制器变更
DECLARE_DYNAMIC_MULTICAST_SPARSE_DELEGATE_ThreeParams(FPawnControllerChangedSignature, APawn, ReceiveControllerChangedDelegate, APawn*, Pawn, AController*, OldController, AController*, NewController);

// 当前控制 Pawn 的 Controller
UPROPERTY(replicatedUsing=OnRep_Controller)
public TObjectPtr<AController> Controller;

// 上一次控制该 Pawn 的 Controller 用于通知控制器改变时使用
UPROPERTY(transient)
public TObjectPtr<AController> PreviousController;

// 通知控制器变更(蓝图 + 代理广播)，同时记录变更前的控制器
public virtual void APawn::NotifyControllerChanged()
{
    // 蓝图通知
    ReceiveControllerChanged(PreviousController, Controller);
    // 代理广播
    ReceiveControllerChangedDelegate.Broadcast(this, PreviousController, Controller);
    // 通知 GameInstance
    if (UGameInstance* GameInstance = GetGameInstance())
    {
        GameInstance->GetOnPawnControllerChanged().Broadcast(this, Controller);
    }
    PreviousController = Controller;
}
```

### ControllerRotation

选择是否使用 Controller 的旋转量，在 FaceRotation 函数中被使用，而 FaceRotation 将会被 Controller 调用。

```cpp
UPROPERTY(EditAnywhere, BlueprintReadWrite, Category=Pawn)
public uint32 bUseControllerRotationPitch:1;

UPROPERTY(EditAnywhere, BlueprintReadWrite, Category=Pawn)
public uint32 bUseControllerRotationYaw:1;

UPROPERTY(EditAnywhere, BlueprintReadWrite, Category=Pawn)
public uint32 bUseControllerRotationRoll:1;

// FaceRotation 是通过 Actor Rotation 覆盖 Control Rotation 实现
// 该函数在 APlayerController 的 UpdateRotation 中被调用
public void APawn::FaceRotation(FRotator NewControlRotation, float DeltaTime = 0.f)
{
    if (bUseControllerRotationPitch || bUseControllerRotationYaw || bUseControllerRotationRoll)
    {
        const FRotator CurrentRotation = GetActorRotation();
        if (!bUseControllerRotationPitch)
        {
            NewControlRotation.Pitch = CurrentRotation.Pitch;
        }
        ......
        SetActorRotation(NewControlRotation);
    }
}
```

### PlayerState

玩家状态数据，其实它在 Controller 中也存在一份，但是 Controller 是不会同步的，因此当 Pawn 被控制的时候，需要从 Controller 设置 PlayerState 给 Pawn，让 Pawn 来同步 PlayerState。

```cpp
UPROPERTY(replicatedUsing=OnRep_PlayerState, BlueprintReadOnly, Category=Pawn, meta=(AllowPrivateAccess="true"))
private TObjectPtr<APlayerState> PlayerState;

public virtual void APawn::OnRep_PlayerState()
{
    SetPlayerState(PlayerState);
}

// FSetPlayerStatePawn 是为了给 PlayerState 设置 PawnPrivate 所实现的一个绕过访问权限的方法 可看作 PlayerState->PawnPrivate = this;
public void APawn::SetPlayerState(APlayerState* NewPlayerState)
{
    if (PlayerState && PlayerState->GetPawn() == this)
    {
        FSetPlayerStatePawn(PlayerState, nullptr);
    }
    PlayerState = NewPlayerState;
    if (PlayerState)
    {
        FSetPlayerStatePawn(PlayerState, this);
    }
}
```

### Input

输入重载了 `Actor` 的 `EnableInput`(这也说明了 Actor 也支持输入)，在 Controller 中将根据 `InputEnabled()` 来决定是否建立输入栈，不建立则自然是不接受输入。

```cpp
// 是否接受输入, 该变量的前提是被控制(Processed)
private uint32 bInputEnabled:1;
public bool InputEnabled() const { return bInputEnabled; }

// Controller 由 PossessedBy函数传入
// EnableInput 仅有在传入的PlayerController为空或是与控制该Pawn的Controller相同
// 才可修改是否允许输入, 注意此处完全覆写了 AActor 中的 EnableInput
// 这个属性在 APlayerController 创建输入栈(BuildInputStack)的时候才有用到
public void APawn::EnableInput(class APlayerController* PlayerController) override
{
    if (PlayerController == Controller || PlayerController == nullptr)
    {
        bInputEnabled = true;
    }
    else
    {
        UE_LOG(LogPawn, Error, TEXT("EnableInput can only be specified on a Pawn for its Controller"));
    }
}

// 处理输入的 Component，bInputEnabled 开启的情况下生效
UPROPERTY(DuplicateTransient)
TObjectPtr<class UInputComponent> InputComponent;

// 创建一个支持自定义输入绑定的 component
protected virtual UInputComponent* CreatePlayerInputComponent()
{
    static const FName InputComponentName(TEXT("PawnInputComponent0"));
    return NewObject<UInputComponent>(this, UInputSettings::GetDefaultInputComponentClass(), InputComponentName);
}

// UnPossessed 脱离控制的时候，销毁输入组件
protected virtual void APawn::DestroyPlayerInputComponent()
{
    if (InputComponent)
    {
        InputComponent->DestroyComponent();
        InputComponent = nullptr;
    }
}

// 空函数，预留给子类使用 InputComponent 绑定输入按键，我们平时使用的就是这个函数
protected virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) {}
```

### Movement

接收了输入自然要能够移动，Pawn 自身已经提供了最基础的移动功能(其实也不是提供了移动功能，Pawn 本身不负责移动，而是将移动的输入存储起来，供 MovementComponent 消费使用)，其中 `UPawnMovementComponent` 的 `AddInputVector` 依然调回了 `Internal_AddMovementInput` ，应该就是方便使用者覆盖 `AddInputVector` 定制移动规则了。

带 `Internal` 前缀的都是给 `PawnMovementComponent` 直接使用的，不带前缀则是给开发者提供便利的。

```cpp
// 移动输入存储的向量, 供 MovementComponent 使用
UPROPERTY(Transient)
protected FVector ControlInputVector;

// 最后一次处理控制移动输入的向量
UPROPERTY(Transient)
protected FVector LastControlInputVector;

// 方便获取 MovementComponent, 但 APawn 本身并不自带 MovementComponent, 需要使用者自行添加注册
UFUNCTION(BlueprintCallable, meta=(Tooltip="Return our PawnMovementComponent, if we have one."), Category=Pawn)
public virtual UPawnMovementComponent* GetMovementComponent() const{
    return FindComponentByClass<UPawnMovementComponent>();
}

// 是否忽略移动输入, 在 Controller 处设置, 被 MovementComponent 所使用
public virtual bool APawn::IsMoveInputIgnored() const
{
    return Controller != nullptr && Controller->IsMoveInputIgnored();
}

// 将移动输入添加, bForce 表示是否忽略 IsMoveInputIgnored() 的返回值
UFUNCTION(BlueprintCallable, Category="Pawn|Input", meta=(Keywords="AddInput"))
public virtual void AddMovementInput(FVector WorldDirection, float ScaleValue = 1.0f, bool bForce = false) {
    UPawnMovementComponent* MovementComponent = GetMovementComponent();
    if (MovementComponent)
    {
        MovementComponent->AddInputVector(WorldDirection * ScaleValue, bForce);
    }
    else
    {
        Internal_AddMovementInput(WorldDirection * ScaleValue, bForce);
    }
}
public void Internal_AddMovementInput(FVector WorldAccel, bool bForce = false) {
    if (bForce || !IsMoveInputIgnored())
    {
        ControlInputVector += WorldAccel;
    }
}

// MovementComponent 消耗输入向量 做出移动操作
UFUNCTION(BlueprintCallable, Category="Pawn|Input", meta=(Keywords="ConsumeInput"))
public virtual FVector ConsumeMovementInputVector() {
UPawnMovementComponent* MovementComponent = GetMovementComponent();
    if (MovementComponent)
    {
        return MovementComponent->ConsumeInputVector();
    }
    else
    {
        return Internal_ConsumeMovementInputVector();
    }
}
public FVector APawn::Internal_ConsumeMovementInputVector()
{
    LastControlInputVector = ControlInputVector;
    ControlInputVector = FVector::ZeroVector;
    return LastControlInputVector;
}

// 添加旋转, 主要还是将操作转给 Controller 处理
public virtual void APawn::AddControllerPitchInput(float Val)
{
    if (Val != 0.f && Controller && Controller->IsLocalPlayerController())
    {
        APlayerController* const PC = CastChecked<APlayerController>(Controller);
        PC->AddPitchInput(Val);
    }
}
```

### Possess

我觉得应该翻译为 `附身`

- 玩家附身

```cpp
// 自动用本地哪套输入来控制该 Pawn, 用于支持单个主机多个玩家的游戏, 一般都是用 Player0
// 蓝图中设置
UPROPERTY(EditAnywhere, Category=Pawn)
TEnumAsByte<EAutoReceiveInput::Type> AutoPossessPlayer;
```

- AI 附身

```cpp
// 该 Pawn 被AI控制的条件, 与 AutoPossessPlayer 互斥
UPROPERTY(EditAnywhere, Category=Pawn)
EAutoPossessAI AutoPossessAI;

// 该 Pawn 被哪个 AIController 的子类控制 蓝图中设置
UPROPERTY(EditAnywhere, BlueprintReadWrite, meta=(DisplayName="AI Controller Class"), Category=Pawn)
TSubclassOf<AController> AIControllerClass;
```

- 控制器附身 Pawn

只能由服务端(`NM_Standalone` 的 `role` 属于 `ROLE_Authority`)调用，修改控制器后强制发给其他客户端。

如果 `Pawn` 的控制器是 `PlayerController` 则应当同步给其他客户端，最后通知给蓝图和监听该事件的代理。

```cpp
public virtual void APawn::PossessedBy(AController* NewController)
{
    SetOwner(NewController);

    AController* const OldController = Controller;
    Controller = NewController;
    ForceNetUpdate();

    if (Controller->PlayerState != nullptr)
    {
        SetPlayerState(Controller->PlayerState);
    }

    if (APlayerController* PlayerController = Cast<APlayerController>(Controller))
    {
        if (GetNetMode() != NM_Standalone)
        {
            SetReplicates(true);
            SetAutonomousProxy(true);
        }
    }
    else
    {
        CopyRemoteRoleFrom(GetDefault<APawn>());
    }

    if (OldController != NewController)
    {
        // 蓝图实现，用于通知蓝图
        ReceivePossessed(Controller);
        // 通知控制器变更(前面有介绍)
        NotifyControllerChanged();
    }
}
```

- restart

被附身后, `Controller` 会调用 `Pawn` 的 `DispatchRestart`

```cpp
public void APawn::DispatchRestart(bool bCallClientRestart)
{
    if (bCallClientRestart)
    {
        PawnClientRestart();
    }
    else
    {
        Restart();
    }
    NotifyRestarted();
}

public void APawn::Restart()
{
    UPawnMovementComponent* MovementComponent = GetMovementComponent();
    if (MovementComponent)
    {
        MovementComponent->StopMovementImmediately();
    }
    ConsumeMovementInputVector();
    RecalculateBaseEyeHeight();
}
```

- 控制器取消附身 Pawn

也是只能由服务端调用，强制更新给其他客户端，同时还原属性。

通知蓝图和监听控制器变更的代理。

```cpp
public virtual void APawn::UnPossessed()
{
    AController* const OldController = Controller;

    ForceNetUpdate();

    SetPlayerState(nullptr);
    SetOwner(nullptr);
    Controller = nullptr;

    DestroyPlayerInputComponent();

    if (OldController)
    {
        ReceiveUnpossessed(OldController);
    }
    NotifyControllerChanged();

    ConsumeMovementInputVector();
}
```

### Damage

伤害是从 `Actor` 中继承下来的，这也意味着任何一个 `Actor` 都能受到伤害。

```cpp
// 最后一次被哪个Actor的控制器击中
UPROPERTY(BlueprintReadOnly, transient, Category="Pawn")
TObjectPtr<AController> LastHitBy;

// 只有在服务器上且能够受到伤害(在 Actor中变量控制) 且 有 Gamemode 且伤害不为0 才能受伤
public virtual bool ShouldTakeDamage(float Damage, FDamageEvent const& DamageEvent, AController* EventInstigator, AActor* DamageCauser) const {
    if ((GetLocalRole() < ROLE_Authority) || !CanBeDamaged() || !GetWorld()->GetAuthGameMode() || (Damage == 0.f))
    {
        return false;
    }
    return true;
}
// 伤害通知是在父类 也就是 Actor 中做的, Pawn 中只是记录最后一次被谁的控制器打了而已
public virtual float TakeDamage(float Damage, struct FDamageEvent const& DamageEvent, AController* EventInstigator, AActor* DamageCauser) override {
    if (!ShouldTakeDamage(Damage, DamageEvent, EventInstigator, DamageCauser))
    {
        return 0.f;
    }
    const float ActualDamage = Super::TakeDamage(Damage, DamageEvent, EventInstigator, DamageCauser);
    if (ActualDamage != 0.f)
    {
        if ( EventInstigator && EventInstigator != Controller )
        {
            LastHitBy = EventInstigator;
        }
    }
    return ActualDamage;
}
```

### Lifecycle

在此处将开始关注 `Pawn` 的生命周期，为什么会在这就关注，主要是后面有个出界的处理，需要销毁对象，因此放到此处去关注。

在这里分析的生命周期不是完整的！只是 `Pawn` 中所 `override` 的。但是时序是正确的。

1. `PostLoad` 从磁盘加载后被调用
2. `PostRegisterAllComponents` 组件被注册后的回调
3. `PreInitializeComponents` 组件初始化前被调用
4. `PostInitializeComponents` 组件初始化后被调用
5. `BeginPlay` 开始游戏事件(此处没有)

```cpp
// Pawn 如果被调用了 PostLoad 则说明是从磁盘加载，则说明是处于关卡中被一起加载
// Pawn 若本身就处于关卡中，则不应该接受输入
public virtual void APawn::PostLoad() override
{
    Super::PostLoad();
    AutoReceiveInput = EAutoReceiveInput::Disabled;
}

public virtual void APawn::PostRegisterAllComponents() override
{
    Super::PostRegisterAllComponents();
    UpdateNavAgent();
}

// 使用控制器去控制 Pawn, PC->Possess 只会被 ROLE_Authority 所执行
public virtual void APawn::PreInitializeComponents()
{
    Super::PreInitializeComponents();

    if (GetInstigator() == nullptr)
    {
        SetInstigator(this);
    }

    if (AutoPossessPlayer != EAutoReceiveInput::Disabled && GetNetMode() != NM_Client )
    {
        const int32 PlayerIndex = int32(AutoPossessPlayer.GetValue()) - 1;

        APlayerController* PC = UGameplayStatics::GetPlayerController(this, PlayerIndex);
        if (PC)
        {
            PC->Possess(this);
        }
        else
        {
            GetWorld()->PersistentLevel->RegisterActorForAutoReceiveInput(this, PlayerIndex);
        }
    }
    UpdateNavigationRelevance();
}

// 主要处理 AI
public virtual void APawn::PostInitializeComponents() override
{
    QUICK_SCOPE_CYCLE_COUNTER(STAT_Pawn_PostInitComponents);

    Super::PostInitializeComponents();

    if (!IsPendingKill())
    {
        UWorld* World = GetWorld();
        if (AutoPossessPlayer == EAutoReceiveInput::Disabled
        && AutoPossessAI != EAutoPossessAI::Disabled && Controller == nullptr && GetNetMode() != NM_Client
        #if WITH_EDITOR
        && (GIsEditor == false || World->IsGameWorld())
        #endif // WITH_EDITOR
        )
        {
            const bool bPlacedInWorld = (World->bStartup);
            if ((AutoPossessAI == EAutoPossessAI::PlacedInWorldOrSpawned) ||
            (AutoPossessAI == EAutoPossessAI::PlacedInWorld && bPlacedInWorld) ||
            (AutoPossessAI == EAutoPossessAI::Spawned && !bPlacedInWorld))
            {
                // 生成 AI控制器
                SpawnDefaultController();
            }
        }
        // update movement component's nav agent values
        UpdateNavAgent();
    }
}

// 解除控制器控制
public virtual void APawn::EndPlay(const EEndPlayReason::Type EndPlayReason) override
{
    if (EndPlayReason != EEndPlayReason::Destroyed)
    {
        DetachFromControllerPendingDestroy();
    }

    Super::EndPlay(EndPlayReason);
}
```

### OutsideWorldBounds

是否超出游戏边界，这也是从 `Actor` 中继承下来的，会被 `MovementComponent` 的 `CheckStillInWorld` 所调用。

```cpp
// 用于判断是否在执行越界逻辑, 避免多次进入
private uint32 bProcessingOutsideWorldBounds : 1;

// 停止物理 动画 移动
public virtual void APawn::TurnOff()
{
    if (GetLocalRole() == ROLE_Authority)
    {
        // 同步给其他机器
        SetReplicates(true);
    }
    SetActorEnableCollision(false);
    UPawnMovementComponent* MovementComponent = GetMovementComponent();
    if (MovementComponent)
    {
        MovementComponent->StopMovementImmediately();
        MovementComponent->SetComponentTickEnabled(false);
    }
    DisableComponentsSimulatePhysics();
}

public virtual void OutsideWorldBounds() override {
if ( !bProcessingOutsideWorldBounds )
{
    bProcessingOutsideWorldBounds = true;
    // 只有权威服务器且为玩家Controller才销毁
    if (GetLocalRole() == ROLE_Authority && Cast<APlayerController>(Controller) == nullptr)
    {
        Destroy();
    }
    else
    {
        // 解除控制器控制
        DetachFromControllerPendingDestroy();
        TurnOff();
        SetActorHiddenInGame(true);
        // 设置其寿命, 为0则永生..., 默认就是0
        SetLifeSpan( FMath::Clamp(InitialLifeSpan, 0.1f, 1.0f) );
    }
    bProcessingOutsideWorldBounds = false;
    }
}
```

### Replication

加入 PlayerState, Controller, RemoteViewPitch 网络同步

```cpp
public virtual void APawn::GetLifetimeReplicatedProps( TArray< FLifetimeProperty > & OutLifetimeProps ) const
{
    Super::GetLifetimeReplicatedProps( OutLifetimeProps );

    DOREPLIFETIME( APawn, PlayerState ); 
    DOREPLIFETIME( APawn, Controller );

    DOREPLIFETIME_CONDITION( APawn, RemoteViewPitch, 	COND_SkipOwner );
}

public virtual void APawn::PreReplication( IRepChangedPropertyTracker & ChangedPropertyTracker )
{
    Super::PreReplication( ChangedPropertyTracker );

    if (GetLocalRole() == ROLE_Authority && GetController())
    {
        SetRemoteViewPitch(GetController()->GetControlRotation().Pitch);
    }
}

// Actor 自身就带了速度和位置旋转的同步 ReplicatedMovement, 因此在 Pawn 中只需要将值应用
// 当然位置和旋转量要做平滑 Smooth
virtual void PostNetReceiveLocationAndRotation() override;
virtual void PostNetReceiveVelocity(const FVector& NewVelocity) override;
```

### 碰撞

```cpp
// 返回Pawn的移动当前处于状态(站立 移动)
public virtual UPrimitiveComponent* GetMovementBase() const { return nullptr; }
```

### 杂七杂八

```cpp
// Pawn 中还默认带了个开火的空函数。。。这点令我很意外
public virtual void PawnStartFire(uint8 FireModeNum = 0) {}
```

剩下的还有弄出声音让 AI知道，以及一些辅助函数。。
