---
title: UE5 网络剖析(二) 无状态连接
categories: UE
date: 2024-11-23 10:38:20
keywords: UE5, UDP, PacketHandler, Packet, Bunch, StatelessConnectHandlerComponent
tags: [UE5, 网络, Packet, Bunch]
---

本文主要剖析 UE5 中客户端是如何与DS建立连接，构建基础 Channel，以及无状态握手流程。

## 连接建立

### 服务端监听流程

`UGameInstance::EnableListenServer` 调用 `UWorld::Listen` 去创建 UNetDriver 对象。

UNetDriver 默认有两个子类， IpNetDriver 和 DemoNetDriver 后面一个用于回放。

根据要创建的 NetDriver 名, 查找并构造该 Driver, 并存入 World->Context.ActiveNetDrivers，这里面很多地方会用到，比如需要设置某个 Actor 冻结时，就需要通知各个 NetDriver。

```cpp
UNetDriver* CreateNetDriver_Local(UEngine* Engine, FWorldContext& Context, FName NetDriverDefinition, FName InNetDriverName)
{
    Definition = Engine->NetDriverDefinitions.FindByPredicate(FindNetDriverDefPred);
    UClass* NetDriverClass = StaticLoadClass(UNetDriver::StaticClass(), nullptr, *Definition->DriverClassName.ToString(), nullptr， LOAD_Quiet);
    ReturnVal = NewObject<UNetDriver>(GetTransientPackage(), NetDriverClass);
    // 数组 重载了 operator new
    new(Context.ActiveNetDrivers) FNamedNetDriver(ReturnVal, Definition);
}
```

<!-- more -->

随后将所有的 NetActor 加入到相同 NetDriverName 的几个集合里去，

```cpp
void UNetDriver::SetWorld(class UWorld* InWorld)
{
    GetNetworkObjectList().AddInitialObjects(InWorld, this);
}
```

开始监听端口 `NetDriver->InitListen( this, InURL, bReuseAddressAndPort, Error )`

此处使用的是 IpNetDriver::InitListen。

```cpp
bool UIpNetDriver::InitListen( FNetworkNotify* InNotify, FURL& LocalURL, bool bReuseAddressAndPort, FString& Error )
{
    if( !InitBase( false, InNotify, LocalURL, bReuseAddressAndPort, Error ) )
    {
        UE_LOG(LogNet, Warning, TEXT("Failed to init net driver ListenURL: %s: %s"), *LocalURL.ToString(), *Error);
        return false;
    }

    InitConnectionlessHandler();
}
```

NetDriver 的 InitBase 仅仅只是处理一下参数，创建 NetConnectionClass 对象（注意这里不是NetConnection实例），在此处是IpConnectionClass，以及若有 ReplicationDrvier 则将其构造出来，Replication Graph 插件就是基于此实现的。

```cpp
bool UIpNetDriver::InitBase( bool bInitAsClient, FNetworkNotify* InNotify, const FURL& URL, bool bReuseAddressAndPort, FString& Error )
{
    using namespace UE::Net::Private;

    if (!Super::InitBase(bInitAsClient, InNotify, URL, bReuseAddressAndPort, Error))
    {
        return false;
    }
    ISocketSubsystem* SocketSubsystem = GetSocketSubsystem();

    const int32 BindPort = bInitAsClient ? GetClientPort() : URL.Port;
    // Increase socket queue size, because we are polling rather than threading
    // and thus we rely on the OS socket to buffer a lot of data.
    const int32 DesiredRecvSize = bInitAsClient ? ClientDesiredSocketReceiveBufferBytes : ServerDesiredSocketReceiveBufferBytes;
    const int32 DesiredSendSize = bInitAsClient ? ClientDesiredSocketSendBufferBytes : ServerDesiredSocketSendBufferBytes;
    const EInitBindSocketsFlags InitBindFlags = bInitAsClient ? EInitBindSocketsFlags::Client : EInitBindSocketsFlags::Server;
    FCreateAndBindSocketFunc CreateAndBindSocketsFunc = [this, BindPort, bReuseAddressAndPort, DesiredRecvSize, DesiredSendSize]
                                    (TSharedRef<FInternetAddr> BindAddr, FString& Error) -> FUniqueSocket
        {
            return this->CreateAndBindSocket(BindAddr, BindPort, bReuseAddressAndPort, DesiredRecvSize, DesiredSendSize, Error);
        };

    bool bInitBindSocketsSuccess = Resolver->InitBindSockets(MoveTemp(CreateAndBindSocketsFunc), InitBindFlags, SocketSubsystem, Error);
}
```

