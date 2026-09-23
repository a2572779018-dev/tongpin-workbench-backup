/** Click, paste and drop share one order-preserving batch. Content validation
 * remains in extractAttachment/validateAttachments; metadata is only dedup. */
export function uniqueIntakeFiles(files: readonly File[]): File[] {
  const keys = new Set<string>();
  return files.filter(file => {
    const key = JSON.stringify([file.name, file.type, file.size, file.lastModified]);
    if (keys.has(key)) return false;
    keys.add(key); return true;
  });
}
export function containsFileDrag(types: readonly string[]) { return types.includes("Files"); }
