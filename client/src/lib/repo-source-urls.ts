/* repo-source-urls.ts — deep links to a file in the upstream repo on GitHub or Bitbucket.
   github-urls.ts handles PR-specific links pinned to a sha; this builds branch-relative
   blob URLs for the conventions UI (where we only know default_branch, not a sha). */

type Provider = "github" | "bitbucket";

function encPath(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}

/** Branch-relative file URL on the repo's host, optionally anchored to a line range. */
export function repoBlobUrl(
  provider: Provider,
  fullName: string,
  branch: string,
  path: string,
  startLine?: number | null,
  endLine?: number | null,
): string {
  const branchSeg = encodeURIComponent(branch);
  const pathSeg = encPath(path);
  const base =
    provider === "bitbucket"
      ? `https://bitbucket.org/${fullName}/src/${branchSeg}/${pathSeg}`
      : `https://github.com/${fullName}/blob/${branchSeg}/${pathSeg}`;
  if (startLine == null) return base;
  const sameLine = endLine == null || endLine === startLine;
  if (provider === "bitbucket") {
    return sameLine
      ? `${base}#lines-${startLine}`
      : `${base}#lines-${startLine}:${endLine}`;
  }
  return sameLine ? `${base}#L${startLine}` : `${base}#L${startLine}-L${endLine}`;
}