绑定端口的时候会不断递增端口号，直到绑定成功，然后将 Socket 存储到 
`BoundSockets`，注意服务端只能存在一个 绑定的Socket。

重要的是 `InitConnectionlessHandler` ，创建 PacketHandler，这个 Handler 能添加一系列的 Handler，所有 Packet 都会先进这个 handler 过一遍筛子，里面默认添加了一个 `StatelessConnectHandlerComponent` 用于无状态网络连接。

```cpp
void UNetDriver::InitConnectionlessHandler()
{
    ConnectionlessHandler = MakeUnique<PacketHandler>(&DDoS);

    if (ConnectionlessHandler.IsValid())
    {
        ConnectionlessHandler->NotifyAnalyticsProvider(AnalyticsProvider, AnalyticsAggregator);
        ConnectionlessHandler->Initialize(UE::Handler::Mode::Server, MAX_PACKET_SIZE, true, nullptr, nullptr, NetDriverDefinition);

        // Add handling for the stateless connect handshake, for connectionless packets, as the outermost layer
        TSharedPtr<HandlerComponent> NewComponent =
            ConnectionlessHandler->AddHandler(TEXT("Engine.EngineHandlerComponentFactory(StatelessConnectHandlerComponent)"), true);

        StatelessConnectComponent = StaticCastSharedPtr<StatelessConnectHandlerComponent>(NewComponent);

        if (StatelessConnectComponent.IsValid())
        {
            StatelessConnectComponent.Pin()->SetDriver(this);
        }

        ConnectionlessHandler->InitializeComponents();
    }
}
```

`StatelessConnectComponent.Pin()->SetDriver(this);` 此处会触发 `UpdateSecret` 操作，更新两个 Secret，用于后续握手，当然这个值是会随着时间更新的，之所以需要两个，是因为更新很频繁，需要存一下旧值来比对，主要是为了避免重放攻击。

```cpp
void StatelessConnectHandlerComponent::UpdateSecret()
{
    LastSecretUpdateTimestamp = Driver != nullptr ? Driver->GetElapsedTime() : 0.0;

    // On first update, update both secrets
    if (ActiveSecret == 255)
    {
        // NOTE: The size of this may be excessive.
        HandshakeSecret[0].AddUninitialized(SECRET_BYTE_SIZE);
        HandshakeSecret[1].AddUninitialized(SECRET_BYTE_SIZE);

        TArray<uint8>& CurArray = HandshakeSecret[1];

        for (int32 i=0; i<SECRET_BYTE_SIZE; i++)
        {
            CurArray[i] = FMath::Rand() % 255;
        }

        ActiveSecret = 0;
    }
    else
    {
        ActiveSecret = (uint8)!ActiveSecret;
    }

    TArray<uint8>& CurArray = HandshakeSecret[ActiveSecret];

    for (int32 i=0; i<SECRET_BYTE_SIZE; i++)
    {
        CurArray[i] = FMath::Rand() % 255;
    }
}
```

到此为止，服务端的监听网络流程结束，简单来说就是根据平台创建 NetDriver，准备好 NetConnectionClass 但没有用它创建实例，因为此时还没有客户端连上来，创建 Socket，然后创建 PacketHandler 并为它添加 StatelessConnectHandlerComponent 用于无状态网络连接，避免重放攻击。

调用栈如下：

```cpp
UWorld::Listen()
    UIpNetDriver::InitListen()
        UIpNetDriver::InitBase() // 创建Socket 监听端口
            UNetDriver::InitBase() // 处理URL，创建NetConnectionClass、ReplicationDriver
    UNetDriver::InitConnectionlessHandler() // 创建PacketHandler、StatelessConnectHandlerComponent
```

