---
title: UE5 GameFramework Controller 源码剖析
categories: UE5
date: 2022-02-27 12:08:20
keywords: UE4, UE5, GameFramework, AController, Controller
tags: [UE5, GameFramework, Controller, AController]
---
一个 `Controller` 需要什么？

1. 能够控制 Pawn
2. 需要拥有位置与旋转，需要旋转是因为 我们需要根据 Controller 的旋转来控制 Pawn 的旋转，需要位置是因为我们可以提供给开发者选择是在 Controller 的位置附身 Pawn 还是 挂靠在 Pawn 的肩上
3. 需要有状态信息（StateName）Playing Spectating Inactive 运行 观察 非激活

## AController

### Constructor

`Controller` 作为一个抽象出来的控制器，自然是不需要在场景中显示的，因此会取消显示。

其次 `Controller` 只同步复制给所有者。

最后是需要一个 `SceneComponent` 组件，因为 `Controller` 需要能记录自己的位置和旋转信息。

根据以上几点初始化好 `AController` 。

```cpp
AController::AController(const FObjectInitializer& ObjectInitializer)
    : Super(ObjectInitializer)
{
    PrimaryActorTick.bCanEverTick = true;
    SetHidden(true);
#if WITH_EDITORONLY_DATA
    bHiddenEd = true;
#endif // WITH_EDITORONLY_DATA
    // 仅同步给对应客户端
    bOnlyRelevantToOwner = true;

    TransformComponent = CreateDefaultSubobject<USceneComponent>(TEXT("TransformComponent0"));
    RootComponent = TransformComponent;

    SetCanBeDamaged(false);
    bAttachToPawn = false;
    bIsPlayerController = false;
    bCanPossessWithoutAuthority = false;

    if (RootComponent)
    {
        // 因为 Controller 会附身到 Pawn 身上
        // 旋转会用到 Pawn 的局部坐标系的值
        // 设置这个参数 可以使得旋转值为世界坐标的相对量
        RootComponent->SetUsingAbsoluteRotation(true);
    }
}
```

<!-- more -->

### StateName

`Controller` 使用 `StateName` 描述当前 `Controller` 所处的游戏状态，主要有三种状态。

1. Playing 运行中
2. Spectating 观察中
3. Inactive 非激活

```cpp
UPROPERTY()
public FName StateName;

public bool IsInState(FName InStateName) const;

public FName GetStateName() const;

// 修改状态时会调用进出非激活状态的函数
public virtual void ChangeState(FName NewState)
```

预留了两个虚函数给子类实现进入非激活和结束非激活状态时的调用。

```cpp
protected virtual void BeginInactiveState();
protected virtual void EndInactiveState();
```

### StartSpot

主要是存储了该控制器的出生点，在 `GameMode` 中会使用其来产生 `Controller`。

```cpp
public TWeakObjectPtr<class AActor> StartSpot;
```

### PlayerState

玩家数据，放在 `Controller` 一是为了方便读取，二是因为 `Controller` 本身的同步只同步给其拥有者，而不同步给其他客户端，因此需要在 `Possess` 的时候，将 `PlayerState` 挂到 `Pawn` 上， `Pawn` 是会同步给所有客户端的，这样就能取到所有玩家的 `PlayerState`。

玩家数据单独为一个类，而不是将其数据直接作为成员变量放入 `Controller`，除了设计哲学上的问题，还有一点是玩家断线后，`Controller` 也会被释放，但是抽成 `PlayerState` 不会，可以在重连之后将数据重新挂到 `Controller` 身上，`Controller` 再挂到 `Pawn` 身上。

```cpp
// 只有真正的玩家才会生成 PlayerState，而AI不会有
UPROPERTY(replicatedUsing = OnRep_PlayerState, BlueprintReadOnly, Category=Controller)
TObjectPtr<APlayerState> PlayerState;

UFUNCTION()
public virtual void OnRep_PlayerState() {
    if (PlayerState != NULL)
    {
        // 只是 SetOnwner(this) 而已
        PlayerState->ClientInitialize(this);
    }
}

// 生成 PlayerState, 设置 PlayerName, 子类调用
public virtual void InitPlayerState();
```

### Pawn

`Controller` 本身会记录我们所控制的 `Pawn` ，当控制的 `Pawn` 为 `Character` 时，会将 `Character` 指针设置到 `Pawn` 身上，方便获取。

