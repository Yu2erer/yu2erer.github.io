---
title: UE5 网络剖析(一) 可靠UDP
categories: UE
date: 2024-11-02 13:30:20
keywords: UE5, UDP, Packet, Bunch
tags: [UE5, 网络, UDP, Packet, Bunch]
---

本文主要剖析 UE5 中的可靠UDP的设计思路。

## 简介

UE5的网络收发使用UDP进行通信，而UDP又是不可靠的协议，只管发出，不管对端是否收到，也不保序，因此需要有一套机制来使得UE5的数据包有保序、可靠这两大特点。

## Packet

UE5在UDP之上，包装了一层 Packet，其内部传输的数据是一个个 Bunch，可靠不可靠指的是 Bunch的属性，Bunch 是什么这个暂时可以先不用关心，但 Packet 是需要搞明白的，因为 UE5 是使用 Packet 来完成保序的工作。

### 序列号

既然要实现保序、可靠，就需要知道对端收没收到包，那么自然是要通知对端我发的消息ID，以及我收到的消息ID，UE5也不例外，Packet 头部包含了 Seq 和 AckedSeq（取得最新收到的Packet的序列号），为了避免序列号回环无法直接比较序列号大小的情况，以及序列号占用比特位过大的问题，Seq 使用`TSequenceNumber` 实现，容量为14bit，可表示 `[0, 16383]`，两个 Seq 的差值若小于最大值的一半，则认为比较是正确的，没有发生回环。

```cpp
template <SIZE_T NumBits, typename SequenceType>
class TSequenceNumber
{
    static_assert(TIsSigned<SequenceType>::Value == false, "The base type for sequence numbers must be unsigned");

public:
    using SequenceT = SequenceType;
    using DifferenceT = int32;

    // Constants
    enum { SeqNumberBits = NumBits };
    enum { SeqNumberCount = SequenceT(1) << NumBits };
    enum { SeqNumberHalf = SequenceT(1) << (NumBits - 1) };
    enum { SeqNumberMax = SeqNumberCount - 1u };
    enum { SeqNumberMask = SeqNumberMax };
};
```

<!-- more -->

### 历史序列号

为了增加吞吐量，不能每次都发一个收一个，会需要一次多发几个包的情况，但是发的包多了，光靠最新收到的包的序列号，无法知道在此之前丢了哪些包，因此需要加入一个历史窗口，来存储在这段期间内，哪些包收到了，哪些包未收到。UE5 中使用 `TSequenceHistory` 来实现，窗口最大为 256，每个比特分别表示每个序列号的状态 。该窗口区间为 `[InAckSeqAck, InAckSeq]`， `InAckSeqAck` 为最新收到的序列号且对端也明确知道收到的序列号，`InAckSeq` 为最新收到的序列号且明确知道对端不知道它已收到。这个窗口最大虽然是 256个序列号，但 InAckSeq - InAckSeqAck 可能用不了 256 这么大的窗口，因此在 UE5 中该窗口被实现为可变长的数组，既然是可变长数组，那也就需要在 Packer 头部增加该窗口的大小的信息，`HistoryWordCount` 就起到这一个作用。

需要注意的是当接受者突然丢失大量包时，这个历史记录可能会溢出，溢出后，需要重置 `InAckSeqAck` ，这段逻辑会放到下面讲，这里先跳过。

理解了以上内容，就可以开始关心 Packer Header 的组织形式。

```cpp
class FNetPacketNotify
{
public:
    enum { SequenceNumberBits = 14 };
    enum { MaxSequenceHistoryLength = 256 };

    typedef TSequenceNumber<SequenceNumberBits, uint16> SequenceNumberT;
    typedef TSequenceHistory<MaxSequenceHistoryLength> SequenceHistoryT;

    struct FNotificationHeader
    {
        SequenceHistoryT History;
        SIZE_T HistoryWordCount;
        SequenceNumberT Seq;
        SequenceNumberT AckedSeq;
    };
};
static uint32 Pack(SequenceNumberT Seq, SequenceNumberT AckedSeq, SIZE_T HistoryWordCount)
{
    uint32 Packed = 0u;

    Packed |= Seq.Get() << SeqShift;
    Packed |= AckedSeq.Get() << AckSeqShift;
    Packed |= HistoryWordCount & HistoryWordCountMask;

    return Packed;
}
```

根据以上代码可知 

Packet Header

```cpp
Seq:14 | AckSeq:14 | HistoryCount:4
InSeqHistory: word为单位, 为HistoryCount个word
```

Packet除了 Packet Header之外，还可能存在 PacketInfoPayload，这里面主要是存储了服务器的帧时长和两次发包的时间间隔，前者用于更精确的统计延迟，此处可以忽略，和主题没什么关系。

PacketInfo