### 客户端连接流程

`UEngine::Browse` 处理网络连接的基础内容，包括对 URL 的处理，最后会创建一个 `UPendingNetGame` 对象。

```cpp
EBrowseReturnVal::Type UEngine::Browse( FWorldContext& WorldContext, FURL URL, FString& Error )
{
    if( URL.IsInternal() && GIsClient )
    {
        // Clean up the netdriver/socket so that the pending level succeeds
        if (WorldContext.World() && ShouldShutdownWorldNetDriver())
        {
            ShutdownWorldNetDriver(WorldContext.World());
        }

        WorldContext.PendingNetGame = NewObject<UPendingNetGame>();
        WorldContext.PendingNetGame->Initialize(URL); //-V595
        WorldContext.PendingNetGame->InitNetDriver(); //-V595
    }
}
```

它也会和服务端一样创建一个 NetDriver，只不过它的名字叫 `PendingNetDriver` 而不是 `GameNetDriver`  ，接着初始化连接。

```cpp
void UPendingNetGame::InitNetDriver()
{
    if (!GDisallowNetworkTravel)
    {
        // Try to create network driver.
        if (GEngine->CreateNamedNetDriver(this, NAME_PendingNetDriver, NAME_GameNetDriver))
        {
            NetDriver = GEngine->FindNamedNetDriver(this, NAME_PendingNetDriver);
        }

        if( NetDriver->InitConnect( this, URL, ConnectionError ) )
        {
            FNetDelegates::OnPendingNetGameConnectionCreated.Broadcast(this);

            ULocalPlayer* LocalPlayer = GEngine->GetFirstGamePlayer(this);
            if (LocalPlayer)
            {
                LocalPlayer->PreBeginHandshake(ULocalPlayer::FOnPreBeginHandshakeCompleteDelegate::CreateWeakLambda(this,
                    [this]()
                    {
                        BeginHandshake();
                    }));
            }
            else
            {
                BeginHandshake();
            }
        }
    }
}
```

这一部分逻辑和服务端几乎一样，根据URL设置变量，创建 Socket，以及准备好 NetConnectionClass，但它是立刻根据 NetConnectionClass 来构造一个 `UIpConnection` 对象，而服务端是等到握手认证通过后才创建。 `CreateInitialClientChannels` 还会初始化 Channels 数据，包括可靠传输之类的内容，一条连接的 Channel 个数最多为 `DefaultMaxChannelSize(32767)` 。

`InitLocalConnection` 会一路调用到 `UNetConnection::InitBase` 中，构造 PacketHandler、StatelessConnectHandlerComponent 。

```cpp
bool UIpNetDriver::InitConnect( FNetworkNotify* InNotify, const FURL& ConnectURL, FString& Error )
{
    ISocketSubsystem* SocketSubsystem = GetSocketSubsystem();
    if( !InitBase( true, InNotify, ConnectURL, false, Error ) )
    {
        UE_LOG(LogNet, Warning, TEXT("Failed to init net driver ConnectURL: %s: %s"), *ConnectURL.ToString(), *Error);
        return false;
    }
    // Create new connection.
    ServerConnection = NewObject<UNetConnection>(GetTransientPackage(), NetConnectionClass);

    ServerConnection->InitLocalConnection(this, SocketPrivate.Get(), ConnectURL, USOCK_Pending);

    Resolver->InitConnect(ServerConnection, SocketSubsystem, GetSocket(), ConnectURL);

    CreateInitialClientChannels();

    return true;
}
```

这里还要注意一点，每条 Connection 都会创建一个 PackageMapClient，用于序列化 Actor，主要功能是把 GUID 和 指针绑定起来。

```cpp
void UNetConnection::InitBase(UNetDriver* InDriver,class FSocket* InSocket, const FURL& InURL, EConnectionState InState, int32 InMaxPacket, int32 InPacketOverhead)
{
    // Create package map.
    UPackageMapClient* PackageMapClient = NewObject<UPackageMapClient>(this, PackageMapClass);

    if (ensure(PackageMapClient != nullptr))
    {
        PackageMapClient->Initialize(this, Driver->GuidCache);
        PackageMap = PackageMapClient;
    }
}
```

