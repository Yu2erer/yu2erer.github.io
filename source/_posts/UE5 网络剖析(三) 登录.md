---
title: UE5 网络剖析(三) 登录
categories: UE
date: 2024-11-30 10:19:20
keywords: UE5, UDP, Bunch
tags: [UE5, 网络]
---

本文剖析 UE5 客户端与DS建立连接后的登录流程，以及 `Bunch` 的发送接收，这样之后看属性同步时，能轻松一些。

## 登录流程

书接上回，握手之后会执行 `UPendingNetGame::SendInitialJoin` 。

```cpp
void UPendingNetGame::BeginHandshake()
{
    // Kick off the connection handshake
    UNetConnection* ServerConn = NetDriver->ServerConnection;
    if (ServerConn->Handler.IsValid())
    {
        ServerConn->Handler->BeginHandshaking(
            FPacketHandlerHandshakeComplete::CreateUObject(this, &UPendingNetGame::SendInitialJoin));
    }
    else
    {
        SendInitialJoin();
    }
}
```

在继续分析之前，先来看官方的注释，描述了登录的流程。

```cpp
Most of the work for handling these control messages are done either in UWorld::NotifyControlMessage,
and UPendingNetGame::NotifyControlMessage. Briefly, the flow looks like this:

Client's UPendingNetGame::SendInitialJoin sends NMT_Hello.

Server's UWorld::NotifyControlMessage receives NMT_Hello, sends NMT_Challenge.

Client's UPendingNetGame::NotifyControlMessage receives NMT_Challenge, and sends back data in NMT_Login.

Server's UWorld::NotifyControlMessage receives NMT_Login, verifies challenge data, and then calls AGameModeBase::PreLogin.
If PreLogin doesn't report any errors, Server calls UWorld::WelcomePlayer, which call AGameModeBase::GameWelcomePlayer,
and send NMT_Welcome with map information.

Client's UPendingNetGame::NotifyControlMessage receives NMT_Welcome, reads the map info (so it can start loading later),
and sends an NMT_NetSpeed message with the configured Net Speed of the client.

Server's UWorld::NotifyControlMessage receives NMT_NetSpeed, and adjusts the connections Net Speed appropriately.
```

<!-- more -->

简单来说就是服务端接收到 ControlMessage 是在 `UWorld::NotifyControlMessage` 而客户端接收则在 `UPendingNetGame::NotifyControlMessage` 二者都是在 `UNetDriver::InitBase(bool bInitAsClient, FNetworkNotify* InNotify, const FURL& URL, bool bReuseAddressAndPort, FString& Error)` 中被设置的。当客户端登录成功后，就会将 `UPendingNetGame` 的功能转移回 `UWorld` 中。

最简登录只需要 `NMT_Hello` `NMT_Challenge` `NMT_Login` `NMT_Welcome` `NMT_NetSpeed` 这几条命令。

Control 命令定义在 `DataChannel.h`

```cpp
// message type definitions
DEFINE_CONTROL_CHANNEL_MESSAGE(Hello, 0, uint8, uint32, FString, uint16); // initial client connection message
DEFINE_CONTROL_CHANNEL_MESSAGE(Welcome, 1, FString, FString, FString); // server tells client they're ok'ed to load the server's level
DEFINE_CONTROL_CHANNEL_MESSAGE(Upgrade, 2, uint32, uint16); // server tells client their version is incompatible
DEFINE_CONTROL_CHANNEL_MESSAGE(Challenge, 3, FString); // server sends client challenge string to verify integrity
DEFINE_CONTROL_CHANNEL_MESSAGE(Netspeed, 4, int32); // client sends requested transfer rate
DEFINE_CONTROL_CHANNEL_MESSAGE(Login, 5, FString, FString, FUniqueNetIdRepl, FString); // client requests to be admitted to the game
DEFINE_CONTROL_CHANNEL_MESSAGE(Failure, 6, FString); // indicates connection failure
DEFINE_CONTROL_CHANNEL_MESSAGE(Join, 9); // final join request (spawns PlayerController)
DEFINE_CONTROL_CHANNEL_MESSAGE(JoinSplit, 10, FString, FUniqueNetIdRepl); // child player (splitscreen) join request
DEFINE_CONTROL_CHANNEL_MESSAGE(Skip, 12, FGuid); // client request to skip an optional package
DEFINE_CONTROL_CHANNEL_MESSAGE(Abort, 13, FGuid); // client informs server that it aborted a not-yet-verified package due to an UNLOAD request
DEFINE_CONTROL_CHANNEL_MESSAGE(PCSwap, 15, int32); // client tells server it has completed a swap of its Connection->Actor
DEFINE_CONTROL_CHANNEL_MESSAGE(ActorChannelFailure, 16, int32); // client tells server that it failed to open an Actor channel sent by the server (e.g. couldn't serialize Actor archetype)
DEFINE_CONTROL_CHANNEL_MESSAGE(DebugText, 17, FString); // debug text sent to all clients or to server
DEFINE_CONTROL_CHANNEL_MESSAGE(NetGUIDAssign, 18, FNetworkGUID, FString); // Explicit NetworkGUID assignment. This is rare and only happens if a netguid is only serialized client->server (this msg goes server->client to tell client what ID to use in that case)
DEFINE_CONTROL_CHANNEL_MESSAGE(SecurityViolation, 19, FString); // server tells client that it has violated security and has been disconnected
DEFINE_CONTROL_CHANNEL_MESSAGE(GameSpecific, 20, uint8, FString); // custom game-specific message routed to UGameInstance for processing
DEFINE_CONTROL_CHANNEL_MESSAGE(EncryptionAck, 21);
DEFINE_CONTROL_CHANNEL_MESSAGE(DestructionInfo, 22);
DEFINE_CONTROL_CHANNEL_MESSAGE(CloseReason, 23, FString); // Reason for client NetConnection Close, for analytics/logging
DEFINE_CONTROL_CHANNEL_MESSAGE(NetPing, 24, ENetPingControlMessage /* MessageType */, FString /* MessageStr */);
```

