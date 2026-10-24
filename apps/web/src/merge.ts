import { diff3Merge } from 'node-diff3';

/**
 * Merge `edit` and `current`, both changed from `base`, line by line. Lines only one side
 * changed are taken as they are; lines both sides changed differently are kept between
 * git-style markers, with the current Template first.
 */
export function markConflicts(
  base: string,
  current: { text: string; label: string },
  edit: { text: string; label: string },
): string {
  const lines = (text: string) => text.split('\n');
  return diff3Merge(lines(current.text), lines(base), lines(edit.text), { excludeFalseConflicts: true })
    .flatMap((region) => region.ok ?? [
      `<<<<<<< ${current.label}`,
      ...region.conflict!.a,
      '=======',
      ...region.conflict!.b,
      `>>>>>>> ${edit.label}`,
    ])
    .join('\n');
}