```cpp
bHasPacketInfoPayload: 1
if (bHasPacketInfoPayload) PakcetJitterClockTimeMS: uint32
bHasServerFrameTime: 1
if (bHasServerFrameTime) FrameTimeByte: uint8
```

在这之后则是一个个 Bunch，也可以没有 Bunch。

最后是 1bit的结束位。

总的 Packet 结构大致如下：

```cpp
Seq:14 | AckSeq:14 | HistoryCount:4
InSeqHistory: word为单位, 为HistoryCount个word
bHasPacketInfoPayload: 1
if (bHasPacketInfoPayload) PakcetJitterClockTimeMS: uint32
bHasServerFrameTime: 1
if (bHasServerFrameTime) FrameTimeByte: uint8
Bunch[?]
TerminateBit: 1
```

![](/images/UE5_packet.png)

## 保序

有了 Packet，就可以实现保序的功能，正如上面所述，每个 Packet 都有个序列号，当收到的序列号等于上次收到的序列号+1，则认为是有序，可以直接处理，但也有可能收到较新的包，UE5的做法是选择缓存一下，看看能不能收到前面的包，组成一个有序的情况。

最大容忍的丢包默认是3个，可以通过以下参数进行调整。

```cpp
static TAutoConsoleVariable<int32> CVarNetPacketOrderMaxMissingPackets(TEXT("net.PacketOrderMaxMissingPackets"), 3,
	TEXT("The maximum number of missed packet sequences that is allowed, before treating missing packets as lost."));
```

若收到的包是预期的包的序列号+3，则默认认为前面的包丢失，并处理当前的包。以下代码中的 `PacketSequenceDelta` 就是两个序列号的差值。

`PacketOrderCache` 就是缓存区，以循环队列形式构建，其默认值为32，同样的，可以通过以下参数进行调整。

```cpp
static TAutoConsoleVariable<int32> CVarNetPacketOrderMaxCachedPackets(TEXT("net.PacketOrderMaxCachedPackets"), 32,
	TEXT("(NOTE: Must be power of 2!) The maximum number of packets to cache while waiting for missing packet sequences, before treating missing packets as lost."))
```

```cpp
void UNetConnection::ReceivedPacket( FBitReader& Reader, bool bIsReinjectedPacket, bool bDispatchPacket )
{
    const int32 PacketSequenceDelta = PacketNotify.GetSequenceDelta(Header);

    if (PacketSequenceDelta > 0)
    {
        const bool bPacketOrderCacheActive = !bFlushingPacketOrderCache && PacketOrderCache.IsSet();
        const bool bCheckForMissingSequence = bPacketOrderCacheActive && PacketOrderCacheCount == 0;
        const bool bFillingPacketOrderCache = bPacketOrderCacheActive && PacketOrderCacheCount > 0;
        const int32 MaxMissingPackets = (bCheckForMissingSequence ? CVarNetPacketOrderMaxMissingPackets.GetValueOnAnyThread() : 0);

        const int32 MissingPacketCount = PacketSequenceDelta - 1;

        // Cache the packet if we are already caching, and begin caching if we just encountered a missing sequence, within range
        if (bFillingPacketOrderCache || (bCheckForMissingSequence && MissingPacketCount > 0 && MissingPacketCount <= MaxMissingPackets))
        {
            int32 LinearCacheIdx = PacketSequenceDelta - 1;
            int32 CacheCapacity = PacketOrderCache->Capacity();
            bool bLastCacheEntry = LinearCacheIdx >= (CacheCapacity - 1);

            // The last cache entry is only set, when we've reached capacity or when we receive a sequence which is out of bounds of the cache
            LinearCacheIdx = bLastCacheEntry ? (CacheCapacity - 1) : LinearCacheIdx;

            int32 CircularCacheIdx = PacketOrderCacheStartIdx;

            for (int32 LinearDec=LinearCacheIdx; LinearDec > 0; LinearDec--)
            {
                CircularCacheIdx = PacketOrderCache->GetNextIndex(CircularCacheIdx);
            }

            TUniquePtr<FBitReader>& CurCachePacket = PacketOrderCache.GetValue()[CircularCacheIdx];

            // Reset the reader to its initial position, and cache the packet
            if (!CurCachePacket.IsValid())
            {
                CurCachePacket = MakeUnique<FBitReader>(Reader);
                PacketOrderCacheCount++;
                ResetReaderMark.Pop(*CurCachePacket);
            }
            return;
        }
    }
}
```

需要特别注意的是，缓存区并不是无限等待的，在 `Driver.TickDispatch` 之后会调用 `void UNetConnection::FlushPacketOrderCache(bool bFlushWholeCache*/*=false*/*)` 强制将 PacketOrderCache 清空，并应用这些数据包。