将宏展开可得，其实发送就是创建一个 `Bunch` 然后通过 Channel[0] 也就是 ControlChannel 将数据发送出去，这个 Channel 的创建可以从网络剖析第二篇文章中找到，关于 Bunch 的组织结构以及如何发送出去，会在下面分析，这里先跳过。

```cpp
enum { NMT_Hello = 0 };

template <>
class FNetControlMessage<0>
{
public:
    static uint8 Initialize()
    {
        FNetControlMessageInfo::SetName(0, L"Hello");
        return 0;
    }

    template <typename... ParamTypes>
    static void Send(UNetConnection* Conn, ParamTypes&... Params)
    {
        static_assert(0 < FNetControlMessageInfo::MaxNames, "Control channel message must be a byte.");
        {
            ;
        };
        if (Conn->Channels[0] != 0 && !Conn->Channels[0]->Closing)
        {
            FControlChannelOutBunch Bunch(Conn->Channels[0], false);
            uint8 MessageType = 0;
            Bunch << MessageType;
            FNetControlMessageInfo::SendParams(Bunch, Params...);
            Conn->Channels[0]->SendBunch(&Bunch, true);
        }
    }

    template <typename... ParamTypes>
    [[nodiscard]] static bool Receive(FInBunch& Bunch, ParamTypes&... Params)
    {
        FNetControlMessageInfo::ReceiveParams(Bunch, Params...);
        return !Bunch.IsError();
    }

    static void Discard(FInBunch& Bunch)
    {
        TTuple<uint8, uint32, FString, uint16> Params;
        VisitTupleElements([&Bunch](auto& Param) { Bunch << Param; }, Params);
    }
};
```

`FControlChannelOutBunch` 默认为 Reliable，若丢包会自动重传，这点在网络剖析第一篇讲过了，可不可靠是跟随 `Bunch` 的。

```cpp
FControlChannelOutBunch::FControlChannelOutBunch(UChannel* InChannel, bool bClose)
	: FOutBunch(InChannel, bClose)
{
    checkSlow(Cast<UControlChannel>(InChannel) != nullptr);
    // control channel bunches contain critical handshaking/synchronization and should always be reliable
    bReliable = true;
}
```

在 `DataChannel.h` 下方，还有 `Beacon` 的命令，这是一个插件，用于客户端还未正式建立连接时，能够执行 `RPC` ，本质原理是为客户端先创建一个同步的 `Actor` ，方便客户端在还未正式连入时，通过 `RPC` 处理一些业务逻辑，比如预排队，但这里不是重点，跳过。

```cpp
DEFINE_CONTROL_CHANNEL_MESSAGE(BeaconWelcome, 25); // server tells client they're ok to attempt to join (client sends netspeed/beacontype)
....
```

### NMT_Hello

告知DS，客户端是否为小端架构、本地网络版本和验证 `Token` 。

```cpp
void UPendingNetGame::SendInitialJoin()
{
    FNetControlMessage<NMT_Hello>::Send(ServerConn, IsLittleEndian, LocalNetworkVersion, EncryptionToken, LocalNetworkFeatures);
}
```

### NMT_Challenge

服务端收到之后，会尝试对 Token 进行校验， `OnReceivedNetworkEncryptionToken` Delegate 默认在 GameInstance 中绑定，因此若需要自定义 Token 校验逻辑，可继承 `GameInstance::ReceivedNetworkEncryptionToken` 。

```cpp
void UWorld::NotifyControlMessage(UNetConnection* Connection, uint8 MessageType, class FInBunch& Bunch)
{
    case NMT_Hello:
    {
        uint8 IsLittleEndian = 0;
        uint32 RemoteNetworkVersion = 0;
        uint32 LocalNetworkVersion = FNetworkVersion::GetLocalNetworkVersion();
        FString EncryptionToken;

        EEngineNetworkRuntimeFeatures LocalNetworkFeatures = NetDriver->GetNetworkRuntimeFeatures();
        EEngineNetworkRuntimeFeatures RemoteNetworkFeatures = EEngineNetworkRuntimeFeatures::None;

        if (FNetControlMessage<NMT_Hello>::Receive(Bunch, IsLittleEndian, RemoteNetworkVersion, EncryptionToken, RemoteNetworkFeatures))
        {
                else
                {
                    if (FNetDelegates::OnReceivedNetworkEncryptionToken.IsBound())
                    {
                        FNetDelegates::OnReceivedNetworkEncryptionToken.Execute(EncryptionToken,
                            FOnEncryptionKeyResponse::CreateUObject(Connection, &UNetConnection::SendChallengeControlMessage));
                    }
                }
            }
        }
        break;
    }
}
```

客户端收到 NMT_Challenge 后，拼凑 URL 告知服务端自己的别名，以及ID。

