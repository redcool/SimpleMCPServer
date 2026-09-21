using UnrealBuildTool;
public class MCPUnrealBridge : ModuleRules
{
 public MCPUnrealBridge(ReadOnlyTargetRules Target) : base(Target)
 {
  PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
  PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "AssetRegistry" });
  if (Target.bBuildEditor) PrivateDependencyModuleNames.Add("UnrealEd");
  PrivateDependencyModuleNames.AddRange(new[] { "Projects", "RenderCore", "Json" });
 }
}
