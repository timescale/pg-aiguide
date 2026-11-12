/**
 * A docs page as a tree of nodes for get_context: the page, then its sections
 * nested by heading path. Every node has a parent (but the page), children
 * and siblings, and its text is its whole subtree.
 *
 * Most Tiger pages have a single H1 that holds every other section. That H1
 * would be a node with the same text as the page, so it is folded into the
 * page: its id resolves to the page, and its children are the page's.
 */

import {
  type DocPage,
  type DocSection,
  renderSections,
  subsectionsOf,
} from './docPages.js';

export type DocNode =
  | { kind: 'page'; page: DocPage }
  | { kind: 'section'; page: DocPage; section: DocSection };

const isPrefixOf = (outer: DocSection, inner: DocSection): boolean =>
  outer.headings.length < inner.headings.length &&
  outer.headings.every((h, i) => inner.headings[i]?.text === h.text);

/** The nearest earlier section whose heading path contains this one's, or null. */
export const parentSectionOf = (
  page: DocPage,
  section: DocSection,
): DocSection | null => {
  const at = page.sections.indexOf(section);
  for (let i = at - 1; i >= 0; i--) {
    const candidate = page.sections[i];
    if (candidate && isPrefixOf(candidate, section)) return candidate;
  }
  return null;
};

/** The page's single top-level section (a Tiger page's H1), if it has one. */
export const rootSectionOf = (page: DocPage): DocSection | null => {
  const top = page.sections.filter((s) => !parentSectionOf(page, s));
  const [only] = top;
  return only && top.length === 1 && only === page.sections[0] ? only : null;
};

/** The node for a section, which is the page when the section is its root. */
export const sectionNode = (page: DocPage, section: DocSection): DocNode =>
  section === rootSectionOf(page)
    ? { kind: 'page', page }
    : { kind: 'section', page, section };

export const parentOf = (node: DocNode): DocNode | null => {
  if (node.kind === 'page') return null;
  const parent = parentSectionOf(node.page, node.section);
  return parent
    ? sectionNode(node.page, parent)
    : { kind: 'page', page: node.page };
};

export const childrenOf = (node: DocNode): DocSection[] => {
  const { page } = node;
  const root = rootSectionOf(page);
  const owner = node.kind === 'page' ? root : node.section;
  return page.sections.filter((s) => {
    if (s === root) return false;
    const parent = parentSectionOf(page, s);
    return owner ? parent === owner : parent === null;
  });
};

/** The sections whose text the node covers, in reading order. */
export const subtreeOf = (node: DocNode): DocSection[] =>
  node.kind === 'page'
    ? node.page.sections
    : [node.section, ...subsectionsOf(node.page, node.section)];

export const textOf = (node: DocNode): string =>
  renderSections(subtreeOf(node));

/** The node's previous and next sibling sections under the same parent. */
export const siblingsOf = (
  node: DocNode,
): { previous: DocSection | null; next: DocSection | null } => {
  if (node.kind === 'page') return { previous: null, next: null };
  const parent = parentOf(node);
  const siblings = parent ? childrenOf(parent) : [];
  const at = siblings.indexOf(node.section);
  return {
    previous: siblings[at - 1] ?? null,
    next: siblings[at + 1] ?? null,
  };
};

export const nodeIdOf = (node: DocNode): string =>
  node.kind === 'page' ? node.page.pageId : node.section.sectionId;

/** The section a URL's #fragment names, matched against each section's link. */
export const sectionOfFragment = (
  page: DocPage,
  url: string,
): DocSection | null => {
  const fragment = url.split('#')[1]?.trim().toLowerCase();
  if (!fragment) return null;
  return (
    page.sections.find(
      (s) => s.url?.split('#')[1]?.trim().toLowerCase() === fragment,
    ) ?? null
  );
};

/** How many leading headings every one of `sections` shares. */
export const sharedHeadingDepth = (sections: DocSection[]): number => {
  const [first, ...rest] = sections;
  if (!first) return 0;
  let depth = first.headings.length;
  for (const s of rest) {
    let i = 0;
    while (i < depth && s.headings[i]?.text === first.headings[i]?.text) i++;
    depth = i;
  }
  return depth;
};