```cpp
void UPendingNetGame::NotifyControlMessage(UNetConnection* Connection, uint8 MessageType, class FInBunch& Bunch)
{
    case NMT_Challenge:
    {
        // Challenged by server.
        if (FNetControlMessage<NMT_Challenge>::Receive(Bunch, Connection->Challenge))
        {
            FURL PartialURL(URL);
            PartialURL.Host = TEXT("");
            PartialURL.Port = PartialURL.UrlConfig.DefaultPort; // HACK: Need to fix URL parsing 
            PartialURL.Map = TEXT("");

            for (int32 i = URL.Op.Num() - 1; i >= 0; i--)
            {
                if (URL.Op[i].Left(5) == TEXT("game="))
                {
                    URL.Op.RemoveAt(i);
                }
            }

            ULocalPlayer* LocalPlayer = GEngine->GetFirstGamePlayer(this);
            if (LocalPlayer)
            {
                // Send the player nickname if available
                FString OverrideName = LocalPlayer->GetNickname();
                if (OverrideName.Len() > 0)
                {
                    PartialURL.AddOption(*FString::Printf(TEXT("Name=%s"), *OverrideName));
                }

                // Send any game-specific url options for this player
                FString GameUrlOptions = LocalPlayer->GetGameLoginOptions();
                if (GameUrlOptions.Len() > 0)
                {
                    PartialURL.AddOption(*FString::Printf(TEXT("%s"), *GameUrlOptions));
                }

                // Send the player unique Id at login
                Connection->PlayerId = LocalPlayer->GetPreferredUniqueNetId();
            }

            // Send the player's online platform name
            FName OnlinePlatformName = NAME_None;
            if (const FWorldContext* const WorldContext = GEngine->GetWorldContextFromPendingNetGame(this))
            {
                if (WorldContext->OwningGameInstance)
                {
                    OnlinePlatformName = WorldContext->OwningGameInstance->GetOnlinePlatformName();
                }
            }

            Connection->ClientResponse = TEXT("0");
            FString URLString(PartialURL.ToString());
            FString OnlinePlatformNameString = OnlinePlatformName.ToString();

            FNetControlMessage<NMT_Login>::Send(Connection, Connection->ClientResponse, URLString, Connection->PlayerId, OnlinePlatformNameString);
            NetDriver->ServerConnection->FlushNet();
        }
        break;
    }
}
```

### NMT_Login

服务端收到客户端的 `NMT_Login` 后就拥有玩家的ID，此时进入 `void AGameModeBase::PreLogin` 。

```cpp
void UWorld::NotifyControlMessage(UNetConnection* Connection, uint8 MessageType, class FInBunch& Bunch)
{
    case NMT_Login:
    {
        // Admit or deny the player here.
        FUniqueNetIdRepl UniqueIdRepl;
        FString OnlinePlatformName;
        FString& RequestURL = Connection->RequestURL;

        // Expand the maximum string serialization size, to accommodate extremely large Fortnite join URL's.
        Bunch.ArMaxSerializeSize += (16 * 1024 * 1024);

        bool bReceived = FNetControlMessage<NMT_Login>::Receive(Bunch, Connection->ClientResponse, RequestURL, UniqueIdRepl,
                                                                OnlinePlatformName);

        Bunch.ArMaxSerializeSize -= (16 * 1024 * 1024);

        if (bReceived)
        {
            // Only the options/portal for the URL should be used during join
            const TCHAR* NewRequestURL = *RequestURL;

            for (; *NewRequestURL != '\0' && *NewRequestURL != '?' && *NewRequestURL != '#'; NewRequestURL++){}

            // Compromise for passing splitscreen playercount through to gameplay login code,
            // without adding a lot of extra unnecessary complexity throughout the login code.
            // NOTE: This code differs from NMT_JoinSplit, by counting + 1 for SplitscreenCount
            //			(since this is the primary connection, not counted in Children)
            FURL InURL( NULL, NewRequestURL, TRAVEL_Absolute );

            RequestURL = InURL.ToString();

            // skip to the first option in the URL
            const TCHAR* Tmp = *RequestURL;
            for (; *Tmp && *Tmp != '?'; Tmp++);

            // keep track of net id for player associated with remote connection
            Connection->PlayerId = UniqueIdRepl;

            // keep track of the online platform the player associated with this connection is using.
            Connection->SetPlayerOnlinePlatformName(FName(*OnlinePlatformName));

            // ask the game code if this player can join
            AGameModeBase* GameMode = GetAuthGameMode();
            AGameModeBase::FOnPreLoginCompleteDelegate OnComplete = AGameModeBase::FOnPreLoginCompleteDelegate::CreateUObject(
                this, &UWorld::PreLoginComplete, TWeakObjectPtr<UNetConnection>(Connection));
            if (GameMode)
            {
                GameMode->PreLoginAsync(Tmp, Connection->LowLevelGetRemoteAddress(), Connection->PlayerId, OnComplete);
            }
            else
            {
                OnComplete.ExecuteIfBound(FString());
            }
        }

        break;
    }
}
```

```cpp
void AGameModeBase::PreLogin(const FString& Options, const FString& Address, const FUniqueNetIdRepl& UniqueId, FString& ErrorMessage)
{
    // Login unique id must match server expected unique id type OR No unique id could mean game doesn't use them
    const bool bUniqueIdCheckOk = (!UniqueId.IsValid() || UOnlineEngineInterface::Get()->IsCompatibleUniqueNetId(UniqueId));
    if (bUniqueIdCheckOk)
    {
        ErrorMessage = GameSession->ApproveLogin(Options);
    }
    else
    {
        ErrorMessage = TEXT("incompatible_unique_net_id");
    }

    FGameModeEvents::GameModePreLoginEvent.Broadcast(this, UniqueId, ErrorMessage);
}
```

`GameSession->ApproveLogin` 中会校验是否用满员，有需要的话，可以重写 `bool AGameSession::AtCapacity(bool bSpectator)` 自定义是否满员逻辑，默认最多16人，不算观战者。