需要注意的是， `Pawn` 同步 `Controller` 与 `Controller` 同步 `Pawn` 的时机是不确定的，源码中使用 `SetPawnFromRep` 来确保 `Pawn` 先同步 `Controller` 后，还能正确调用 `OnRep_Pawn` (因为同步的时候当服务器下发的值和客户端已有的值相同则不触发回调)，但是在网络同步那块已经加了 `REPNOTIFY_Always` 哪怕相同也会调用回调，应该是修复了这个问题。

```cpp
UPROPERTY(replicatedUsing=OnRep_Pawn)
private TObjectPtr<APawn> Pawn;

private TWeakObjectPtr< APawn > OldPawn;

UPROPERTY()
private TObjectPtr<ACharacter> Character;

public virtual void AController::GetLifetimeReplicatedProps( TArray< FLifetimeProperty > & OutLifetimeProps ) const
{
    Super::GetLifetimeReplicatedProps( OutLifetimeProps );

    DOREPLIFETIME( AController, PlayerState );
    // REPNOTIFY_Always 收到服务器下发的值总是调用该属性的通知函数 OnRep_Pawn
    DOREPLIFETIME_CONDITION_NOTIFY(AController, Pawn, COND_None, REPNOTIFY_Always);
}

public virtual void AController::OnRep_Pawn()
{
    // 将旧Pawn的控制器置空
    if ( OldPawn != NULL && Pawn != OldPawn.Get() && OldPawn->Controller == this )
    {
        OldPawn->Controller = NULL;
    }
    OldPawn = Pawn;
    SetPawn(Pawn);
}

public virtual void AController::SetPawn(APawn* InPawn)
{
    RemovePawnTickDependency(Pawn);

    Pawn = InPawn;
    Character = (Pawn ? Cast<ACharacter>(Pawn) : NULL);

    AttachToPawn(Pawn);

    AddPawnTickDependency(Pawn);
}

public void AController::SetPawnFromRep(APawn* InPawn)
{
    RemovePawnTickDependency(Pawn);
    Pawn = InPawn;
    OnRep_Pawn();
}
```

### TickDependency

其实就是让 `MovementComponent` tick 之前，先执行 `Controller` 的 tick。减少了输入处理和Pawn移动之间的延迟。

```cpp
protected virtual void AddPawnTickDependency(APawn* NewPawn);

protected virtual void RemovePawnTickDependency(APawn* InOldPawn);
```

### Possess

此处可以看出， `APawn::PossessedBy` 确实是需要服务器才能调用的。

```cpp
public void AController::Possess(APawn* InPawn) {
    if (!bCanPossessWithoutAuthority && !HasAuthority())
    {
        if (!bCanPossessWithoutAuthority && !HasAuthority())
        {
            return;
        }
    }
    const APawn* CurrentPawn = GetPawn();

    const bool bNotificationRequired = (CurrentPawn != nullptr && CurrentPawn->GetController() == nullptr);
    // 空指针也会进去，由继承者自己实现
    OnPossess(InPawn);

    APawn* NewPawn = GetPawn();
    if (NewPawn != CurrentPawn || bNotificationRequired)
    {
        ReceivePossess(NewPawn);
        OnNewPawn.Broadcast(NewPawn);
    }
}

protected virtual void AController::OnPossess(APawn* InPawn)
{
    const bool bNewPawn = GetPawn() != InPawn;

    if (bNewPawn && GetPawn() != nullptr)
    {
        UnPossess();
    }

    if (InPawn == nullptr)
    {
        return;
    }

    if (InPawn->Controller != nullptr)
    {
        UE_CLOG(InPawn->Controller == this, LogController, Warning, TEXT("Asking %s to possess pawn %s more than once; pawn will be restarted! Should call Unpossess first."), *GetNameSafe(this), *GetNameSafe(InPawn));
        InPawn->Controller->UnPossess();
    }

    InPawn->PossessedBy(this);
    SetPawn(InPawn);

    // 设置当前控制旋转为 Pawn 自身的旋转
    SetControlRotation(Pawn->GetActorRotation());

    Pawn->DispatchRestart(false);
}
```

### Damage

被 `Actor::TakeDamage` 调用，传递伤害。

```cpp
void AController::InstigatedAnyDamage(float Damage, const class UDamageType* DamageType, class AActor* DamagedActor, class AActor* DamageCauser)
{
    ReceiveInstigatedAnyDamage(Damage, DamageType, DamagedActor, DamageCauser);
    OnInstigatedAnyDamage.Broadcast(Damage, DamageType, DamagedActor, DamageCauser);
}
```

### 其它

剩下的就是一些位置和旋转的设置，还有输入忽略之类的东西，留给子类去使用，至此 `AController` 就结束了(主要是全部列出来太累)。
