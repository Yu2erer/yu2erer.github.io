---
title: UE5 蓝图编译流程剖析
categories: UE
date: 2025-02-02 22:46:20
keywords: UE5, 蓝图编译, UE5蓝图编译
tags: [UE5, 蓝图编译]
---

本文以 UE5.4 为基准，剖析蓝图编译的全流程。在阅读本文之前，需要比较熟悉蓝图，比较熟悉反射，同时最好先阅读 [蓝图编译器概述](https://dev.epicgames.com/documentation/zh-cn/unreal-engine/compiler-overview-for-blueprints-visual-scripting-in-unreal-engine)。

## 简介

UE5 的蓝图编译总共分为16个阶段，可简单分类为收集、过滤、验证、兼容、构建骨架、构建语句、生成字节码，重新链接这几个阶段。

```cpp
STAGE I: GATHER
STAGE II: FILTER
STAGE III: SORT
STAGE IV: SET TEMPORARY BLUEPRINT FLAGS
STAGE V: VALIDATE
STAGE VI: PURGE (LOAD ONLY)
STAGE VII: DISCARD SKELETON CDO
STAGE VIII: RECOMPILE SKELETON
STAGE IX: RECONSTRUCT NODES, REPLACE DEPRECATED NODES (LOAD ONLY)
STAGE X: CREATE REINSTANCER (DISCARD 'OLD' CLASS)
STAGE XI: CREATE UPDATED CLASS HIERARCHY
STAGE XII: COMPILE CLASS LAYOUT
STAGE XIII: COMPILE CLASS FUNCTIONS
STAGE XIV: REINSTANCE
STAGE XV: POST CDO COMPILED 
STAGE XVI: CLEAR TEMPORARY FLAGS
```

下面将从蓝图编辑器按下编译按钮时进行剖析，在每个阶段遇到新的概念时会进行讲解。

当按下蓝图的编译按钮时，将会执行到 `FBlueprintEditor::Compile()` 。

```cpp
void FBlueprintEditor::Compile()
{
    UBlueprint* BlueprintObj = GetBlueprintObj();
    FKismetEditorUtilities::CompileBlueprint(BlueprintObj, CompileOptions, &LogResults);
    ...
}
```

`UBlueprint` 就是用户正在编辑的蓝图资源。

最终会进入 `FBlueprintCompilationManagerImpl::FlushCompilationQueueImpl` 函数，此时正式进入蓝图编译的16个阶段。

![UE5_blueprint_compile](images/UE5_blueprint_compile.png)

## STAGE I: GATHER

阶段1：收集所有需要重新编译的依赖蓝图。

若当前编译的蓝图是宏蓝图，则需要完全编译(生成骨架、字节码)所有依赖该宏蓝图的蓝图，因为宏的引脚类型可能发生变化。

而依赖该普通蓝图的蓝图仅需重新生成字节码，而不重新生成骨架，虽然引脚类型也可能发生改变，但此时还没有足够的信息证实是否发生了改变，先假定没有发生改变，避免不必要的开销。

<!-- more -->

```cpp
// STAGE I: Add any related blueprints that were not compiled, then add any children so that they will be relinked:
TArray<UBlueprint*> BlueprintsToRecompile;
for(const FBPCompileRequestInternal& CompileJob : QueuedRequests)
{
    UBlueprint* BP = CompileJob.UserData.BPToCompile;

    if(BP->BlueprintType == BPTYPE_MacroLibrary)
    {
        TArray<UBlueprint*> DependentBlueprints;
        FBlueprintEditorUtils::GetDependentBlueprints(BP, DependentBlueprints);
        for(UBlueprint* DependentBlueprint : DependentBlueprints)
        {
            if(!IsQueuedForCompilation(DependentBlueprint))
            {
                DependentBlueprint->bCachedDependenciesUpToDate &= !bWasDependencyCacheOutOfDate;

                DependentBlueprint->bQueuedForCompilation = true;
                CurrentlyCompilingBPs.Emplace(
                    FCompilerData(
                        DependentBlueprint, 
                        ECompilationManagerJobType::Normal, 
                        nullptr, 
                        EBlueprintCompileOptions::None,
                        false // full compile
                    )
                );
                BlueprintsToRecompile.Add(DependentBlueprint);
            }
        }
    }
}
for(const FBPCompileRequestInternal& CompileJob : QueuedRequests)
{
    TArray<UBlueprint*> DependentBlueprints;
    FBlueprintEditorUtils::GetDependentBlueprints(CompileJob.UserData.BPToCompile, DependentBlueprints);
    for(UBlueprint* DependentBlueprint : DependentBlueprints)
    {
        if(!IsQueuedForCompilation(DependentBlueprint))
        {
            DependentBlueprint->bQueuedForCompilation = true;
            CurrentlyCompilingBPs.Emplace(
                FCompilerData(
                    DependentBlueprint, 
                    ECompilationManagerJobType::Normal, 
                    nullptr, 
                    EBlueprintCompileOptions::None,
                    true
                )
            );
            BlueprintsToRecompile.Add(DependentBlueprint);
        }
    }
}
```

## STAGE II: FILTER

阶段2：过滤掉不需要完整编译的蓝图，比如接口蓝图(没有逻辑)，或是纯数据蓝图，当纯数据蓝图与其父类具有相同的内存布局或父类为原生类时可以跳过编译，这两类蓝图虽然不需要完整编译，但仍需生成骨架用于编辑器展示。

`FBlueprintEditorUtils::RemoveStaleFunctions` 是用来删除函数的，当当前为纯数据蓝图时，它的前身可能是从有函数的蓝图中过渡过来的，需要从 `UBlueprintGeneratedClass` 中删除它过时的函数。

`UBlueprintGeneratedClass` 就是根据蓝图资源生成的类，平时加载资源时带的 `_C` 后缀就是指的是它，该类若不含字节码则为骨架，骨架只包含变量和函数声明，用于编辑器展示。含有编译后的字节码则为真正的蓝图执行类。

同时默认该骨骼的子类骨骼至少是 `relink` (猜测是因为子类蓝图未必是依赖父类的，但不清楚什么情况下才会是这样，有知道的留言一下。)

```cpp
// STAGE II: Filter out data only and interface blueprints:
for(int32 I = 0; I < QueuedRequests.Num(); ++I)
{
    FBPCompileRequestInternal& QueuedJob = QueuedRequests[I];
    UBlueprint* QueuedBP = QueuedJob.UserData.BPToCompile;

    bool bDefaultComponentMustBeAdded = false;
    bool bHasPendingUberGraphFrame = false;
    UBlueprintGeneratedClass* BPGC = Cast<UBlueprintGeneratedClass>(QueuedBP->GeneratedClass);

    if(BPGC)
    {
        if( BPGC->SimpleConstructionScript &&
            BPGC->SimpleConstructionScript->GetSceneRootComponentTemplate(true) == nullptr)
        {
            bDefaultComponentMustBeAdded = true;
        }

        bHasPendingUberGraphFrame = BPGC->UberGraphFramePointerProperty || BPGC->UberGraphFunction;
    }

    bool bSkipCompile = false;
    const UClass* ParentClass = QueuedBP->ParentClass;
    const bool bHasClassAndMatchesParent = BPGC && BPGC->GetSuperClass() == ParentClass;
    if( bHasClassAndMatchesParent &&
        FBlueprintEditorUtils::IsDataOnlyBlueprint(QueuedBP) && !QueuedBP->bHasBeenRegenerated && 
        QueuedBP->GetLinker() && !bDefaultComponentMustBeAdded && !bHasPendingUberGraphFrame )
    {
        // consider skipping the compile operation for this DOB:
        if (ParentClass && ParentClass->HasAllClassFlags(CLASS_Native))
        {
            bSkipCompile = true;
        }
        else if (const UClass* CurrentClass = QueuedBP->GeneratedClass)
        {
            if(FStructUtils::TheSameLayout(CurrentClass, CurrentClass->GetSuperStruct()))
            {
                bSkipCompile = true;
            }
        }
    }

    if(bSkipCompile)
    {
        CurrentlyCompilingBPs.Emplace(
            FCompilerData(
                QueuedBP, 
                ECompilationManagerJobType::SkeletonOnly, 
                QueuedJob.UserData.ClientResultsLog, 
                QueuedJob.UserData.CompileOptions,
                false
            )
        );
        if (QueuedBP->GeneratedClass != nullptr)
        {
            // set bIsRegeneratingOnLoad so that we don't reset loaders:
            QueuedBP->bIsRegeneratingOnLoad = true;
            FBlueprintEditorUtils::RemoveStaleFunctions(Cast<UBlueprintGeneratedClass>(QueuedBP->GeneratedClass), QueuedBP);
            QueuedBP->bIsRegeneratingOnLoad = false;
        }

        // No actual compilation work to be done, but try to conform the class and fix up anything that might need to be updated if the native base class has changed in any way
        FKismetEditorUtilities::ConformBlueprintFlagsAndComponents(QueuedBP);

        if (QueuedBP->GeneratedClass)
        {
            FBlueprintEditorUtils::RecreateClassMetaData(QueuedBP, QueuedBP->GeneratedClass, true);
        }

        QueuedRequests.RemoveAtSwap(I);
        --I;
    }
    else
    {
        ECompilationManagerJobType JobType = ECompilationManagerJobType::Normal;
        if ((QueuedJob.UserData.CompileOptions & EBlueprintCompileOptions::RegenerateSkeletonOnly) != EBlueprintCompileOptions::None)
        {
            JobType = ECompilationManagerJobType::SkeletonOnly;
        }

        CurrentlyCompilingBPs.Emplace(
            FCompilerData(
                QueuedBP, 
                JobType, 
                QueuedJob.UserData.ClientResultsLog, 
                QueuedJob.UserData.CompileOptions, 
                false
            )
        );

        BlueprintsToRecompile.Add(QueuedBP);
    }
}

for(UBlueprint* BP : BlueprintsToRecompile)
{
    // make sure all children are at least re-linked:
    if(UClass* OldSkeletonClass = BP->SkeletonGeneratedClass)
    {
        TArray<UClass*> SkeletonClassesToReparentList;
        // Has to be recursive gather of children because instances of a UClass will cache information about
        // classes that are above their immediate parent (e.g. ClassConstructor):
        GetDerivedClasses(OldSkeletonClass, SkeletonClassesToReparentList);

        for(UClass* ChildClass : SkeletonClassesToReparentList)
        {
            if(UBlueprint* ChildBlueprint = UBlueprint::GetBlueprintFromClass(ChildClass))
            {
                if(!IsQueuedForCompilation(ChildBlueprint))
                {
                    ChildBlueprint->bQueuedForCompilation = true;
                    CurrentlyCompilingBPs.Emplace(
                        FCompilerData(
                            ChildBlueprint, 
                            ECompilationManagerJobType::RelinkOnly, 
                            nullptr, 
                            EBlueprintCompileOptions::None,
                            false
                        )
                    );
                }
            }
        }
    }
}
CurrentlyCompilingBPs.RemoveAll(
    [](FCompilerData& Data)
    { 
        if(!IsValid(Data.BP))
        {
            check(!Data.BP->bBeingCompiled);
            check(Data.BP->CurrentMessageLog == nullptr);
            if(UPackage* Package = Data.BP->GetOutermost())
            {
                Package->SetDirtyFlag(Data.bPackageWasDirty);
            }
            if(Data.ResultsLog)
            {
                Data.ResultsLog->EndEvent();
            }
            Data.BP->bQueuedForCompilation = false;
            return true;
        }
        return false;
    }
);

BlueprintsToRecompile.Empty();
QueuedRequests.Empty();
```

## STAGE III: SORT

阶段3：对要编译的蓝图进行排序，排序目的是保证编译先后顺序，比如接口要先编译，父类要在子类之前编译。

```cpp
// STAGE III: Sort into correct compilation order. We want to compile root types before their derived (child) types:
auto HierarchyDepthSortFn = [](const FCompilerData& CompilerDataA, const FCompilerData& CompilerDataB)
{
    UBlueprint& A = *(CompilerDataA.BP);
    UBlueprint& B = *(CompilerDataB.BP);

    bool bAIsInterface = FBlueprintEditorUtils::IsInterfaceBlueprint(&A);
    bool bBIsInterface = FBlueprintEditorUtils::IsInterfaceBlueprint(&B);

    if(bAIsInterface && !bBIsInterface)
    {
        return true;
    }
    else if(bBIsInterface && !bAIsInterface)
    {
        return false;
    }

    return FBlueprintCompileReinstancer::ReinstancerOrderingFunction(A.GeneratedClass, B.GeneratedClass);
};
CurrentlyCompilingBPs.Sort( HierarchyDepthSortFn );
```

## STAGE IV: SET TEMPORARY BLUEPRINT FLAGS

阶段4：设置蓝图标记， `bBeingCompiled` 是否正在编译， `bIsRegeneratingOnLoad` 是否在加载时重新生成， `GetLinker` 找的到则说明该蓝图已经持有化了。

同时清除掉所有编译信息。

`UEdGraph` 就是蓝图中的图，在编辑器里面创建节点的那个大框框就是它。

```cpp
// STAGE IV: Set UBlueprint flags (bBeingCompiled, bIsRegeneratingOnLoad)
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    if (!CompilerData.ShouldSetTemporaryBlueprintFlags())
    {
        continue;
    }

    UBlueprint* BP = CompilerData.BP;
    BP->bBeingCompiled = true;
    BP->CurrentMessageLog = CompilerData.ActiveResultsLog;
    BP->bIsRegeneratingOnLoad = !BP->bHasBeenRegenerated && BP->GetLinker();

    if(CompilerData.ShouldResetErrorState())
    {
        TArray<UEdGraph*> AllGraphs;
        BP->GetAllGraphs(AllGraphs);
        for (UEdGraph* Graph : AllGraphs )
        {
            for (UEdGraphNode* GraphNode : Graph->Nodes)
            {
                if (GraphNode)
                {
                    GraphNode->ClearCompilerMessage();
                }
            }
        }
    }
}
```

## STAGE V: VALIDATE

阶段5：验证变量名和类属性的默认值。比如有个类属性的类型是 `AClass` 此时修改为了 `BClass` 这个时候值可能还是 `AClass` 类型，就需要抛出错误了。

第二阶段是为了进行版本兼容的，可以忽略。

`FKismetCompilerContext` 是执行编译工作类，每次编译的时候都会生成一个新的 `Context` 存储正在编译的蓝图。

`FKismetFunctionContext` 则是用于编译每个函数的类，到目前为止还没有见到，先提前了解一下。

```cpp
// STAGE V: Validate
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    if(!CompilerData.ShouldValidate())
    {
        continue;
    }
    CompilerData.Compiler->ValidateVariableNames();
    CompilerData.Compiler->ValidateClassPropertyDefaults();
}

// STAGE V (phase 2): Give the blueprint the possibility for edits
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    UBlueprint* BP = CompilerData.BP;
    if (BP->bIsRegeneratingOnLoad)
    {
        FKismetCompilerContext& CompilerContext = *(CompilerData.Compiler);
        CompilerContext.PreCompileUpdateBlueprintOnLoad(BP);
    }
}
```

## STAGE VI: PURGE (LOAD ONLY)

阶段6：清除 `SubGraph` 中的空节点，阶段名字带 `(LOAD ONLY)` 的都是只在加载时执行的步骤，目的是为了版本兼容。 `ConformNativeComponents` 确保 **蓝图** 的 **组件** 与其 **原生父类（Native Superclass）** 的组件状态保持一致，可以忽略这一阶段。

```cpp
// STAGE VI: Purge null graphs, misc. data fixup
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    UBlueprint* BP = CompilerData.BP;
    if(BP->bIsRegeneratingOnLoad)
    {
        FBlueprintEditorUtils::PurgeNullGraphs(BP);
        BP->ConformNativeComponents();
        if (FLinkerLoad* Linker = BP->GetLinker())
        {
            if (Linker->UEVer() < VER_UE4_EDITORONLY_BLUEPRINTS)
            {
                BP->ChangeOwnerOfTemplates();
            }
        }
    }
}
```

## STAGE VII: DISCARD SKELETON CDO

阶段7：为了让骨骼的CDO能被垃圾回收，因为骨骼本身还要保留，转移走旧骨架的CDO，转移方式是构造一个拷贝骨架，在原始名字前加上 `REINST_` 前缀，将旧骨架CDO赋给它。

**固定父类的 CDO 版本** 让蓝图在编译时不需要频繁修改父类和子类的依赖关系，避免了复杂的循环和重复计算。

```cpp
// STAGE VII: safely throw away old skeleton CDOs:
TMap<UClass*, UClass*> NewSkeletonToOldSkeleton;
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    UBlueprint* BP = CompilerData.BP;
    UClass* OldSkeletonClass = BP->SkeletonGeneratedClass;
    if(OldSkeletonClass)
    {
        FBlueprintCompileReinstancer::MoveDependentSkelToReinst(OldSkeletonClass, NewSkeletonToOldSkeleton);
    }
}
```

## STAGE VIII: recompile skeleton

阶段8：重建骨架，核心函数是 `FastGenerateSkeletonClass` ，会构建 UFunction、Event 以及 Timeline，注意此时不会为其生成实际的字节码，它只是个骨架，此时骨架的CDO会重建。

```cpp
// STAGE VIII: recompile skeleton

// if any function signatures have changed in this skeleton class we will need to recompile all dependencies, but if not
// then we can avoid dependency recompilation:
bool bSkipUnneededDependencyCompilation = !Private::ConsoleVariables::bForceAllDependenciesToRecompile;
TSet<UObject*> OldFunctionsWithSignatureChanges;

for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    UBlueprint* BP = CompilerData.BP;

    if(CompilerData.ShouldRegenerateSkeleton())
    {
        if(BlueprintsCompiledOrSkeletonCompiled)
        {
            BlueprintsCompiledOrSkeletonCompiled->Add(BP);
        }

        BP->SkeletonGeneratedClass = FastGenerateSkeletonClass(BP, *(CompilerData.Compiler), CompilerData.IsSkeletonOnly(), CompilerData.SkeletonFixupData);
        UBlueprintGeneratedClass* AuthoritativeClass = Cast<UBlueprintGeneratedClass>(BP->GeneratedClass);
        if(AuthoritativeClass && bSkipUnneededDependencyCompilation)
        {
            if(CompilerData.InternalOptions.CompileType == EKismetCompileType::Full )
            {
                for (TFieldIterator<UFunction> FuncIt(AuthoritativeClass, EFieldIteratorFlags::ExcludeSuper); FuncIt; ++FuncIt)
                {
                    UFunction* OldFunction = *FuncIt;

                    if(!OldFunction->HasAnyFunctionFlags(EFunctionFlags::FUNC_BlueprintCallable))
                    {
                        continue;
                    }

                    // We assume that if the func is FUNC_BlueprintCallable that it will be present in the Skeleton class.
                    // If it is not in the skeleton class we will always think that this blueprints public interface has 
                    // changed. Not a huge deal, but will mean we recompile dependencies more often than necessary.
                    UFunction* NewFunction = BP->SkeletonGeneratedClass->FindFunctionByName((OldFunction)->GetFName());
                    if(	NewFunction == nullptr || 
                        !NewFunction->IsSignatureCompatibleWith(OldFunction) || 
                        // If a function changes its net flags, callers may now need to do a full EX_FinalFunction/EX_VirtualFunction 
                        // instead of a EX_LocalFinalFunction/EX_LocalVirtualFunction:
                        NewFunction->HasAnyFunctionFlags(FUNC_NetFuncFlags) != OldFunction->HasAnyFunctionFlags(FUNC_NetFuncFlags))
                    {
                        OldFunctionsWithSignatureChanges.Add(OldFunction);
                        break;
                    }
                }
            }
        }
    }
    else
    {
        // Just relink, note that UProperties that reference *other* types may be stale until
        // we fixup below:
        RelinkSkeleton(BP->SkeletonGeneratedClass);
    }

    if(CompilerData.ShouldMarkUpToDateAfterSkeletonStage())
    {
        // Flag data only blueprints as being up-to-date
        BP->Status = BP->bHasBeenRegenerated ? CompilerData.OriginalBPStatus : BS_UpToDate;
        BP->bHasBeenRegenerated = true;
        if (BP->GeneratedClass)
        {
            BP->GeneratedClass->ClearFunctionMapsCaches();
        }
    }
}
```

修正 `Delegate` 签名。

```cpp
// Fix up delegate parameters on skeleton class UFunctions, as they have a direct reference to a UFunction*
// that may have been created as part of skeleton generation:
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    TRACE_CPUPROFILER_EVENT_SCOPE(FixUpDelegateParameters);

    UBlueprint* BP = CompilerData.BP;
    TArray<FSkeletonFixupData>& ParamsToFix = CompilerData.SkeletonFixupData;
    for( const FSkeletonFixupData& FixupData : ParamsToFix )
    {
        if(FDelegateProperty* DelegateProperty = CastField<FDelegateProperty>(FixupData.DelegateProperty))
        {
            FSkeletonFixupData::FixUpDelegateProperty(DelegateProperty, FixupData.MemberReference, BP->SkeletonGeneratedClass);
        }
        else if(FMulticastDelegateProperty* MCDelegateProperty = CastField<FMulticastDelegateProperty>(FixupData.DelegateProperty))
        {
            FSkeletonFixupData::FixUpDelegateProperty(MCDelegateProperty, FixupData.MemberReference, BP->SkeletonGeneratedClass);
        }
    }
}

```

若依赖当前蓝图的蓝图函数签名未改变则不需要重新编译，这类优化可以跳过不看，理清主流程即可。

```cpp
// Skip further compilation for blueprints that are being bytecode compiled as a dependency of something that has
// not had a change in its function parameters:
if(bSkipUnneededDependencyCompilation)
{
    const auto HasNoReferencesToChangedFunctions = [&OldFunctionsWithSignatureChanges](FCompilerData& Data)
    {
        if(!Data.ShouldSkipIfDependenciesAreUnchanged())
        {
            return false;
        }

        // Anim BPs cannot skip un-needed dependency compilation as their property access bytecode
        // will need refreshing due to external class layouts changing (they require at least a bytecode recompile or a relink)
        const bool bIsAnimBlueprintClass = !!Cast<UAnimBlueprint>(Data.BP);
        if(bIsAnimBlueprintClass)
        {
            return false;
        }
        
        // if our parent is still being compiled, then we still need to be compiled:
        UClass* Iter = Data.BP->ParentClass;
        while(Iter)
        {
            if(UBlueprint* BP = Cast<UBlueprint>(Iter->ClassGeneratedBy))
            {
                if(BP->bBeingCompiled)
                {
                    return false;
                }
            }
            Iter = Iter->GetSuperClass();
        }

        // look for references to a function with a signature change
        // in the old class, if it has none, we can skip bytecode recompile:
        bool bHasNoReferencesToChangedFunctions = true;
        UBlueprintGeneratedClass* BPGC = Cast<UBlueprintGeneratedClass>(Data.BP->GeneratedClass);
        if(BPGC)
        {
            for(UFunction* CalledFunction : BPGC->CalledFunctions)
            {
                if(OldFunctionsWithSignatureChanges.Contains(CalledFunction))
                {
                    bHasNoReferencesToChangedFunctions = false;
                    break;
                }
            }
        }

        if(bHasNoReferencesToChangedFunctions)
        {
            // This BP is not actually going to be compiled, clean it up:
            Data.BP->bBeingCompiled = false;
            Data.BP->CurrentMessageLog = nullptr;
            if(UPackage* Package = Data.BP->GetOutermost())
            {
                Package->SetDirtyFlag(Data.bPackageWasDirty);
            }
            if(Data.ResultsLog)
            {
                Data.ResultsLog->EndEvent();
            }
            Data.BP->bQueuedForCompilation = false;
        }

        return bHasNoReferencesToChangedFunctions;
    };

    // Order very much matters, but we could RemoveAllSwap and re-sort:
    CurrentlyCompilingBPs.RemoveAll(HasNoReferencesToChangedFunctions);
}
```

最后是处理新变量的默认值，若当前蓝图的父类有新变量，则记录下来，确保之后能够继承和初始化这些变量。

```cpp
// Detect any variable-based properties that are not in the old generated class, save them for after reinstancing. This can occur 
//    when a new variable is introduced in an ancestor class, and we'll need to use its default as our generated class's initial value.
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    if (CompilerData.JobType == ECompilationManagerJobType::Normal &&
            CompilerData.BP->bHasBeenRegenerated &&		// Note: This ensures that we'll only do this after the Blueprint has been loaded/created; otherwise the class may not contain any properties to find.
            CompilerData.BP->GeneratedClass &&
            !CompilerData.ShouldSkipNewVariableDefaultsDetection())
    {
        const UClass* ParentClass = CompilerData.BP->ParentClass;
        while (const UBlueprint* ParentBP = UBlueprint::GetBlueprintFromClass(ParentClass))
        {
            for (const FBPVariableDescription& ParentBPVarDesc : ParentBP->NewVariables)
            {
                if (!CompilerData.BP->GeneratedClass->FindPropertyByName(ParentBPVarDesc.VarName))
                {
                    CompilerData.NewDefaultVariables.Add(ParentBPVarDesc);
                }
            }

            ParentClass = ParentBP->ParentClass;
        }
    }
}
```

`FastGenerateSkeletonClass` 逻辑很长，此处只摘取一小部分代码，用于讲解概念。

```cpp
UClass* FBlueprintCompilationManagerImpl::FastGenerateSkeletonClass(UBlueprint* BP, FKismetCompilerContext& CompilerContext, bool bIsSkeletonOnly, TArray<FSkeletonFixupData>& OutSkeletonFixupData)
{
    const UEdGraphSchema_K2* Schema = GetDefault<UEdGraphSchema_K2>();
    const auto MakeFunction = [Ret, ParentClass, Schema, BP, &MessageLog, &OutSkeletonFixupData]
        (	FName FunctionNameFName, 
            UField**& InCurrentFieldStorageLocation, 
            FField**& InCurrentParamStorageLocation, 
            EFunctionFlags InFunctionFlags, 
            const TArray<UK2Node_FunctionResult*>& ReturnNodes, 
            const TArray<UEdGraphPin*>& InputPins,
            bool bIsStaticFunction, 
            bool bForceArrayStructRefsConst, 
            UFunction* SignatureOverride) -> UFunction*
    {}
}
```

`UEdGraphSchema_K2` 继承自 `UEdGraphSchema` 用于描述蓝图节点之间是否可以建立连接。

`UK2Node_FunctionResult` 继承 `UK2Node` 又继承自 `UEdGraphNode` 就是蓝图中的一个个节点，此处表示函数的返回值。

`UEdGraphPin` 表示蓝图节点中的引脚，分为输入输出引脚。

## STAGE IX: RECONSTRUCT NODES, REPLACE DEPRECATED NODES (LOAD ONLY)

阶段9：重建节点，替换掉已被废弃的节点，这一步一是为了兼容旧版本，二是为了通知其他依赖该蓝图的蓝图进行重建节点，最后广播预编译出去。

```cpp
// STAGE IX: Reconstruct nodes and replace deprecated nodes, then broadcast 'precompile
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    if(!CompilerData.ShouldReconstructNodes())
    {
        continue;
    }

    UBlueprint* BP = CompilerData.BP;

    ConformToParentAndInterfaces(BP);

    // Some nodes are set up to do things during reconstruction only when this flag is NOT set.
    if(BP->bIsRegeneratingOnLoad)
    {
        FBlueprintEditorUtils::ReconstructAllNodes(BP);
        FBlueprintEditorUtils::ReplaceDeprecatedNodes(BP);
    }
    else
    {
        // matching existing behavior, when compiling a BP not on load we refresh nodes
        // before compiling:
        FBlueprintCompileReinstancer::OptionallyRefreshNodes(BP);
        TArray<UBlueprint*> DependentBlueprints;
        FBlueprintEditorUtils::GetDependentBlueprints(BP, DependentBlueprints);

        for (UBlueprint* CurrentBP : DependentBlueprints)
        {
            const EBlueprintStatus OriginalStatus = CurrentBP->Status;
            UPackage* const Package = CurrentBP->GetOutermost();
            const bool bStartedWithUnsavedChanges = Package != nullptr ? Package->IsDirty() : true;

            FBlueprintEditorUtils::RefreshExternalBlueprintDependencyNodes(CurrentBP, BP->GeneratedClass);

            CurrentBP->Status = OriginalStatus;
            if(Package != nullptr && Package->IsDirty() && !bStartedWithUnsavedChanges)
            {
                Package->SetDirtyFlag(false);
            }
        }
    }
    
    // Broadcast pre-compile
    {
        if(GEditor && GIsEditor)
        {
            GEditor->BroadcastBlueprintPreCompile(BP);
        }
    }

    if (CompilerData.ShouldUpdateBlueprintSearchMetadata())
    {
        // Do not want to run this code without the editor present nor when running commandlets.
        if (GEditor && GIsEditor)
        {
            // We do not want to regenerate a search Guid during loads, nothing has changed in the Blueprint and it is cached elsewhere
            if (!BP->bIsRegeneratingOnLoad)
            {
                FFindInBlueprintSearchManager::Get().AddOrUpdateBlueprintSearchMetadata(BP);
            }
        }
    }
    BP->bHasBeenRegenerated = true;
}
```

## STAGE X: CREATE REINSTANCER (DISCARD 'OLD' CLASS)

阶段10：简单来说就是如果需要重新实例化就要丢掉 CDO，这次是要丢掉 `GeneratedClass` 的 CDO，拷贝了一个新`GeneratedClass` 旧CDO移动到新的 `GeneratedClass` 使其能够正常被垃圾回收， `CompilerData.Compiler->OldClass` 指向的就是新拷贝出来的，和之前骨架的处理一个思路。

确保蓝图的变更能够正确传播到所有已存在的实例和派生类。

需要重新实例化的情况要么是完整编译要么是有父类的 `GeneratedClass` 有新版本。

```cpp
// STAGE X: reinstance every blueprint that is queued, note that this means classes in the hierarchy that are *not* being 
// compiled will be parented to REINST versions of the class, so type checks (IsA, etc) involving those types
// will be incoherent!
{
    for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
    {
        // we including skeleton only compilation jobs for reinstancing because we need UpdateCustomPropertyListForPostConstruction
        // to happen (at the right time) for those generated classes as well. This means we *don't* need to reinstance if 
        // the parent is a native type (unless we hot reload, but that should not need to be handled here):
        if(CompilerData.ShouldSkipReinstancerCreation())
        {
            continue;
        }

        // no need to reinstance skeleton or relink jobs that are not in a hierarchy that has had reinstancing initiated:
        bool bRequiresReinstance = CompilerData.ShouldInitiateReinstancing();
        if (!bRequiresReinstance)
        {
            UClass* Iter = CompilerData.BP->GeneratedClass;
            if (!Iter)
            {
                bRequiresReinstance = true;
            }
            while (Iter)
            {
                if (Iter->HasAnyClassFlags(CLASS_NewerVersionExists))
                {
                    bRequiresReinstance = true;
                    break;
                }

                Iter = Iter->GetSuperClass();
            }
        }

        if (!bRequiresReinstance)
        {
            continue;
        }

        UBlueprint* BP = CompilerData.BP;

        if(BP->GeneratedClass)
        {
            OldCDOs.Add(BP, BP->GeneratedClass->ClassDefaultObject);
        }

        EBlueprintCompileReinstancerFlags CompileReinstancerFlags =
            EBlueprintCompileReinstancerFlags::AutoInferSaveOnCompile
            | EBlueprintCompileReinstancerFlags::AvoidCDODuplication;

        if (CompilerData.UseDeltaSerializationDuringReinstancing())
        {
            CompileReinstancerFlags |= EBlueprintCompileReinstancerFlags::UseDeltaSerialization;
        }

        CompilerData.Reinstancer = TSharedPtr<FBlueprintCompileReinstancer>(
            new FBlueprintCompileReinstancer(
                BP->GeneratedClass,
                CompileReinstancerFlags
            )
        );

        if(CompilerData.Compiler.IsValid())
        {
            CompilerData.Compiler->OldClass = Cast<UBlueprintGeneratedClass>(CompilerData.Reinstancer->DuplicatedClass);
        }

        if(BP->GeneratedClass)
        {
            BP->GeneratedClass->bLayoutChanging = true;
            CompilerData.Reinstancer->SaveSparseClassData(BP->GeneratedClass);
        }
    }
}
```

## STAGE XI: CREATE UPDATED CLASS HIERARCHY

阶段11：修复父子继承链。

```cpp
// STAGE XI: Reinstancing done, lets fix up child->parent pointers and take ownership of SCD:
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    UBlueprint* BP = CompilerData.BP;
    if(BP->GeneratedClass && BP->GeneratedClass->GetSuperClass()->HasAnyClassFlags(CLASS_NewerVersionExists))
    {
        BP->GeneratedClass->SetSuperStruct(BP->GeneratedClass->GetSuperClass()->GetAuthoritativeClass());
    }
    if(BP->GeneratedClass && CompilerData.Reinstancer.IsValid())
    {
        CompilerData.Reinstancer->TakeOwnershipOfSparseClassData(BP->GeneratedClass);
    }
}
```

## STAGE XII: COMPILE CLASS LAYOUT

阶段12：重新编译所有蓝图，核心函数 `CompileClassLayout` 。

```cpp
// STAGE XII: Recompile every blueprint
bGeneratedClassLayoutReady = false;
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    UBlueprint* BP = CompilerData.BP;
    if(CompilerData.ShouldCompileClassLayout())
    {
        // default value propagation occurs in ReinstaneBatch, CDO will be created via CompileFunctions call:
        if(BP->ParentClass)
        {
            if(BP->GeneratedClass)
            {
                BP->GeneratedClass->ClassDefaultObject = nullptr;
            }
            // Reset the flag, so if the user tries to use PIE it will warn them if the BP did not compile
            BP->bDisplayCompilePIEWarning = true;

            // this will create FProperties for the UClass and generate the sparse class data
            // if the compiler in question wants to:
            FKismetCompilerContext& CompilerContext = *(CompilerData.Compiler);
            CompilerContext.CompileClassLayout(EInternalCompilerFlags::PostponeLocalsGenerationUntilPhaseTwo);

            // We immediately relink children so that iterative compilation logic has an easier time:
            TArray<UClass*> ClassesToRelink;
            GetDerivedClasses(BP->GeneratedClass, ClassesToRelink, false);
            for (UClass* ChildClass : ClassesToRelink)
            {
                ChildClass->Bind();
                ChildClass->StaticLink();
            }
        }
        else
        {
            CompilerData.ActiveResultsLog->Error(*LOCTEXT("KismetCompileError_MalformedParentClasss", "Blueprint @@ has missing or NULL parent class.").ToString(), BP);
        }
    }
    else if(CompilerData.Compiler.IsValid() && BP->GeneratedClass)
    {
        CompilerData.Compiler->SetNewClass( CastChecked<UBlueprintGeneratedClass>(BP->GeneratedClass) );
    }
}
FixupDelegateProperties(CurrentlyCompilingBPs);
bGeneratedClassLayoutReady = true;
ProcessExtensions(CurrentlyCompilingBPs);
```

`CompileClassLayout` 大致就是创建 `UFunction` 创建变量这些操作。 `PrecompileFunction` 执行 以下操作：

- 计划执行并计算数据依赖性。
- 删除任何计划外的或不是数据依赖项的节点。
- 在每个剩余节点上运行节点处理器的 **RegisterNets()**。
- 此操作将为函数内的值创建 **FKismetTerms**。
- 创建 **UFunction** 和关联属性。

将函数展开成线性节点，存放到 `LinearExecutionList` 中，用于下一阶段编译。

**CleanAndSanitizeClass()** 将属性和函数从类中移到临时包中的垃圾类中， 然后清除类中的任何数据，生成骨架时也用到了该函数。

```cpp
void FKismetCompilerContext::CompileClassLayout(EInternalCompilerFlags InternalFlags)
{
    CleanAndSanitizeClass(TargetClass, OldCDO);

    // If applicable, register any delegate proxy functions and their captured actor variables
    RegisterClassDelegateProxiesFromBlueprint();

    // Run thru the class defined variables first, get them registered
    CreateClassVariablesFromBlueprint();

    // Add any interfaces that the blueprint implements to the class
    // (has to happen before we validate pin links in CreateFunctionList(), so that we can verify self/interface pins)
    AddInterfacesFromBlueprint(NewClass);

    // Construct a context for each function, doing validation and building the function interface
    CreateFunctionList();

    for (int32 i = 0; i < FunctionList.Num(); ++i)
    {
        if(FunctionList[i].IsDelegateSignature())
        {
            PrecompileFunction(FunctionList[i], InternalFlags);
        }
    }

    for (int32 i = 0; i < FunctionList.Num(); ++i)
    {
        if(!FunctionList[i].IsDelegateSignature())
        {
            PrecompileFunction(FunctionList[i], InternalFlags);
        }
    }
}

```

## STAGE XIII: COMPILE CLASS FUNCTIONS

阶段13：真正编译函数的地方。

```cpp
// STAGE XIII: Compile functions
UBlueprintEditorSettings* Settings = GetMutableDefault<UBlueprintEditorSettings>();
const bool bSaveBlueprintsAfterCompile = Settings->SaveOnCompile == SoC_Always;
const bool bSaveBlueprintAfterCompileSucceeded = Settings->SaveOnCompile == SoC_SuccessOnly;
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    UBlueprint* BP = CompilerData.BP;
    UClass* BPGC = BP->GeneratedClass;

    if(!CompilerData.ShouldCompileClassFunctions())
    {
    // default value propagation occurs below:
    if(BPGC)
    {
        if (CompilerData.Reinstancer.IsValid())
        {
            CompilerData.Reinstancer->PropagateSparseClassDataToNewClass(BPGC);
        }

        if( BPGC->ClassDefaultObject && 
            BPGC->ClassDefaultObject->GetClass() == BPGC)
        {
            BPGC->ClassDefaultObject->Rename(
                nullptr,
                // destination - this is the important part of this call. Moving the object 
                // out of the way so we can reuse its name:
                GetTransientPackage(), 
                // Rename options:
                REN_DoNotDirty | REN_DontCreateRedirectors | REN_ForceNoResetLoaders
            );
        }
        BPGC->ClassDefaultObject = nullptr;

        // class layout is ready, we can clear bLayoutChanging and CompileFunctions can create the CDO:
        BPGC->bLayoutChanging = false;

        FKismetCompilerContext& CompilerContext = *(CompilerData.Compiler);
        CompilerContext.CompileFunctions(
            EInternalCompilerFlags::PostponeLocalsGenerationUntilPhaseTwo
            |EInternalCompilerFlags::PostponeDefaultObjectAssignmentUntilReinstancing
            |EInternalCompilerFlags::SkipRefreshExternalBlueprintDependencyNodes
        ); 
    }

    if(BPGC)
    {
        BPGC->ClassFlags &= ~CLASS_ReplicationDataIsSetUp;
        BPGC->SetUpRuntimeReplicationData();
    }
    FKismetCompilerUtilities::UpdateDependentBlueprints(BP);
}
```

`CompileFunction` 将线性节点展开，纯节点还会进行内联。

```cpp

if (FNodeHandlingFunctor* Handler = NodeHandlers.FindRef(Node->GetClass()))
{
    Handler->Compile(Context, Node);
}
```

`CompileFunction`过程中为每个蓝图节点生成一系列 `Statement` 。

```cpp
FBlueprintCompiledStatement& Statement = Context.AppendStatementForNode(Node);
```

节选一部分 `Statement` 。

```cpp
// FBlueprintCompiledStatement

enum EKismetCompiledStatementType
{
    KCST_Nop = 0,
    // [wiring =] TargetObject->FunctionToCall(wiring)
    KCST_CallFunction = 1,
    // TargetObject->TargetProperty = [wiring]
    KCST_Assignment = 2,
    // One of the other types with a compilation error during statement generation
    KCST_CompileError = 3,
    // goto TargetLabel
    KCST_UnconditionalGoto = 4,
    // FlowStack.Push(TargetLabel)
    KCST_PushState = 5,
    ...
```

使用 `FKismetCompilerVMBackend` 将 `Statement` 翻译成字节码，同时修正跳转。

```cpp
FKismetCompilerVMBackend Backend_VM(Blueprint, Schema, *this);
Backend_VM.GenerateCodeFromClass(NewClass, FunctionList, bGenerateStubsOnly);
```

```cpp
void GenerateCodeForStatement(FKismetCompilerContext& CompilerContext, FKismetFunctionContext& FunctionContext, FBlueprintCompiledStatement& Statement, UEdGraphNode* SourceNode)
{
    // Generate bytecode for the statement
    switch (Statement.Type)
    {
    case KCST_Nop:
        Writer << EX_Nothing;
        break;
    case KCST_CallFunction:
        EmitFunctionCall(CompilerContext, FunctionContext, Statement, SourceNode);
        break;
    ....
}
```

## STAGE XIV: REINSTANCE

阶段14：重新实例化的第一阶段，旧类转移为新类，这部分主要是记录一些信息，方便之后将旧实例替换为新实例，这部分交给 `FlushReinstancingQueueImpl` 完成，和蓝图编译关系不是很大。

```cpp
// STAGE XIV: Now we can finish the first stage of the reinstancing operation, moving old classes to new classes:
TArray<FReinstancingJob> Reinstancers;
// Set up reinstancing jobs - we need a reference to the compiler in order to honor 
// CopyTermDefaultsToDefaultObject
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    if(CompilerData.Reinstancer.IsValid() && CompilerData.Reinstancer->ClassToReinstance)
    {
        Reinstancers.Push(
            FReinstancingJob( CompilerData.Reinstancer, CompilerData.Compiler )
        );
    }
}

FScopedDurationTimer ReinstTimer(GTimeReinstancing);
ReinstanceBatch(Reinstancers, MutableView(ClassesToReinstance), InLoadContext, OldToNewTemplates);

// We purposefully do not remove the OldCDOs yet, need to keep them in memory past first GC
// Set default values on any newly-introduced variables (from ancestor BPs)

for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    if (!CompilerData.NewDefaultVariables.Num())
    {
        continue;
    }

    const UBlueprintGeneratedClass* GenClass = Cast<UBlueprintGeneratedClass>(CompilerData.BP->GeneratedClass);

    if (GenClass && GenClass->ClassDefaultObject)
    {
        for (const FBPVariableDescription& NewInheritedVar : CompilerData.NewDefaultVariables)
        {
            if (const FProperty* MatchingProperty = GenClass->FindPropertyByName(NewInheritedVar.VarName))
            {
                FBlueprintEditorUtils::PropertyValueFromString(MatchingProperty, NewInheritedVar.DefaultValue, reinterpret_cast<uint8*>(GenClass->ClassDefaultObject.Get()));
            }
        }
    }
}
```

## STAGE XV: POST CDO COMPILED

阶段15：里面几乎都是空函数，啥也没做。

```
for (FCompilerData& CompilerData : CurrentlyCompilingBPs)
{
    if (CompilerData.Compiler.IsValid())
    {
        UObject::FPostCDOCompiledContext PostCDOCompiledContext;
        PostCDOCompiledContext.bIsRegeneratingOnLoad = CompilerData.BP->bIsRegeneratingOnLoad;
        PostCDOCompiledContext.bIsSkeletonOnly = CompilerData.IsSkeletonOnly();

        CompilerData.Compiler->PostCDOCompiled(PostCDOCompiledContext);
    }
}
```

## STAGE XVI: CLEAR TEMPORARY FLAGS

阶段16：收尾工作，清理标记，设置好蓝图状态，广播编译完成。

# FlushReinstancingQueueImpl

最后这一部分则是替换实例了，比如场景有个 BP_Actor，这次编译了该蓝图资源，就会用新的 `GeneratedClass` 的 CDO 去 SpawnActor 来替换它。