```cpp
FString AGameSession::ApproveLogin(const FString& Options)
{
    UWorld* const World = GetWorld();
    AGameModeBase* const GameMode = World->GetAuthGameMode();

    int32 SpectatorOnly = 0;
    SpectatorOnly = UGameplayStatics::GetIntOption(Options, TEXT("SpectatorOnly"), SpectatorOnly);

    if (AtCapacity(SpectatorOnly == 1))
    {
        return TEXT( "Server full." );
    }

    int32 SplitscreenCount = 0;
    SplitscreenCount = UGameplayStatics::GetIntOption(Options, TEXT("SplitscreenCount"), SplitscreenCount);

    if (SplitscreenCount > MaxSplitscreensPerConnection)
    {
        UE_LOG(LogGameSession, Warning, TEXT("ApproveLogin: A maximum of %i splitscreen players are allowed"), MaxSplitscreensPerConnection);
        return TEXT("Maximum splitscreen players");
    }

    return TEXT("");
}
```

失败则发送 `NMT_Failure` ，否则 `WelcomePlayer()`

```cpp
void UWorld::PreLoginComplete(const FString& ErrorMsg, TWeakObjectPtr<UNetConnection> WeakConnection)
{
    UNetConnection* Connection = WeakConnection.Get();
    if (!PreLoginCheckError(Connection, ErrorMsg))
    {
        return;
    }

    WelcomePlayer(Connection);
}
```

服务端有机会通过 `GameInstance::ModifyClientTravelLevelURL` 来修改 LevelName，这里默认是空的，需要的话也是重写。最后发送地图名和GameMode路径给客户端。

`GameModeBase::GameWelcomePlayer` 默认也是空的，官方说是可以利用它发送 `NMT_GameSpecific` 来通知客户端需要 `DLC` 才可进入。

```cpp
void UWorld::WelcomePlayer(UNetConnection* Connection)
{
    FString LevelName;

    const FSeamlessTravelHandler& SeamlessTravelHandler = GEngine->SeamlessTravelHandlerForWorld(this);
    if (SeamlessTravelHandler.IsInTransition())
    {
        // Tell the client to go to the destination map
        LevelName = SeamlessTravelHandler.GetDestinationMapName();
        Connection->SetClientWorldPackageName(NAME_None);
    }
    else
    {
        LevelName = CurrentLevel->GetOutermost()->GetName();
        Connection->SetClientWorldPackageName(CurrentLevel->GetOutermost()->GetFName());
    }
    if (UGameInstance* GameInst = GetGameInstance())
    {
        GameInst->ModifyClientTravelLevelURL(LevelName);
    }

    FString GameName;
    FString RedirectURL;
    if (AuthorityGameMode != NULL)
    {
        GameName = AuthorityGameMode->GetClass()->GetPathName();
        AuthorityGameMode->GameWelcomePlayer(Connection, RedirectURL);
    }

    FNetControlMessage<NMT_Welcome>::Send(Connection, LevelName, GameName, RedirectURL);
}
```

### NMT_Welcome

客户端收到要进入的地图后，设置一下变量，后续 `UEngine::TickWorldTravel` 会进行真正加载地图。

```cpp
void UPendingNetGame::NotifyControlMessage(UNetConnection* Connection, uint8 MessageType, class FInBunch& Bunch)
{
    case NMT_Welcome:
    {
        // Server accepted connection.
        FString GameName;
        FString RedirectURL;

        if (FNetControlMessage<NMT_Welcome>::Receive(Bunch, URL.Map, GameName, RedirectURL))
        {
            // extract map name and options
            {
                FURL DefaultURL;
                FURL TempURL(&DefaultURL, *URL.Map, TRAVEL_Partial);
                URL.Map = TempURL.Map;
                URL.RedirectURL = RedirectURL;
                URL.Op.Append(TempURL.Op);
            }

            if (GameName.Len() > 0)
            {
                URL.AddOption(*FString::Printf(TEXT("game=%s"), *GameName));
            }

            // Send out netspeed now that we're connected
            FNetControlMessage<NMT_Netspeed>::Send(Connection, Connection->CurrentNetSpeed);

            // We have successfully connected
            // TickWorldTravel will load the map and call LoadMapCompleted which eventually calls SendJoin
            bSuccessfullyConnected = true;
        }
        else
        {
            URL.Map.Empty();
        }

        break;
    }
}
```

### NMT_Netspeed

这个就是双方对网速，用于之后限流。但默认不开。

```cpp
TAutoConsoleVariable<int32> CVarNetEnableCongestionControl(TEXT("net.EnableCongestionControl"), 0,
	TEXT("Enables congestion control module."));
if (FNetControlMessage<NMT_Netspeed>::Receive(Bunch, Rate))
{
    Connection->CurrentNetSpeed = FMath::Clamp(Rate, 1800, NetDriver->MaxClientRate);
}
```

### NMT_Join

客户端加载地图后，会将 PendingNetGame 中的 NetDriver 转移给 UWorld，同时还会将之后的 Control Message 回调转移到 UWorld 中。

```cpp
void UEngine::MovePendingLevel(FWorldContext &Context)
{
    Context.World()->SetNetDriver(Context.PendingNetGame->NetDriver);

    UNetDriver* NetDriver = Context.PendingNetGame->NetDriver;
    if (NetDriver)
    {
        // The pending net driver is renamed to the current "game net driver"
        NetDriver->SetNetDriverName(NAME_GameNetDriver);
        NetDriver->SetWorld(Context.World());
    }
}
```

用完 PendingNetGame 发完 NMT_Join，就不需要它了。

```cpp
void UPendingNetGame::TravelCompleted(UEngine* Engine, FWorldContext& Context)
{
    // Show connecting message, cause precaching to occur.
    Engine->TransitionType = ETransitionType::Connecting;

    Engine->RedrawViewports(false);

    // Send join.
    Context.PendingNetGame->SendJoin();
    Context.PendingNetGame->NetDriver = NULL;
}
```

