export type DerivedScopeDisplayPath = {
  path_id: string;
  ancestor_resource: string;
  ancestor_column: string;
  proof?: {
    links?: Array<{
      source_resource: string;
      target_resource: string;
    }>;
  };
};

export function formatDerivedScopePath(scope: DerivedScopeDisplayPath): string {
  const links = scope.proof?.links ?? [];
  const resources: string[] = [];
  if (links[0]?.source_resource) resources.push(links[0].source_resource);
  for (const link of links) {
    if (resources.at(-1) !== link.source_resource) resources.push(link.source_resource);
    if (resources.at(-1) !== link.target_resource) resources.push(link.target_resource);
  }
  if (resources.at(-1) !== scope.ancestor_resource) resources.push(scope.ancestor_resource);
  if (resources.length === 0) resources.push(scope.ancestor_resource);

  const display = resources.map(displayScopeResource);
  display[display.length - 1] = `${display.at(-1)}.${scope.ancestor_column}`;
  return display.join(" -> ");
}

export function formatDerivedScopePathWithId(scope: DerivedScopeDisplayPath): string {
  return `${formatDerivedScopePath(scope)} (exact path ID: ${scope.path_id})`;
}

export function derivedScopeStartSequence(scope: DerivedScopeDisplayPath): string[] {
  const links = scope.proof?.links ?? [];
  const chain = links.length > 0
    ? [links[0]!.source_resource, ...links.map((link) => link.target_resource)]
    : [scope.ancestor_resource];
  if (chain.at(-1) !== scope.ancestor_resource) chain.push(scope.ancestor_resource);
  return [...new Set(chain)].reverse();
}

function displayScopeResource(resource: string): string {
  return resource.startsWith("public.") ? resource.slice("public.".length) : resource;
}