创建客户端 Channels，需要注意 UE5 多了个 DataStream Channel，用于 Iris 新的网络功能。

```cpp
[/Script/Engine.NetDriver]
+ChannelDefinitions=(ChannelName=Control, ClassName=/Script/Engine.ControlChannel, StaticChannelIndex=0, bTickOnCreate=true, bServerOpen=false, bClientOpen=true, bInitialServer=false, bInitialClient=true)
+ChannelDefinitions=(ChannelName=Voice, ClassName=/Script/Engine.VoiceChannel, StaticChannelIndex=1, bTickOnCreate=true, bServerOpen=true, bClientOpen=true, bInitialServer=true, bInitialClient=true)
+ChannelDefinitions=(ChannelName=DataStream, ClassName=/Script/Engine.DataStreamChannel, StaticChannelIndex=2, bTickOnCreate=true, bServerOpen=true, bClientOpen=true, bInitialServer=true, bInitialClient=true)
+ChannelDefinitions=(ChannelName=Actor, ClassName=/Script/Engine.ActorChannel, StaticChannelIndex=-1, bTickOnCreate=false, bServerOpen=true, bClientOpen=false, bInitialServer=false, bInitialClient=false)
```

```cpp
void UNetDriver::CreateInitialClientChannels()
{
    if (ServerConnection != nullptr)
    {
        for (const FChannelDefinition& ChannelDef : ChannelDefinitions)
        {
            if (ChannelDef.bInitialClient && (ChannelDef.ChannelClass != nullptr))
            {
                ServerConnection->CreateChannelByName(ChannelDef.ChannelName, EChannelCreateFlags::OpenedLocally, ChannelDef.StaticChannelIndex);
            }
        }
    }
}
```

初始化完连接，此时就可以开始握手了，

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

调用栈如下：

![UE5_connection_traceback](/images/UE5_connection_traceback.png)

```cpp
UEngine::Browse()
    UPendingNetGame::InitNetDriver() // 创建 PendingNetDriver
        UIpNetDriver::InitConnect() // 创建 IpConnection
            UIpConnection::InitLocalConnection()
                UIpConnection::InitBase()
                    UNetConnection::InitBase() // 创建 PacketHandler、StatelessConnectHandlerComponent
        UNetDriver::CreateInitialClientChannels() // 创建 Control、Voice、DataStream Channels
    UPendingNetGame::BeginHandshake() // 握手
```

客户端总体流程也是先创建 NetDriver，这里叫 PendingNetDriver，和服务端不同的是会立即创建 IpConnection，毕竟客户端不需要省资源，创建 PacketHandler 和 StatelessConnectHandlerComponent 存于 Connection(而服务端存于 NetDriver) 用于和服务端无状态连接，同时创建必要的 Channels，目前是 Control、Voice、DataStream 三个Channel，最后开始握手。

## 握手

服务端、客户端建立好 Socket 之后，就要开始握手了，握手包有以下几类。

```cpp
enum class EHandshakePacketType : uint8
{
    InitialPacket       = 0,
    Challenge           = 1,
    Response            = 2,
    Ack                 = 3,
    RestartHandshake    = 4,
    RestartResponse     = 5,
    VersionUpgrade      = 6,

    Last = VersionUpgrade
};
```

`PacketHandler::BeginHandshaking` 最终会通知到其下的各个 Handler Component 去执行握手，在这里当然只有 `StatelessConnectHandlerComponent` 。

```cpp
void StatelessConnectHandlerComponent::NotifyHandshakeBegin()
{
    SendInitialPacket(static_cast<EHandshakeVersion>(CurrentHandshakeVersion));
}
```

### InitialPacket