服务端收到 NMT_Join ，则是要为客户端创建 PlayerController，之后通过 PlayerController::ClientTravelInternal RPC 通知到客户端。

```cpp
void UWorld::NotifyControlMessage(UNetConnection* Connection, uint8 MessageType, class FInBunch& Bunch)
{
    case NMT_Join:
    {
        if (Connection->PlayerController == NULL)
        {
            // Spawn the player-actor for this network player.
            FString ErrorMsg;

            FURL InURL( NULL, *Connection->RequestURL, TRAVEL_Absolute );

            Connection->PlayerController = SpawnPlayActor( Connection, ROLE_AutonomousProxy, InURL, Connection->PlayerId, ErrorMsg );

            // Successfully in game.
            UE_LOG(LogNet, Log, TEXT("Join succeeded: %s"), *Connection->PlayerController->PlayerState->GetPlayerName());
            NETWORK_PROFILER(GNetworkProfiler.TrackEvent(TEXT("JOIN"), *Connection->PlayerController->PlayerState->GetPlayerName(), Connection));

            Connection->SetClientLoginState(EClientLoginState::ReceivedJoin);

            // if we're in the middle of a transition or the client is in the wrong world, tell it to travel
            FString LevelName;
            FSeamlessTravelHandler &SeamlessTravelHandler = GEngine->SeamlessTravelHandlerForWorld( this );

            if (SeamlessTravelHandler.IsInTransition())
            {
                // tell the client to go to the destination map
                LevelName = SeamlessTravelHandler.GetDestinationMapName();
            }
            else if (!Connection->PlayerController->HasClientLoadedCurrentWorld())
            {
                // tell the client to go to our current map
                FString NewLevelName = GetOutermost()->GetName();
                UE_LOG(LogNet, Log, TEXT("Client joined but was sent to another level. Asking client to travel to: '%s'"), *NewLevelName);
                LevelName = NewLevelName;
            }
            if (LevelName != TEXT(""))
            {
                Connection->PlayerController->ClientTravel(LevelName, TRAVEL_Relative, true);
            }

            // @TODO FIXME - TEMP HACK? - clear queue on join
            Connection->QueuedBits = 0;
        }
        break;
    }
}
```

`SpawnPlayActor` 就是创建 PlayerController 的地方，使用 GameMode::Login，创建 PlayerController，并设置相应的同步参数即可，最终将该玩家的PlayerController注册到 GameSession中。

```cpp
APlayerController* UWorld::SpawnPlayActor(UPlayer* NewPlayer, ENetRole RemoteRole, const FURL& InURL, const FUniqueNetIdRepl& UniqueId, FString& Error, uint8 InNetPlayerIndex)
{
    if (AGameModeBase* const GameMode = GetAuthGameMode())
    {
        // Give the GameMode a chance to accept the login
        APlayerController* const NewPlayerController = GameMode->Login(NewPlayer, RemoteRole, *InURL.Portal, Options, UniqueId, Error);
        if (NewPlayerController == NULL)
        {
            UE_LOG(LogSpawn, Warning, TEXT("Login failed: %s"), *Error);
            return NULL;
        }

        UE_LOG(LogSpawn, Log, TEXT("%s got player %s [%s]"), *NewPlayerController->GetName(), *NewPlayer->GetName(), UniqueId.IsValid() ? *UniqueId->ToString() : TEXT("Invalid"));

        // Possess the newly-spawned player.
        NewPlayerController->NetPlayerIndex = InNetPlayerIndex;
        NewPlayerController->SetRole(ROLE_Authority);
        NewPlayerController->SetReplicates(RemoteRole != ROLE_None);
        if (RemoteRole == ROLE_AutonomousProxy)
        {
            NewPlayerController->SetAutonomousProxy(true);
        }
        NewPlayerController->SetPlayer(NewPlayer);
        GameMode->PostLogin(NewPlayerController);
        return NewPlayerController;
    }
}
```

PostLogin 则是使用RPC创建HUD之类的东西，至此整个登录流程就已经走完了。

### 登录总结

1. NMT_Hello
    - Client：通知大小端、网络版本号、Token
    - Server：校验版本号、Token
2. NMT_Challenge
    - Server：发送校验信息给客户端(但好像没用上)
    - Client：收到校验信息
3. NMT_Login
    - Client：通过拼接URL 告知服务端自己的别名和 ID
    - Server：检查是否满员，`GameMode::PreLogin`
4. NMT_Welcome
    - Server：通知客户端当前的地图名和 GameMode 路径
    - Client：记录收到的地图名，等下一轮 Tick 进行加载
5. NMT_Join
    - Client：地图加载完成后，发送 NMT_Join
    - Server：`GameMode::Login` 创建 PlayerController，设置好同步属性，`GameMode::PostLogin` 通过 PlayerController RPC 通知客户端创建 HUD，并换地图 `ClientTravel`(之前已经加载过一次地图了，这里还要再加载这个地图，是防止客户端在连接过程中换图？)

## Bunch

以上登录的消息全是基于 Bunch 的，包括后续的属性同步也是。因此有必要在这认识一下 Bunch。

Bunch 分为两种，OutBunch 和 InBunch ，分别对应发送和接收。

```cpp
class FOutBunch : public FNetBitWriter
{
public:
    FOutBunch *             Next;
    UChannel *              Channel;
    double                  Time;
    int32                   ChIndex;
    FName                   ChName;
    int32                   ChSequence;
    int32                   PacketId;
    uint8                   ReceivedAck:1;
    uint8                   bOpen:1;
    uint8                   bClose:1;
    uint8                   bReliable:1;
    uint8                   bPartial:1;             // Not a complete bunch
    uint8                   bPartialInitial:1;      // The first bunch of a partial bunch
    uint8                   bPartialFinal:1;        // The final bunch of a partial bunch
    uint8                   bHasPackageMapExports:1;    // This bunch has networkGUID name/id pairs
    uint8                   bHasMustBeMappedGUIDs:1;    // This bunch has guids that must be mapped before we can process this bunch

    EChannelCloseReason     CloseReason;

    TArray< FNetworkGUID >  ExportNetGUIDs;         // List of GUIDs that went out on this bunch
    TArray< uint64 >        NetFieldExports;
};
```