`GetSequenceDelta` 的前提是需要(对方的序列号 > 最新收到的序列号)且(对方确认收到的序列号≥ 最新发出且确认收到的序列号)且(最新序列号(还未使用过的序列号) > 对方确认收到的序列号)，才认为这个 Packet是有效的。

```cpp
SequenceNumberT::DifferenceT GetSequenceDelta(const FNotificationHeader& NotificationData)
{
    if (NotificationData.Seq > InSeq && NotificationData.AckedSeq >= OutAckSeq && OutSeq > NotificationData.AckedSeq)
    {
        return SequenceNumberT::Diff(NotificationData.Seq, InSeq);
    }
    else
    {
        return 0;
    }
}
```

假设我们收到了正确的包，则需要根据序列号处理 ack、nak。

```cpp
void UNetConnection::ReceivedPacket( FBitReader& Reader, bool bIsReinjectedPacket, bool bDispatchPacket )
    {
    // Process acks
    // Lambda to dispatch delivery notifications, 
    auto HandlePacketNotification = [&Header, &ChannelsToClose, this](FNetPacketNotify::SequenceNumberT AckedSequence, bool bDelivered)
    {
        // Sanity check
        if (FNetPacketNotify::SequenceNumberT(LastNotifiedPacketId) != AckedSequence)
        {
            Close(ENetCloseResult::AckSequenceMismatch);
            return;
        }

        if (bDelivered)
        {
            ReceivedAck(LastNotifiedPacketId, ChannelsToClose);
        }
        else
        {
            ReceivedNak(LastNotifiedPacketId);
        };
    };

    // Update incoming sequence data and deliver packet notifications
    // Packet is only accepted if both the incoming sequence number and incoming ack data are valid		
    const int32 UpdatedPacketSequenceDelta = PacketNotify.Update(Header, HandlePacketNotification);
    }
```

重点在 PacketNotify.Update 中。

```cpp
template<class Functor>
FNetPacketNotify::SequenceNumberT::DifferenceT FNetPacketNotify::Update(const FNotificationHeader& NotificationData, Functor&& InFunc)
{
    const SequenceNumberT::DifferenceT InSeqDelta = GetSequenceDelta(NotificationData);

    if (InSeqDelta > 0)
    {	
        ProcessReceivedAcks(NotificationData, InFunc);

        return InternalUpdate(NotificationData, InSeqDelta);
    }
}
```

根据对方的历史序列号窗口，决定哪些序列号是对方收到的，哪些是未收到的。

```cpp
template<class Functor>
void FNetPacketNotify::ProcessReceivedAcks(const FNotificationHeader& NotificationData, Functor&& InFunc)
{
    if (NotificationData.AckedSeq > OutAckSeq)
    {
        SequenceNumberT::DifferenceT AckCount = SequenceNumberT::Diff(NotificationData.AckedSeq, OutAckSeq);

        // Update InAckSeqAck used to track the needed number of bits to transmit our ack history
        // Note: As we might reset sequence history we need to check if we already have advanced the InAckSeqAck
        const SequenceNumberT NewInAckSeqAck = UpdateInAckSeqAck(AckCount, NotificationData.AckedSeq);
        if (NewInAckSeqAck > InAckSeqAck)
        {
            InAckSeqAck = NewInAckSeqAck;
        }
        
        // ExpectedAck = OutAckSeq + 1
        SequenceNumberT CurrentAck(OutAckSeq);
        ++CurrentAck;

        // Make sure that we only look at the sequence history bit included in the notification data as the sequence history might have been reset, 
        // in which case we might not receive the max size history even though the ack-count is bigger than the history
        const SequenceNumberT::DifferenceT HistoryBits = NotificationData.HistoryWordCount * SequenceHistoryT::BitsPerWord;

        // Everything not found in the history buffer is treated as lost
        while (AckCount > HistoryBits)
        {
            --AckCount;
            InFunc(CurrentAck, false);
            ++CurrentAck;
        }

        // For sequence numbers contained in the history we lookup the delivery status from the history
        while (AckCount > 0)
        {
            --AckCount;
            InFunc(CurrentAck, NotificationData.History.IsDelivered(AckCount));
            ++CurrentAck;
        }
        OutAckSeq = NotificationData.AckedSeq;
        
        // Are we done waiting for an reset of the ack history?
        if (OutAckSeq > WaitingForFlushSeqAck)
        {
            WaitingForFlushSeqAck = OutAckSeq;
        }
    }
}
```

具体 `ReceivedAck` 和 `ReceivedNak` 的内容留到下一篇属性同步时讲解，读者暂时只需要知道，若为未收到该 Packet 且传输的 Bunch 是可靠的，是 reliable 的，则会重新找出该 Bunch 进行重发，通过这种方式实现了可靠传输。若为属性同步，属性同步本身就是非可靠的，丢了就丢了，但会在属性位上记录该属性没能成功同步，等待下次属性同步时一起带出最新的数据。