```cpp
void StatelessConnectHandlerComponent::SendInitialPacket(EHandshakeVersion HandshakeVersion)
{
    if (Handler->Mode == UE::Handler::Mode::Client)
    {
        UNetConnection* ServerConn = (Driver != nullptr ? ToRawPtr(Driver->ServerConnection) : nullptr);

        if (ServerConn != nullptr)
        {
            const int32 AdjustedSize = GetAdjustedSizeBits(HANDSHAKE_PACKET_SIZE_BITS, HandshakeVersion);
            FBitWriter InitialPacket(AdjustedSize + (BaseRandomDataLengthBytes * 8) + 1 /* Termination bit */);

            BeginHandshakePacket(InitialPacket, EHandshakePacketType::InitialPacket, HandshakeVersion, SentHandshakePacketCount, CachedClientID,
                                    (bRestartedHandshake ? EHandshakePacketModifier::RestartHandshake : EHandshakePacketModifier::None));

            uint8 SecretIdPad = 0;
            uint8 PacketSizeFiller[28];

            InitialPacket.WriteBit(SecretIdPad);

            FMemory::Memzero(PacketSizeFiller, UE_ARRAY_COUNT(PacketSizeFiller));
            InitialPacket.Serialize(PacketSizeFiller, UE_ARRAY_COUNT(PacketSizeFiller));

            SendToServer(HandshakeVersion, EHandshakePacketType::InitialPacket, InitialPacket);
        }
    }
}
```

设置 `RawSend` 避免被 Handler 处理。

```cpp
void StatelessConnectHandlerComponent::SendToServer(EHandshakeVersion HandshakeVersion, EHandshakePacketType PacketType, FBitWriter& Packet)
{
    if (UNetConnection* ServerConn = (Driver != nullptr ? Driver->ServerConnection : nullptr))
    {
        CapHandshakePacket(Packet, HandshakeVersion);

        // Disable PacketHandler parsing, and send the raw packet
        Handler->SetRawSend(true);

        if (Driver->IsNetResourceValid())
        {
            FOutPacketTraits Traits;

            Driver->ServerConnection->LowLevelSend(Packet.GetData(), Packet.GetNumBits(), Traits);
        }

        Handler->SetRawSend(false);
    }
}
```

此处发送 `InitialPacket` 握手包时，用的也是 UDP，因此存在丢失的风险，解决办法是通过
`StatelessConnectHandlerComponent::Tick` 每帧都发一次握手包，后续握手流程都是通过这种方式进行。

```cpp
void StatelessConnectHandlerComponent::Tick(float DeltaTime)
{
    if (Handler->Mode == UE::Handler::Mode::Client)
    {
        if (State != UE::Handler::Component::State::Initialized && LastClientSendTimestamp != 0.0)
        {
            double LastSendTimeDiff = FPlatformTime::Seconds() - LastClientSendTimestamp;

            if (LastSendTimeDiff > UE::Net::HandshakeResendInterval)
            {
                const bool bRestartChallenge = Driver != nullptr && ((Driver->GetElapsedTime() - LastChallengeTimestamp) > MIN_COOKIE_LIFETIME);

                if (bRestartChallenge)
                {
                    SetState(UE::Handler::Component::State::UnInitialized);
                }

                if (State == UE::Handler::Component::State::UnInitialized)
                {
                    UE_LOG(LogHandshake, Verbose, TEXT("Initial handshake packet timeout - resending."));

                    EHandshakeVersion ResendVersion = static_cast<EHandshakeVersion>(CurrentHandshakeVersion);

                    // In case the server doesn't support the current handshake version, randomly switch between supported versions - if enabled
                    // (we don't know if the server supports the minimum version either, so pick from the full range).
                    // It's better for devs to explicitly hotfix the 'net.MinHandshakeVersion' value, instead of relying upon this fallback.
                    if (!!CVarNetDoHandshakeVersionFallback.GetValueOnAnyThread() && FMath::RandBool())
                    {
                        // Decrement the minimum version, based on the number of handshake packets sent - to select for higher supported versions
                        const int32 MinVersion = FMath::Max(MinSupportedHandshakeVersion, CurrentHandshakeVersion - SentHandshakePacketCount);

                        if (MinVersion != CurrentHandshakeVersion)
                        {
                            ResendVersion = static_cast<EHandshakeVersion>(FMath::RandRange(MinVersion, CurrentHandshakeVersion));
                        }
                    }

                    SendInitialPacket(ResendVersion);
                }
                else if (State == UE::Handler::Component::State::InitializedOnLocal && LastTimestamp != 0.0)
                {
                    UE_LOG(LogHandshake, Verbose, TEXT("Challenge response packet timeout - resending."));

                    SendChallengeResponse(LastRemoteHandshakeVersion, LastSecretId, LastTimestamp, LastCookie);
                }
            }
        }
    }
    else // if (Handler->Mode == Handler::Mode::Server)
    {
        const bool bConnectionlessHandler = Driver != nullptr && Driver->StatelessConnectComponent.HasSameObject(this);

        if (bConnectionlessHandler)
        {
            static float CurVariance = FMath::FRandRange(0.f, SECRET_UPDATE_TIME_VARIANCE);

            // Update the secret value periodically, to reduce replay attacks. Also adds a bit of randomness to the timing of this,
            // so that handshake Timestamp checking as an added method of reducing replay attacks, is more effective.
            if (((Driver->GetElapsedTime() - LastSecretUpdateTimestamp) - (SECRET_UPDATE_TIME + CurVariance)) > 0.0)
            {
                CurVariance = FMath::FRandRange(0.f, SECRET_UPDATE_TIME_VARIANCE);

                UpdateSecret();
            }
        }
    }
}
```