其实就是带一些所属 Channel 信息，是否为开启 Channel 或 关闭 Channel，Packet 信息(因为依赖于 Packet发送)需要处理丢包的情况，和分包信息，因为 UDP 超过一定大小会直接丢包，需要分包处理。至于 `ExportNetGUIDs` 和 `NetFieldExports` 可以先不管，这是属性同步时，同步 Actor 用的，现在这还处于登录状态，根本没有 Actor 需要同步。

```cpp
class FInBunch : public FNetBitReader
{
public:
    int32               PacketId;   // Note this must stay as first member variable in FInBunch for FInBunch(FInBunch, bool) to work
    FInBunch *          Next;
    UNetConnection *    Connection;
    int32               ChIndex;
    FName               ChName;
    int32               ChSequence;
    uint8               bOpen:1;
    uint8               bClose:1;
    uint8               bReliable:1;
    uint8               bPartial:1;                 // Not a complete bunch
    uint8               bPartialInitial:1;          // The first bunch of a partial bunch
    uint8               bPartialFinal:1;            // The final bunch of a partial bunch
    uint8               bHasPackageMapExports:1;    // This bunch has networkGUID name/id pairs
    uint8               bHasMustBeMappedGUIDs:1;    // This bunch has guids that must be mapped before we can process this bunch
    uint8               bIgnoreRPCs:1;

    EChannelCloseReason     CloseReason;
};
```

### Channel

初步了解了 `Bunch` 后，还需要了解 `Channel` 毕竟是通过 Channel 的接口发出 Bunch。

```cpp
class UChannel : public UObject
{
	GENERATED_BODY()
public:
	uint32              OpenAcked:1;        // If OpenedLocally is true, this means we have acknowledged the packet we sent the bOpen bunch on. Otherwise, it means we have received the bOpen bunch from the server.
	uint32              Closing:1;          // State of the channel.
	uint32              Dormant:1;          // Channel is going dormant (it will close but the client will not destroy
	uint32              OpenTemporary:1;    // Opened temporarily.
	uint32              Broken:1;           // Has encountered errors and is ignoring subsequent packets.
	uint32              bTornOff:1;         // Actor associated with this channel was torn off
	uint32              bPendingDormancy:1;	// Channel wants to go dormant (it will check during tick if it can go dormant)
	uint32              bIsInDormancyHysteresis:1; // Channel wants to go dormant, and is otherwise ready to become dormant, but is waiting for a timeout before doing so.
	uint32              bPausedUntilReliableACK:1; // Unreliable property replication is paused until all reliables are ack'd.
	uint32              SentClosingBunch:1;	// Set when sending closing bunch to avoid recursion in send-failure-close case.
	uint32              bPooled:1;          // Set when placed in the actor channel pool
	uint32              OpenedLocally:1;    // Whether channel was opened locally or by remote.
	uint32              bOpenedForCheckpoint:1;	// Whether channel was opened by replay checkpoint recording
	int32               ChIndex;            // Index of this channel.
	FPacketIdRange      OpenPacketId;       // If OpenedLocally is true, this is the packet we sent the bOpen bunch on. Otherwise, it's the packet we received the bOpen bunch on.
	FName               ChName;             // Name of the type of this channel.
	int32               NumInRec;           // Number of packets in InRec.
	int32               NumOutRec;          // Number of packets in OutRec.
	class FInBunch*     InRec;              // Incoming data with queued dependencies.
	class FOutBunch*    OutRec;             // Outgoing reliable unacked data.
	class FInBunch*     InPartialBunch;     // Partial bunch we are receiving (incoming partial bunches are appended to this)
};
```

现在以 NMT_Hello 为例子，学习如何发送 Bunch。

```cpp
Conn->Channels[0]->SendBunch(&Bunch, true);
```

## Channel::SendBunch

`NumOutRec` 表示发出的需要可靠传输且还未确认对方收到的 Bunch 数量，此处认为若有太多数据对端还未确认则先暂存消息，否则调用父类进行发送。

```cpp
FPacketIdRange UControlChannel::SendBunch(FOutBunch* Bunch, bool Merge)
{
    // if we already have queued messages, we need to queue subsequent ones to guarantee proper ordering
    if (QueuedMessages.Num() > 0 || NumOutRec >= RELIABLE_BUFFER - 1 + Bunch->bClose)
    {
        QueueMessage(Bunch);
        return FPacketIdRange(INDEX_NONE);
    }
    else
    {
        if (!Bunch->IsError())
        {
            return Super::SendBunch(Bunch, Merge);
        }
    }
}
```

检查对端是否需要打开一个新 Channel，Bunch 中的 `bOpen` 就是这个功能，通知对端创建一个 Channel， `OpenedLocally` 表示这个 Channel 是本地创建的。

```cpp
FPacketIdRange UChannel::SendBunch( FOutBunch* Bunch, bool Merge )
{
    if (OpenedLocally && ((OpenPacketId.First == INDEX_NONE) || ((Connection->ResendAllDataState != EResendAllDataState::None) && !bDormancyClose)))
    {
        bool bOpenBunch = true;

        if (Connection->ResendAllDataState == EResendAllDataState::SinceCheckpoint)
        {
            bOpenBunch = !bOpenedForCheckpoint;
            bOpenedForCheckpoint = true;
        }

        if (bOpenBunch)
        {
            Bunch->bOpen = 1;
            OpenTemporary = !Bunch->bReliable;
        }
    }
}
```

