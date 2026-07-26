type MethodGroup = object;

export function installProposalStoreMethods(
  target: object,
  ...groups: MethodGroup[]
): void {
  for (const group of groups) {
    for (const key of Reflect.ownKeys(group)) {
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        throw new Error(`duplicate ProposalStore method: ${String(key)}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(group, key);
      if (!descriptor) continue;
      Object.defineProperty(target, key, {
        ...descriptor,
        enumerable: false,
      });
    }
  }
}