轮到服务端接受握手包，服务端接受 `Packet` 都在 `UIpNetDriver::TickDispatch` 中。

```cpp
void UIpNetDriver::TickDispatch(float DeltaTime)
{
    UNetConnection* Connection = nullptr;
    for (FPacketIterator It(this); It; ++It)
    {
            if (Connection == nullptr)
            {
                auto* Result = MappedClientConnections.Find(FromAddr);
            
                if (Result != nullptr)
                {
                    UNetConnection* ConnVal = *Result;
            
                    if (ConnVal != nullptr)
                    {
                        Connection = ConnVal;
                    }
                    else
                    {
                        ReceivedTraits.bFromRecentlyDisconnected = true;
                    }
                }
        }
        // 握手阶段专用
        Connection = ProcessConnectionlessPacket(ReceivedPacket, WorkingBuffer);
        // Send the packet to the connection for processing.
        if (Connection != nullptr && !bIgnorePacket)
        {
            Connection->ReceivedRawPacket((uint8*)ReceivedPacket.DataView.GetData(), ReceivedPacket.DataView.NumBytes());
        }
    }
}
```

`ProcessConnectionlessPacket` 是用于处理还未有连接的 Packet 包，因为只有完全握手通过之后才会为客户端创建连接。 `FPacketIterator` 也只是一个简单的迭代器，用于从 Socket 读取内容。

服务端所有收到的握手包都会到 `StatelessConnectHandlerComponent::IncomingConnectionless` 

### Challenge

服务端收到 `InitialPacket` 后 就会发送 `Challenge` ，此时才会使用服务端的 `HandshakeSecret` 用当前的时间戳和客户端地址生成一个 Cookie，发送给客户端。

```cpp
void StatelessConnectHandlerComponent::SendConnectChallenge(FCommonSendToClientParams CommonParams, uint8 ClientSentHandshakePacketCount)
{
    if (Driver != nullptr)
    {
        const int32 AdjustedSize = GetAdjustedSizeBits(HANDSHAKE_PACKET_SIZE_BITS, CommonParams.HandshakeVersion);
        FBitWriter ChallengePacket(AdjustedSize + (BaseRandomDataLengthBytes * 8) + 1 /* Termination bit */);

        BeginHandshakePacket(ChallengePacket, EHandshakePacketType::Challenge, CommonParams.HandshakeVersion, ClientSentHandshakePacketCount,
                                CommonParams.ClientID);

        double Timestamp = Driver->GetElapsedTime();
        uint8 Cookie[COOKIE_BYTE_SIZE];

        GenerateCookie(CommonParams.ClientAddress, ActiveSecret, Timestamp, Cookie);

        ChallengePacket.WriteBit(ActiveSecret);

        ChallengePacket << Timestamp;

        ChallengePacket.Serialize(Cookie, UE_ARRAY_COUNT(Cookie));

        SendToClient(CommonParams, EHandshakePacketType::Challenge, ChallengePacket);
    }
}
```