`AppendExportBunches` 使用 `UPackageMapClient` 将首次加入网络同步的 Actor 进行序列化，此处还处于登录环节，因此是空的，另外 `IsInternalAck` 为 true时 通常表示是回放的时候。

```cpp
TArray<FOutBunch*>& OutgoingBunches = Connection->GetOutgoingBunches();
OutgoingBunches.Reset();

// Add any export bunches
// Replay connections will manage export bunches separately.
if (!Connection->IsInternalAck())
{
    AppendExportBunches( OutgoingBunches );
}
```

当 Bunch 的基础属性相同，且发送缓冲区还未发送出去，且没超过最大 Bunch 大小，则考虑合包，当然若前面触发了 Actor 序列化，则不会进行合包。

```cpp
if
(	Merge
&&	Connection->LastOut.ChIndex == Bunch->ChIndex
&&	Connection->LastOut.bReliable == Bunch->bReliable	// Don't merge bunches of different reliability, since for example a reliable RPC can cause a bunch with properties to become reliable, introducing unnecessary latency for the properties.
&&	Connection->AllowMerge
&&	Connection->LastEnd.GetNumBits()
&&	Connection->LastEnd.GetNumBits()==Connection->SendBuffer.GetNumBits()
&&	Connection->LastOut.GetNumBits() + Bunch->GetNumBits() <= MAX_SINGLE_BUNCH_SIZE_BITS )
{
    // Merge.
    PreExistingBits = Connection->LastOut.GetNumBits();
    Connection->LastOut.SerializeBits( Bunch->GetData(), Bunch->GetNumBits() );
    Connection->LastOut.bOpen     |= Bunch->bOpen;
    Connection->LastOut.bClose    |= Bunch->bClose;

    OutBunch                       = Connection->LastOutBunch;
    Bunch                          = &Connection->LastOut;
    Connection->PopLastStart();
    Connection->Driver->OutBunches--;
}
```

若单个 Bunch 过大，又会进行拆包。

```cpp
if( Bunch->GetNumBits() > MAX_SINGLE_BUNCH_SIZE_BITS )
{
    uint8 *data = Bunch->GetData();
    int64 bitsLeft = Bunch->GetNumBits();
    Merge = false;

    while(bitsLeft > 0)
    {
        FOutBunch * PartialBunch = new FOutBunch(this, false);
        int64 bitsThisBunch = FMath::Min<int64>(bitsLeft, MAX_PARTIAL_BUNCH_SIZE_BITS);
        PartialBunch->SerializeBits(data, bitsThisBunch);

        OutgoingBunches.Add(PartialBunch);

        bitsLeft -= bitsThisBunch;
        data += (bitsThisBunch >> 3);
    }
}
else
{
    OutgoingBunches.Add(Bunch);
}
```

拆分包后，若拆分的包少于某个阈值，哪怕它原始 Bunch 不是可靠传输的，也会修改为可靠传输。

```cpp
int32 GCVarNetPartialBunchReliableThreshold = 8;
FAutoConsoleVariableRef CVarNetPartialBunchReliableThreshold(
	TEXT("net.PartialBunchReliableThreshold"),
	GCVarNetPartialBunchReliableThreshold,
	TEXT("If a bunch is broken up into this many partial bunches are more, we will send it reliable even if the original bunch was not reliable. Partial bunches are atonmic and must all make it over to be used"));

const bool bOverflowsReliable = (NumOutRec + OutgoingBunches.Num() >= RELIABLE_BUFFER + Bunch->bClose);

if ((GCVarNetPartialBunchReliableThreshold > 0) && (OutgoingBunches.Num() >= GCVarNetPartialBunchReliableThreshold) && !Connection->IsInternalAck())
{
    if (!bOverflowsReliable)
    {
        Bunch->bReliable = true;
        bPausedUntilReliableACK = true;
    }
}
```

若太多的可靠传输包，超出了阈值，就会断开连接，因为可靠传输是用的一条链表存放的还未确认的 Bunch 包，不能无限存放。

```cpp
if (Bunch->bReliable && bOverflowsReliable)
{
    PRAGMA_DISABLE_DEPRECATION_WARNINGS
    PrintReliableBunchBuffer();
    PRAGMA_ENABLE_DEPRECATION_WARNINGS

    // Bail out, we can't recover from this (without increasing RELIABLE_BUFFER)
    FString ErrorMsg = NSLOCTEXT("NetworkErrors", "ClientReliableBufferOverflow", "Outgoing reliable buffer overflow").ToString();

    Connection->SendCloseReason(ENetCloseResult::ReliableBufferOverflow);
    FNetControlMessage<NMT_Failure>::Send(Connection, ErrorMsg);
    Connection->FlushNet(true);
    Connection->Close(ENetCloseResult::ReliableBufferOverflow);

    return PacketIdRange;
}
```

还需要对拆分的 Bunch 做属性的调整。 `OutgoingBunches` 的数量通常只有一个，若大于 1 则要么是拆分包，要么是有导出的 Actor 同步包，它们都没有设置过 Bunch 的属性，需要在此处进行调整。