`InternalUpdate` 则是用于处理历史序列号窗口溢出的问题，接收端突然丢失大量的包时，`[InAckSeqAck, InAckSeq]` 区间就有概率超过256，出现ack窗口放不下的情况，进入 `WaitForSequenceHistoryFlush` 状态，若在这个包之前没有未确认的包，则可以直接重置 `InAckSeqAck` 为当前收到的包序列号 -1; 若有未确认的包，则直接通知对方整个序列号历史全丢失。

```cpp
FNetPacketNotify::SequenceNumberT::DifferenceT FNetPacketNotify::InternalUpdate(const FNotificationHeader& NotificationData, SequenceNumberT::DifferenceT InSeqDelta)
{
    // We must check if we will overflow our outgoing ack-window, if we do and it contains processed data we must initiate a re-sync of ack-sequence history.
    // This is done by ignoring any new packets until we are in sync again. 
    // This would typically only occur in situations where we would have had huge packet loss or spikes on the receiving end.
    if (!IsWaitingForSequenceHistoryFlush() && !WillSequenceFitInSequenceHistory(NotificationData.Seq))
    {
        if (GetHasUnacknowledgedAcks())
        {
            SetWaitForSequenceHistoryFlush();
        }
        else
        {
            // We can reset if we have no previous acks and can then safely synthesize nacks on the receiving end
            const SequenceNumberT NewInAckSeqAck(NotificationData.Seq.Get() - 1);
            UE_LOG_PACKET_NOTIFY_WARNING(TEXT("FNetPacketNotify::Reset SequenceHistory - New InSeqDelta: %u Old: %u"), NewInAckSeqAck.Get(), InAckSeqAck.Get());
            InAckSeqAck = NewInAckSeqAck;
        }
    }

    if (!IsWaitingForSequenceHistoryFlush())
    {
        // Just accept the incoming sequence, under normal circumstances NetConnection explicitly handles the acks.
        InSeq = NotificationData.Seq;

        return InSeqDelta;
    }
    else
    {
        // Until we have flushed the history we treat incoming packets as lost while still advancing ack window as far as we can.
        SequenceNumberT NewInSeqToAck(NotificationData.Seq);

        // Still waiting on flush, but we can fill up the history
        if (!WillSequenceFitInSequenceHistory(NotificationData.Seq) && GetHasUnacknowledgedAcks())
        {
            // Mark everything we can as lost up until the end of the sequence history 
            NewInSeqToAck = SequenceNumberT(InAckSeqAck.Get() + (MaxSequenceHistoryLength - GetCurrentSequenceHistoryLength()));
        }

        if (NewInSeqToAck >= InSeq)
        {
            const SequenceNumberT::DifferenceT AdjustedSequenceDelta = SequenceNumberT::Diff(NewInSeqToAck, InSeq);

            InSeq = NewInSeqToAck;

            // Nack driven from here
            AckSeq(NewInSeqToAck, false);

            UE_LOG_PACKET_NOTIFY(TEXT("FNetPacketNotify::Update - Waiting for sequence history flush - Rejected: %u Accepted: InSeq: %u Adjusted delta %d"), NotificationData.Seq.Get(), InSeq.Get(), AdjustedSequenceDelta);
            
            return AdjustedSequenceDelta;
        }
        else
        {
            UE_LOG_PACKET_NOTIFY(TEXT("FNetPacketNotify::Update - Waiting for sequence history flush - Rejected: %u Accepted: InSeq: %u"), NotificationData.Seq.Get(), InSeq.Get());
            return 0;
        }
    }
};
```

`WaitForSequenceHistoryFlush` 状态直到以下条件才会解除。 `OutAckSeq` 表示最新发出且被对端确认收到了的序列号。

```cpp
template<class Functor>
void FNetPacketNotify::ProcessReceivedAcks(const FNotificationHeader& NotificationData, Functor&& InFunc)
{
    // Are we done waiting for an reset of the ack history?
    if (OutAckSeq > WaitingForFlushSeqAck)
    {
        WaitingForFlushSeqAck = OutAckSeq;
    }
}
```

## 本文逻辑堆栈

- Packet 发送

```cpp
UNetConnection::SendRawBunch()
    UNetConnection::PrepareWriteBitsToSendBuffer()
        UNetConnection::WritePacketHeader()
            FNetPacketNotify::WriteHeader()
        UNetConnection::WriteDummyPacketInfo()
    UNetConnection::WriteBitsToSendBufferInternal()
```

- Packet 接收

```cpp
UNetConnection::ReceivedRawPacket()
    UNetConnection::ReceivedPacket()
    [UNetConnection::FlushPacketOrderCache(false)
        UNetConnection::ReceivedPacket()]
        FNetPacketNotify::ReadHeader()
        FNetPacketNotify::Update()
        UNetConnection::DispatchPacket()
```