客户端的读取流程也类似，不过要记住 客户端此时是有连接的，所以会直接进入

```cpp
void UIpNetDriver::TickDispatch(float DeltaTime)
{
    Connection->ReceivedRawPacket((uint8*)ReceivedPacket.DataView.GetData(), ReceivedPacket.DataView.NumBytes());
}
```

```cpp
void UNetConnection::ReceivedRawPacket( void* InData, int32 Count )
{
    if (Handler.IsValid())
    {
        FReceivedPacketView PacketView;

        PacketView.DataView = {Data, Count, ECountUnits::Bytes};

        EIncomingResult IncomingResult = Handler->Incoming(PacketView);
    }
}
```

在握手阶段 `bConnectionlessPacket` 为 true 为服务端流程，为 false 为客户端流程。而握手结束后，双方都会走 `Incoming` 流程。

```cpp
EIncomingResult PacketHandler::Incoming_Internal(FReceivedPacketView& PacketView)
{
    if (PacketView.Traits.bConnectionlessPacket)
    {
        CurComponent.IncomingConnectionless(PacketRef);
    }
    else
    {
        CurComponent.Incoming(PacketRef);
    }
}
```

Challenge 的 Ack 也是 Challenge 类型的握手包，因此区分方式是通过判断 timestamp 是否小于等于 0 判断是否为 Ack。

### ChallengeResponse

ChallengeResponse 也只是将服务端发过来的数据重新发回去，让服务端校验。Secret 过期时间为 40秒。

服务端收到 ChallengeResponse 后 若验证 Cookie 通过则保存该 Cookie，用于后续断线重连的校验，同时从 Cookie 中算出 发送和接收序列号，序列号是第一篇讲的用于 Packet 可靠传输的ID，随机化是为了避免攻击。

```cpp
void StatelessConnectHandlerComponent::IncomingConnectionless(FIncomingPacketRef PacketRef)
{
    // Challenge response
    else if (Driver != nullptr)
    {
        // NOTE: Allow CookieDelta to be 0.0, as it is possible for a server to send a challenge and receive a response,
        //			during the same tick
        bool bChallengeSuccess = false;
        const double CookieDelta = Driver->GetElapsedTime() - HandshakeData.Timestamp;
        const double SecretDelta = HandshakeData.Timestamp - LastSecretUpdateTimestamp;
        const bool bValidCookieLifetime = CookieDelta >= 0.0 && (MAX_COOKIE_LIFETIME - CookieDelta) > 0.0;
        const bool bValidSecretIdTimestamp = (HandshakeData.SecretId == ActiveSecret) ? (SecretDelta >= 0.0) : (SecretDelta <= 0.0);

        if (bValidCookieLifetime && bValidSecretIdTimestamp)
        {
            // Regenerate the cookie from the packet info, and see if the received cookie matches the regenerated one
            uint8 RegenCookie[COOKIE_BYTE_SIZE];

            GenerateCookie(Address, HandshakeData.SecretId, HandshakeData.Timestamp, RegenCookie);

            bChallengeSuccess = FMemory::Memcmp(HandshakeData.Cookie, RegenCookie, COOKIE_BYTE_SIZE) == 0;

            if (bChallengeSuccess)
            {
                if (HandshakeData.bRestartHandshake)
                {
                    FMemory::Memcpy(AuthorisedCookie, HandshakeData.OrigCookie, UE_ARRAY_COUNT(AuthorisedCookie));
                }
                else
                {
                    int16* CurSequence = (int16*)HandshakeData.Cookie;

                    LastServerSequence = *CurSequence & (MAX_PACKETID - 1);
                    LastClientSequence = *(CurSequence + 1) & (MAX_PACKETID - 1);

                    FMemory::Memcpy(AuthorisedCookie, HandshakeData.Cookie, UE_ARRAY_COUNT(AuthorisedCookie));
                }

                bRestartedHandshake = HandshakeData.bRestartHandshake;
                LastChallengeSuccessAddress = Address->Clone();
                LastRemoteHandshakeVersion = TargetVersion;
                CachedClientID = ClientID;

                if (TargetVersion < MinClientHandshakeVersion && static_cast<uint8>(TargetVersion) >= MinSupportedHandshakeVersion)
                {
                    MinClientHandshakeVersion = TargetVersion;
                }

                // Now ack the challenge response - the cookie is stored in AuthorisedCookie, to enable retries
                SendChallengeAck(FCommonSendToClientParams(Address, TargetVersion, ClientID),
                                    HandshakeData.RemoteSentHandshakePacketCount, AuthorisedCookie);
            }
        }
    }
}
```