```cpp
for( int32 PartialNum = 0; PartialNum < OutgoingBunches.Num(); ++PartialNum)
{
    FOutBunch * NextBunch = OutgoingBunches[PartialNum];

    NextBunch->bReliable = Bunch->bReliable;
    NextBunch->bOpen = Bunch->bOpen;
    NextBunch->bClose = Bunch->bClose;
    NextBunch->CloseReason = Bunch->CloseReason;
    NextBunch->ChIndex = Bunch->ChIndex;
    NextBunch->ChName = Bunch->ChName;

    if ( !NextBunch->bHasPackageMapExports )
    {
        NextBunch->bHasMustBeMappedGUIDs |= Bunch->bHasMustBeMappedGUIDs;
    }

    if (OutgoingBunches.Num() > 1)
    {
        NextBunch->bPartial = 1;
        NextBunch->bPartialInitial = (PartialNum == 0 ? 1: 0);
        NextBunch->bPartialFinal = (PartialNum == OutgoingBunches.Num() - 1 ? 1: 0);
        NextBunch->bOpen &= (PartialNum == 0);                                          // Only the first bunch should have the bOpen bit set
        NextBunch->bClose = (Bunch->bClose && (OutgoingBunches.Num()-1 == PartialNum)); // Only last bunch should have bClose bit set
    }

    FOutBunch *ThisOutBunch = PrepBunch(NextBunch, OutBunch, Merge); // This handles queuing reliable bunches into the ack list

    // Update Packet Range
    int32 PacketId = SendRawBunch(ThisOutBunch, Merge, GetTraceCollector(*NextBunch));
    if (PartialNum == 0)
    {
        PacketIdRange = FPacketIdRange(PacketId);
    }
    else
    {
        PacketIdRange.Last = PacketId;
    }

    // Update channel sequence count.
    Connection->LastOut = *ThisOutBunch;
    Connection->LastEnd	= FBitWriterMark( Connection->SendBuffer );
}
```

`PrepBunch` 是处理可靠 Bunch 的函数，若该 Bunch 为 `bReliable` 则将其放入 `OutBunch` 链表存起来，若发生丢包，则会取出该 Bunch，重新分配一个 Packet 将其传输过去。

```cpp
FOutBunch* UChannel::PrepBunch(FOutBunch* Bunch, FOutBunch* OutBunch, bool Merge)
{
    if ( Connection->ResendAllDataState != EResendAllDataState::None )
    {
        return Bunch;
    }

    // Find outgoing bunch index.
    if( Bunch->bReliable )
    {
        // Find spot, which was guaranteed available by FOutBunch constructor.
        if( OutBunch==NULL )
        {
            Bunch->Next	= NULL;
            Bunch->ChSequence = ++Connection->OutReliable[ChIndex];
            NumOutRec++;
            Connection->GetDriver()->GetMetrics()->SetMaxInt(UE::Net::Metric::OutgoingReliableMessageQueueMaxSize, NumOutRec);
            OutBunch = new FOutBunch(*Bunch);
            FOutBunch** OutLink = &OutRec;
            while(*OutLink) // This was rewritten from a single-line for loop due to compiler complaining about empty body for loops (-Wempty-body)
            {
                OutLink=&(*OutLink)->Next;
            }
            *OutLink = OutBunch;
        }
        else
        {
            Bunch->Next = OutBunch->Next;
            *OutBunch = *Bunch;
        }
        Connection->LastOutBunch = OutBunch;
    }
    else
    {
        OutBunch = Bunch;
        Connection->LastOutBunch = NULL;//warning: Complex code, don't mess with this!
    }

    return OutBunch;
}
```

Bunch 丢失后的重传：

```cpp
void UChannel::ReceivedNak( int32 NakPacketId )
{
    for( FOutBunch* Out=OutRec; Out; Out=Out->Next )
    {
        // Retransmit reliable bunches in the lost packet.
        if( Out->PacketId==NakPacketId && !Out->ReceivedAck )
        {
                Connection->SendRawBunch( *Out, 0 );
        }
    }
}
```

当然若对端连打开 ControlChannel 的 Bunch 都没有收到，会在 ControlChannel::Tick 中进行重发， `OpenAcked` 指的是打开 Channel 的 Bunch 是否收到 Ack。

```cpp
void UControlChannel::Tick()
{
    Super::Tick();

    if( !OpenAcked )
    {
        int32 Count = 0;
        for (FOutBunch* Out = OutRec; Out; Out = Out->Next)
        {
            if (!Out->ReceivedAck)
            {
                Count++;
            }
        }

        if (Count > 8)
        {
            return;
        }

        // Resend any pending packets if we didn't get the appropriate acks.
        for( FOutBunch* Out=OutRec; Out; Out=Out->Next )
        {
            if( !Out->ReceivedAck )
            {
                const double Wait = Connection->Driver->GetElapsedTime() - Out->Time;
                if (Wait > 1.0)
                {
                    Connection->SendRawBunch( *Out, 0 );
                }
            }
        }
    }
}
```

## ReceivedBunch
Bunch 的接收的调用栈如下：
```
UNetConnection::ReceivedRawPacket
    UNetConnection::ReceivedPacket
        UNetConnection::DispatchPacket
```

将 Packet 解包，让 Channel 来处理 Bunch。
```C++
void UNetConnection::ReceivedPacket( FBitReader& Reader, bool bIsReinjectedPacket, bool bDispatchPacket )
{
    UChannel* Channel = Channels[Bunch.ChIndex];
    if (Channel == nullptr)
    {
        Channel = CreateChannelByName( Bunch.ChName, EChannelCreateFlags::None, Bunch.ChIndex );
    }

    if (Channel != nullptr)
    {
        // Warning: May destroy channel
        Channel->ReceivedRawBunch(Bunch, bLocalSkipAck);
    }
}
```

最后将 Bunch 交给 `void UControlChannel::ReceivedBunch( FInBunch& Bunch )`

分发到 Notify 中，客户端对应 PendingNetGame 服务端对应 World 

`Connection->Driver->Notify->NotifyControlMessage(Connection, MessageType, Bunch);`