服务端此时已经通过了握手，为客户端创建连接。

### ChallengeAck

客户端收到 ChallengeAck后，也是设置好发送和接收的序列号，用于后续 Packet 可靠传输。

```cpp
void StatelessConnectHandlerComponent::Incoming(FBitReader& Packet)
{
    // Receiving challenge ack, verify the timestamp is < 0.0f
    else if (HandshakeData.HandshakePacketType == EHandshakePacketType::Ack && HandshakeData.Timestamp < 0.0)
    {
        if (!bRestartedHandshake)
        {
            UNetConnection* ServerConn = (Driver != nullptr ? ToRawPtr(Driver->ServerConnection) : nullptr);

            // Extract the initial packet sequence from the random Cookie data
            if (ensure(ServerConn != nullptr))
            {
                int16* CurSequence = (int16*)HandshakeData.Cookie;

                int32 ServerSequence = *CurSequence & (MAX_PACKETID - 1);
                int32 ClientSequence = *(CurSequence + 1) & (MAX_PACKETID - 1);

                ServerConn->InitSequence(ServerSequence, ClientSequence);
            }

            // Save the final authorized cookie
            FMemory::Memcpy(AuthorisedCookie, HandshakeData.Cookie, UE_ARRAY_COUNT(AuthorisedCookie));
        }

        // Now finish initializing the handler - flushing the queued packet buffer in the process.
        SetState(UE::Handler::Component::State::Initialized);
        Initialized();

        bRestartedHandshake = false;

        // Reset packet count clientside, due to how it affects protocol version fallback selection
        SentHandshakePacketCount = 0;
    }
}
```

## 总结

服务端和客户端都会在启动之后创建 NetDriver，只不过服务端不会创建 NetConnection 因为担心被重放攻击，而客户端无所谓，创建了 NetConnection，之后彼此通过 PacketHandler 中的 `StatelessConnectHandlerComponent` 进行握手，握手方式主要是通过生成 Cookie，同时由于是 UDP 传输，可能丢包，彼此会通过 tick 不断重发握手包，当彼此握手通过之后，双端都会将 Cookie 保存下来，同时服务端为该客户端创建连接，同时对齐两端的 Packet 发送接收序列号，用于未来的可靠传输。

## 断线重连

当客户端出现切换网络时，可能会带着新的地址连接至服务端，服务端发现无法根据该地址找到连接，因此会下发重新握手的请求。

```cpp
void StatelessConnectHandlerComponent::IncomingConnectionless(FIncomingPacketRef PacketRef)
{
    else if (bHasValidSessionID)
    {
        // Late packets from recently disconnected clients may incorrectly trigger this code path, so detect and exclude those packets
        if (!Packet.IsError() && !PacketRef.Traits.bFromRecentlyDisconnected)
        {
            // The packet was fine but not a handshake packet - an existing client might suddenly be communicating on a different address.
            // If we get them to resend their cookie, we can update the connection's info with their new address.
            SendRestartHandshakeRequest(FCommonSendToClientParams(Address, static_cast<EHandshakeVersion>(MinSupportedHandshakeVersion), ClientID));
        }
    }
}
```