import * as fs from "fs-extra";
import sanitize from "sanitize-filename";

import { NotionToMarkdown } from "notion-to-md";
import { HierarchicalNamedLayoutStrategy } from "./HierarchicalNamedLayoutStrategy";
import { FlatSidebarLayoutStrategy } from "./FlatSidebarLayoutStrategy";
import { LayoutStrategy } from "./LayoutStrategy";
import { NotionPage, PageType } from "./NotionPage";
import { initImageHandling, cleanupOldImages } from "./images";

import * as Path from "path";
import {
  endGroup,
  error,
  group,
  info,
  logDebug,
  verbose,
  warning,
} from "./log";
import { IDocuNotionContext } from "./plugins/pluginTypes";
import { getMarkdownForPage } from "./transform";
import { ListBlockChildrenResponseResults } from "notion-to-md/build/types";
import {
  BlockObjectResponse,
  GetPageResponse,
  ListBlockChildrenResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { RateLimiter } from "limiter";
import { Client, isFullBlock } from "@notionhq/client";
import { exit } from "process";
import { IDocuNotionConfig, loadConfigAsync } from "./config/configuration";
import { NotionBlock } from "./types";
import { convertInternalUrl } from "./plugins/internalLinks";

type ImageFileNameFormat = "default" | "content-hash" | "legacy";
export type DocuNotionOptions = {
  notionToken: string;
  rootPage: string;
  locales: string[];
  markdownOutputPath: string;
  imgOutputPath: string;
  imgPrefixInMarkdown: string;
  statusTag: string;
  requireSlugs?: boolean;
  imageFileNameFormat?: ImageFileNameFormat;
  allowMixedContentPages?: boolean;
};

let layoutStrategy: LayoutStrategy;

// Cache to avoid processing the same page multiple times
const processedPageIds = new Set<string>();
let notionToMarkdown: NotionToMarkdown;
const pages = new Array<NotionPage>();

// Structure for tracking page occurrences and building sidebar hierarchy
interface PageOccurrence {
  page: NotionPage;
  layoutContext: string;
  hierarchyLevel: number;
  discoveryOrder: number;
  isReference: boolean; // true if this should be a sidebar reference
}

// Map to track all occurrences of each page for deduplication
const pageOccurrences = new Map<string, PageOccurrence[]>();
let discoveryOrder = 0;

// Structure for sidebar generation
interface SidebarItem {
  type: 'doc' | 'category' | 'ref' | 'link';
  id?: string;
  label?: string;
  items?: SidebarItem[];
  href?: string;
  link?: {
    type: 'doc';
    id: string;
  };
}

// Structure for building hierarchical sidebar
interface HierarchyNode {
  context: string;
  level: number;
  children: HierarchyNode[];
  pages: {
    page: NotionPage;
    isReference: boolean;
    occurrences: PageOccurrence[];
  }[];
}
const counts = {
  output_normally: 0,
  skipped_because_empty: 0,
  skipped_because_status: 0,
  skipped_because_level_cannot_have_content: 0,
  error_because_no_slug: 0,
};

export async function notionPull(options: DocuNotionOptions): Promise<void> {
  // Reset the processed pages cache and deduplication structures for each pull operation
  processedPageIds.clear();
  pageOccurrences.clear();
  discoveryOrder = 0;
  pages.length = 0; // Clear the pages array
  
  // It's helpful when troubleshooting CI secrets and environment variables to see what options actually made it to docu-notion.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const optionsForLogging = { ...options };
  // Just show the first few letters of the notion token, which start with "secret" anyhow.
  optionsForLogging.notionToken =
    optionsForLogging.notionToken.substring(0, 10) + "...";

  const config = await loadConfigAsync();

  verbose(`Options:${JSON.stringify(optionsForLogging, null, 2)}`);
  await initImageHandling(
    options.imgPrefixInMarkdown || options.imgOutputPath || "",
    options.imgOutputPath || "",
    options.locales
  );

  const notionClient = initNotionClient(options.notionToken);
  notionToMarkdown = new NotionToMarkdown({ notionClient });

  // Use flat structure with sidebars.js instead of hierarchical folders
  layoutStrategy = new FlatSidebarLayoutStrategy();

  await fs.mkdir(options.markdownOutputPath, { recursive: true });
  layoutStrategy.setRootDirectoryForMarkdown(
    options.markdownOutputPath.replace(/\/+$/, "") // trim any trailing slash
  );

  info("Connecting to Notion...");

  // Do a  quick test to see if we can connect to the root so that we can give a better error than just a generic "could not find page" one.
  try {
    await executeWithRateLimitAndRetries("retrieving root page", async () => {
      await notionClient.pages.retrieve({ page_id: options.rootPage });
    });
  } catch (e: any) {
    error(
      `docu-notion could not retrieve the root page from Notion. \r\na) Check that the root page id really is "${
        options.rootPage
      }".\r\nb) Check that your Notion API token (the "Integration Secret") is correct. It starts with "${
        optionsForLogging.notionToken
      }".\r\nc) Check that your root page includes your "integration" in its "connections".\r\nThis internal error message may help:\r\n    ${
        e.message as string
      }`
    );
    exit(1);
  }

  group(
    "Stage 1: walk children of the page named 'Outline', looking for pages..."
  );
  await getPagesRecursively(options, config, "", options.rootPage, 0, true);
  logDebug("getPagesRecursively", JSON.stringify(pages, null, 2));
  info(`Found ${pages.length} pages`);
  endGroup();
  group(
    `Stage 2: convert ${pages.length} Notion pages to markdown and save locally...`
  );
  await outputPages(options, config, pages);
  endGroup();
  group("Stage 3: clean up old files & images...");
  await layoutStrategy.cleanupOldFiles();
  await cleanupOldImages();
  endGroup();
}

async function outputPages(
  options: DocuNotionOptions,
  config: IDocuNotionConfig,
  pages: Array<NotionPage>
) {
  const context: IDocuNotionContext = {
    getBlockChildren: getBlockChildren,
    // this changes with each page
    pageInfo: {
      directoryContainingMarkdown: "",
      relativeFilePathToFolderContainingPage: "",
      slug: "",
    },
    layoutStrategy: layoutStrategy,
    notionToMarkdown: notionToMarkdown,
    options: options,
    pages: pages,
    counts: counts, // review will this get copied or pointed to?
    imports: [],
    convertNotionLinkToLocalDocusaurusLink: (url: string) =>
      convertInternalUrl(context, url),
  };
  for (const page of pages) {
    layoutStrategy.pageWasSeen(page);
    const mdPath = layoutStrategy.getPathForPage(page, ".md");

    // most plugins should not write to disk, but those handling image files need these paths
    context.pageInfo.directoryContainingMarkdown = Path.dirname(mdPath);
    // TODO: This needs clarifying: getLinkPathForPage() is about urls, but
    // downstream images.ts is using it as a file system path
    context.pageInfo.relativeFilePathToFolderContainingPage = Path.dirname(
      layoutStrategy.getLinkPathForPage(page)
    );
    context.pageInfo.slug = page.slug;

    if (
      page.type === PageType.DatabasePage &&
      context.options.statusTag != "*" &&
      page.status !== context.options.statusTag
    ) {
      verbose(
        `Skipping page because status is not '${context.options.statusTag}': ${page.nameOrTitle}`
      );
      ++context.counts.skipped_because_status;
    } else {
      if (options.requireSlugs && !page.hasExplicitSlug) {
        error(
          `Page "${page.nameOrTitle}" is missing a required slug. (--require-slugs is set.)`
        );
        ++counts.error_because_no_slug;
      }

      const markdown = await getMarkdownForPage(config, context, page);
      writePage(page, markdown);
    }
  }

  if (counts.error_because_no_slug > 0) exit(1);

  // Generate sidebars.js for flat structure
  verbose("Layout strategy type: " + layoutStrategy.constructor.name);
  if (layoutStrategy instanceof FlatSidebarLayoutStrategy) {
    generateSidebarsFile(options.markdownOutputPath);
  } else {
    verbose("Not generating sidebars.js - using hierarchical strategy");
  }

  info(`Finished processing ${pages.length} pages`);
  info(JSON.stringify(counts));
}

// Generate sidebars.js file based on page occurrences and hierarchy
function generateSidebarsFile(outputPath: string): void {
  verbose("Generating sidebars.js file...");
  
  // Collect all unique pages (only first occurrence, no references)
  const uniquePages: NotionPage[] = [];
  const processedPageIds = new Set<string>();
  
  for (const [pageId, occurrences] of pageOccurrences) {
    if (!processedPageIds.has(pageId)) {
      const mainOccurrence = occurrences.find(occ => !occ.isReference);
      if (mainOccurrence) {
        uniquePages.push(mainOccurrence.page);
        processedPageIds.add(pageId);
      }
    }
  }
  
  // Sort pages by hierarchy level and order
  uniquePages.sort((a, b) => {
    const aLevel = getHierarchyLevel(a.layoutContext);
    const bLevel = getHierarchyLevel(b.layoutContext);
    
    if (aLevel !== bLevel) {
      return aLevel - bLevel;
    }
    return a.order - b.order;
  });
  
  // Debug: Log page hierarchy
  verbose("=== PAGE HIERARCHY DEBUG ===");
  for (const page of uniquePages) {
    const level = getHierarchyLevel(page.layoutContext);
    verbose(`Page: "${page.nameOrTitle}" | Context: "${page.layoutContext}" | Level: ${level} | Order: ${page.order}`);
  }
  verbose("=== END DEBUG ===");
  
  // Build the sidebar structure
  const sidebarItems = buildCleanSidebarStructure(uniquePages);
  
  // Validate and clean sidebar items to ensure all referenced docs exist
  const validatedSidebarItems = validateSidebarItems(sidebarItems, outputPath);
  
  // Generate the sidebars.js content
  const sidebarContent = `module.exports = {
  docs: ${JSON.stringify(validatedSidebarItems, null, 2)}
};`;
  
  // Write the sidebars.js file
  const sidebarPath = outputPath.replace(/docs\/?$/, '') + '/sidebars.js';
  fs.writeFileSync(sidebarPath, sidebarContent);
  verbose(`Generated sidebars.js at ${sidebarPath}`);
}

// Validate sidebar items and remove references to non-existent docs
function validateSidebarItems(items: SidebarItem[], docsPath: string): SidebarItem[] {
  const validatedItems: SidebarItem[] = [];
  
  for (const item of items) {
    if (item.type === 'doc') {
      // Check if the markdown file exists
      const docPath = `${docsPath}/${item.id}.md`;
      if (fs.existsSync(docPath)) {
        validatedItems.push(item);
      } else {
        verbose(`⚠️  Removing missing doc from sidebar: ${item.id} (${docPath} does not exist)`);
      }
    } else if (item.type === 'category') {
      // Recursively validate category items
      const validatedCategoryItems = item.items ? validateSidebarItems(item.items, docsPath) : [];
      
      // Check if category link exists (if it has one)
      let categoryLinkValid = true;
      if (item.link?.type === 'doc') {
        const linkDocPath = `${docsPath}/${item.link.id}.md`;
        if (!fs.existsSync(linkDocPath)) {
          verbose(`⚠️  Category link missing: ${item.link.id} (${linkDocPath} does not exist)`);
          categoryLinkValid = false;
        }
      }
      
      // Only include category if it has valid items or valid link
      if (validatedCategoryItems.length > 0 || (categoryLinkValid && item.link)) {
        const validatedCategory: SidebarItem = {
          ...item,
          items: validatedCategoryItems
        };
        
        // Remove invalid link
        if (!categoryLinkValid) {
          delete validatedCategory.link;
        }
        
        validatedItems.push(validatedCategory);
      } else {
        verbose(`⚠️  Removing empty category from sidebar: ${item.label}`);
      }
    } else {
      // For other types (ref, link), pass through
      validatedItems.push(item);
    }
  }
  
  return validatedItems;
}

// Build clean sidebar structure without duplicates
function buildCleanSidebarStructure(pages: NotionPage[]): SidebarItem[] {
  const sidebarItems: SidebarItem[] = [];
  const categoriesMap = new Map<string, SidebarItem>();
  const pagesWithChildren = new Set<string>();
  
  // First pass: identify pages that have children
  for (const page of pages) {
    const hierarchyLevel = getHierarchyLevel(page.layoutContext);
    
    if (hierarchyLevel === 1) {
      // This is a child page, so its parent has children
      const parentPage = findParentPage(pages, page.layoutContext);
      if (parentPage) {
        pagesWithChildren.add(parentPage.pageId);
      }
    }
  }
  
  // Second pass: build the sidebar structure
  for (const page of pages) {
    const hierarchyLevel = getHierarchyLevel(page.layoutContext);
    const docId = getDocId(page);
    
    // Level 0: Root pages
    if (hierarchyLevel === 0) {
      if (pagesWithChildren.has(page.pageId)) {
        // This page has children - create a category with link
        const categoryLabel = page.icon ? `${page.icon} ${page.nameOrTitle}` : page.nameOrTitle;
        const category: SidebarItem = {
          type: 'category',
          label: categoryLabel,
          link: {
            type: 'doc',
            id: docId
          },
          items: []
        };
        categoriesMap.set(page.pageId, category);
        sidebarItems.push(category);
      } else {
        // This page has no children - add as simple doc
        const docLabel = page.icon ? `${page.icon} ${page.nameOrTitle}` : page.nameOrTitle;
        sidebarItems.push({
          type: 'doc',
          id: docId,
          label: docLabel
        });
      }
    } else {
      // Level 1+: Nested pages (add to parent category)
      const parentPage = findParentPage(pages, page.layoutContext);
      verbose(`Child: "${page.nameOrTitle}" | Context: "${page.layoutContext}" | Parent found: ${parentPage?.nameOrTitle || 'NONE'}`);
      
      if (parentPage && categoriesMap.has(parentPage.pageId)) {
        const category = categoriesMap.get(parentPage.pageId)!;
        category.items!.push({
          type: 'doc',
          id: docId
        });
      }
    }
  }
  
  return sidebarItems;
}

// Get parent context path
function getParentContext(layoutContext: string): string {
  const parts = layoutContext.split('/').filter(p => p.length > 0);
  if (parts.length <= 1) return '/';
  return '/' + parts.slice(0, -1).join('/');
}

// Find parent page by matching the context pattern
function findParentPage(pages: NotionPage[], childContext: string): NotionPage | null {
  // Extract parent name from child context path
  // e.g., "/Les-Briques-de-Configuration-Fondamentales" -> "Les-Briques-de-Configuration-Fondamentales"
  const contextParts = childContext.split('/').filter(p => p.length > 0);
  if (contextParts.length === 0) return null;
  
  const parentContextName = contextParts[contextParts.length - 1];
  verbose(`Looking for parent with context name: "${parentContextName}"`);
  
  // Find the page with level 0 whose slug matches the context
  return pages.find(page => {
    if (getHierarchyLevel(page.layoutContext) !== 0) return false;
    
    // Get the slug without leading slash for comparison
    let pageSlug = page.slug;
    if (pageSlug.startsWith('/')) {
      pageSlug = pageSlug.substring(1);
    }
    
    verbose(`  Checking page: "${page.nameOrTitle}" with slug: "${pageSlug}"`);
    
    // Match context name with page slug
    return parentContextName === pageSlug ||
           parentContextName.toLowerCase() === pageSlug.toLowerCase();
  }) || null;
}

// Helper function to get document ID from page
function getDocId(page: NotionPage): string {
  // Use slug without leading slash as document ID
  let docId = page.slug;
  if (docId.startsWith('/')) {
    docId = docId.substring(1);
  }
  
  // Handle special case of root page (slug is "/")
  if (docId === '' && page.slug === '/') {
    return 'index';
  }
  
  // If no slug or it's a Notion ID, use sanitized name
  if (!docId || docId.trim() === '' || isNotionId(docId)) {
    docId = sanitize(page.nameForFile())
      .replaceAll("//", "/")
      .replaceAll("%20", "-")
      .replaceAll(" ", "-")
      .replaceAll('"', "")
      .replaceAll(/[""]/g, "")
      .replaceAll(/[""]/g, "")
      .replaceAll("'", "")
      .replaceAll("?", "-")
      .toLowerCase();
  }
  
  return docId;
}

// Helper function to check if string is a Notion ID
function isNotionId(str: string): boolean {
  return str.includes('-') && str.length > 30 && /^[a-f0-9-]+$/.test(str);
}

// Helper function to create category from context (simplified)
function createCategoryFromContext(context: string, page: NotionPage): SidebarItem | null {
  // This is a simplified implementation
  // In a full version, we'd need to properly parse the context hierarchy
  const parts = context.split('/').filter(p => p.length > 0);
  if (parts.length === 0) return null;
  
  return {
    type: 'category',
    label: parts[parts.length - 1].replaceAll('-', ' '),
    items: [{
      type: 'doc',
      id: getDocId(page)
    }]
  };
}

// Function to add a page with deduplication logic
function addPageWithDeduplication(
  page: NotionPage, 
  layoutContext: string, 
  hierarchyLevel: number
): void {
  const pageId = page.pageId;
  
  // Get or create the occurrences array for this page
  if (!pageOccurrences.has(pageId)) {
    pageOccurrences.set(pageId, []);
  }
  
  const occurrences = pageOccurrences.get(pageId)!;
  
  // Create the occurrence record
  const occurrence: PageOccurrence = {
    page,
    layoutContext,
    hierarchyLevel,
    discoveryOrder: discoveryOrder++,
    isReference: occurrences.length > 0 // First occurrence is main, others are references
  };
  
  occurrences.push(occurrence);
  
  // Only add to the pages array if this is the first occurrence (main page)
  if (!occurrence.isReference) {
    pages.push(page);
    verbose(`Added main page: ${page.nameOrTitle} at level ${hierarchyLevel}`);
  } else {
    verbose(`Added reference to existing page: ${page.nameOrTitle} at level ${hierarchyLevel} (will be sidebar ref)`);
  }
}

// Calculate hierarchy level based on layout context
function getHierarchyLevel(layoutContext: string): number {
  return (layoutContext.match(/\//g) || []).length;
}

// Extract internal page links found in paragraph text content
// This discovers pages that are linked from within text, not just direct link_to_page blocks
async function extractInternalLinksFromContent(
  pageBlocks: ListBlockChildrenResponseResults
): Promise<string[]> {
  const linkIds: string[] = [];
  const linkRegExp = /\[([^\]]+)?\]\((?:https?:\/\/www\.notion\.so\/|\/)?([^),^/]+)\)/g;
  
  for (const block of pageBlocks) {
    // Handle direct link_to_page blocks
    if ((block as any).type === "link_to_page") {
      const pageId = (block as any).link_to_page?.page_id;
      if (pageId) {
        linkIds.push(pageId);
      }
    }
    // Handle links within paragraph text content
    else if ((block as any).type === "paragraph") {
      const paragraph = (block as any).paragraph;
      if (paragraph.rich_text && Array.isArray(paragraph.rich_text)) {
        for (const richText of paragraph.rich_text) {
          if (richText.href) {
            // Direct href links in rich text
            const match = /https:\/\/www\.notion\.so\S+-([a-z,0-9]+)+.*/.exec(richText.href);
            if (match && match[1]) {
              linkIds.push(match[1]);
            }
          }
          if (richText.plain_text) {
            // Links embedded in plain text (markdown style)
            let match;
            while ((match = linkRegExp.exec(richText.plain_text)) !== null) {
              const linkId = match[2];
              if (linkId && linkId.length > 10) { // Basic validation for Notion IDs
                linkIds.push(linkId);
              }
            }
          }
        }
      }
    }
  }
  
  // Remove duplicates and return
  return [...new Set(linkIds)];
}

// Discover and process pages that are linked from within content
async function discoverLinkedPages(
  options: DocuNotionOptions,
  config: IDocuNotionConfig,
  layoutContext: string,
  pageBlocks: ListBlockChildrenResponseResults,
  currentPage: NotionPage
): Promise<void> {
  const allowMixedContentPages = config.allowMixedContentPages || options.allowMixedContentPages;
  
  // Only discover linked pages if allowMixedContentPages is enabled
  if (!allowMixedContentPages) {
    return;
  }

  const linkedPageIds = await extractInternalLinksFromContent(pageBlocks);
  
  // If this page has linked pages, mark it as mixed content and create a folder structure
  if (linkedPageIds.length > 0) {
    currentPage.hasMixedContent = true;
    
    // Create a new layout context for the linked pages (subfolder)
    // Use the same naming logic as getIndexPathForPage to avoid duplicate folders
    const sanitizedPageName = currentPage.nameForFile()
      .replaceAll("//", "/")
      .replaceAll("%20", "-")
      .replaceAll(" ", "-")
      .replaceAll('"', "")
      .replaceAll(/[""]/g, "")
      .replaceAll(/[""]/g, "")
      .replaceAll("'", "")
      .replaceAll("?", "-");
    
    const newLayoutContext = layoutStrategy.newLevel(
      options.markdownOutputPath,
      currentPage.order,
      layoutContext,
      sanitizedPageName
    );
    
    for (const linkedPageId of linkedPageIds) {
      // Skip if we've already processed this page
      if (processedPageIds.has(linkedPageId)) {
        continue;
      }
      
      try {
        // Add to processed cache immediately to avoid infinite loops
        processedPageIds.add(linkedPageId);
        
        verbose(`Discovering linked page: ${linkedPageId} from ${currentPage.nameOrTitle} in subfolder ${newLayoutContext}`);
        
        // Create the linked page with the new context (places it in the subfolder)
        const linkedPage = await fromPageId(
          newLayoutContext,
          linkedPageId,
          pages.length, // Use current pages length as order
          false // Not found directly in outline
        );
        
        // Use deduplication logic instead of direct push
        addPageWithDeduplication(linkedPage, newLayoutContext, getHierarchyLevel(newLayoutContext));
        
        // Recursively discover and process the linked page's content (with its own context)
        const linkedPageBlocks = await getBlockChildren(linkedPage.pageId);
        await discoverLinkedPages(options, config, newLayoutContext, linkedPageBlocks, linkedPage);
        
      } catch (error) {
        verbose(`Could not fetch linked page ${linkedPageId}: ${error}`);
        // Remove from processed cache if we failed to process it
        processedPageIds.delete(linkedPageId);
      }
    }
  }
}

// This walks the "Outline" page and creates a list of all the nodes that will
// be in the sidebar, including the directories, the pages that are linked to
// that are parented in from the "Database", and any pages we find in the
// outline that contain content (which we call "Simple" pages). Later, we can
// then step through this list creating the files we need, and, crucially, be
// able to figure out what the url will be for any links between content pages.
async function getPagesRecursively(
  options: DocuNotionOptions,
  config: IDocuNotionConfig,
  incomingContext: string,
  pageIdOfThisParent: string,
  orderOfThisParent: number,
  rootLevel: boolean
) {
  // Merge config and options for allowMixedContentPages
  const allowMixedContentPages = config.allowMixedContentPages || options.allowMixedContentPages;
  
  const pageInTheOutline = await fromPageId(
    incomingContext,
    pageIdOfThisParent,
    orderOfThisParent,
    true
  );

  info(
    `Looking for children and links from ${incomingContext}/${pageInTheOutline.nameOrTitle}`
  );

  const r = await getBlockChildren(pageInTheOutline.pageId);
  const pageInfo = await pageInTheOutline.getContentInfo(r);

  if (
    !rootLevel &&
    pageInfo.hasParagraphs &&
    (pageInfo.childPageIdsAndOrder.length || pageInfo.linksPageIdsAndOrder.length) &&
    !allowMixedContentPages
  ) {
    error(
      `Skipping "${pageInTheOutline.nameOrTitle}"  and its children. docu-notion does not support pages that are both levels and have text content (paragraphs) at the same time. Normally outline pages should just be composed of 1) links to other pages and 2) child pages (other levels of the outline). Note that @-mention style links appear as text paragraphs to docu-notion so must not be used to form the outline. To enable this feature, set allowMixedContentPages: true in your docu-notion.config.ts file.`
    );
    ++counts.skipped_because_level_cannot_have_content;
    return;
  }
  if (!rootLevel && pageInfo.hasParagraphs) {
    // If this page has child pages OR linked pages and allowMixedContentPages is enabled, mark it as mixed content BEFORE adding to pages
    if ((pageInfo.childPageIdsAndOrder.length || pageInfo.linksPageIdsAndOrder?.length) && allowMixedContentPages) {
      pageInTheOutline.hasMixedContent = true;
    }
    
    // Use deduplication logic instead of direct push
    addPageWithDeduplication(pageInTheOutline, incomingContext, getHierarchyLevel(incomingContext));
    
    // Mark this page as processed to avoid infinite loops
    processedPageIds.add(pageInTheOutline.pageId);
    
    // Discover any pages that are linked from within this page's content
    await discoverLinkedPages(options, config, incomingContext, r, pageInTheOutline);

    // The best practice is to keep content pages in the "database" (e.g. kanban board), but we do allow people to make pages in the outline directly.
    // So how can we tell the difference between a page that is supposed to be content and one that is meant to form the sidebar? If it
    // has only links, then it's a page for forming the sidebar. If it has contents and no links, then it's a content page. But what if
    // it has both? Well then we assume it's a content page.
    if (pageInfo.linksPageIdsAndOrder?.length) {
      warning(
        `Note: The page "${pageInTheOutline.nameOrTitle}" is in the outline, has content, and also points at other pages. It will be treated as a simple content page. This is no problem, unless you intended to have all your content pages in the database (kanban workflow) section.`
      );
    }
    
    // If this page has child pages and allowMixedContentPages is enabled, process the children
    if (pageInfo.childPageIdsAndOrder.length && allowMixedContentPages) {
      let layoutContext = incomingContext;
      if (!rootLevel && pageInTheOutline.nameOrTitle !== "Outline") {
        layoutContext = layoutStrategy.newLevel(
          options.markdownOutputPath,
          pageInTheOutline.order,
          incomingContext,
          pageInTheOutline.nameOrTitle
        );
      }
      for (const childPageInfo of pageInfo.childPageIdsAndOrder) {
        await getPagesRecursively(
          options,
          config,
          layoutContext,
          childPageInfo.id,
          childPageInfo.order,
          false
        );
      }
    }
    
    // If this page has linked pages and allowMixedContentPages is enabled, process the linked pages in the same folder
    if (pageInfo.linksPageIdsAndOrder?.length && allowMixedContentPages && pageInTheOutline.hasMixedContent) {
      let layoutContext = incomingContext;
      if (!rootLevel && pageInTheOutline.nameOrTitle !== "Outline") {
        layoutContext = layoutStrategy.newLevel(
          options.markdownOutputPath,
          pageInTheOutline.order,
          incomingContext,
          pageInTheOutline.nameOrTitle
        );
      }
      for (const linkPageInfo of pageInfo.linksPageIdsAndOrder) {
        const linkedPage = await fromPageId(
          layoutContext,
          linkPageInfo.id,
          linkPageInfo.order,
          false
        );
        // Use deduplication logic instead of direct push
        addPageWithDeduplication(linkedPage, layoutContext, getHierarchyLevel(layoutContext));
        
        // Mark this page as processed and discover its linked pages
        processedPageIds.add(linkedPage.pageId);
        const linkedPageBlocks = await getBlockChildren(linkedPage.pageId);
        await discoverLinkedPages(options, config, layoutContext, linkedPageBlocks, linkedPage);
      }
    }
  }
  // a normal outline page that exists just to create the level, pointing at database pages that belong in this level
  // Skip if this page was already processed as a mixed content page
  else if (
    (pageInfo.childPageIdsAndOrder.length || pageInfo.linksPageIdsAndOrder.length) &&
    !pageInTheOutline.hasMixedContent
  ) {
    let layoutContext = incomingContext;
    // don't make a level for "Outline" page at the root
    if (!rootLevel && pageInTheOutline.nameOrTitle !== "Outline") {
      layoutContext = layoutStrategy.newLevel(
        options.markdownOutputPath,
        pageInTheOutline.order,
        incomingContext,
        pageInTheOutline.nameOrTitle
      );
    }
    for (const childPageInfo of pageInfo.childPageIdsAndOrder) {
      await getPagesRecursively(
        options,
        config,
        layoutContext,
        childPageInfo.id,
        childPageInfo.order,
        false
      );
    }

    // Process linked pages for regular outline pages
    for (const linkPageInfo of pageInfo.linksPageIdsAndOrder) {
      const linkedPage = await fromPageId(
        layoutContext,
        linkPageInfo.id,
        linkPageInfo.order,
        false
      );
      // Use deduplication logic instead of direct push
      addPageWithDeduplication(linkedPage, layoutContext, getHierarchyLevel(layoutContext));
      
      // Mark this page as processed and discover its linked pages
      processedPageIds.add(linkedPage.pageId);
      const linkedPageBlocks = await getBlockChildren(linkedPage.pageId);
      await discoverLinkedPages(options, config, layoutContext, linkedPageBlocks, linkedPage);
    }
  } else {
    console.info(
      warning(
        `Warning: The page "${pageInTheOutline.nameOrTitle}" is in the outline but appears to not have content, links to other pages, or child pages. It will be skipped.`
      )
    );
    ++counts.skipped_because_empty;
  }
}

function writePage(page: NotionPage, finalMarkdown: string) {
  let mdPath: string;
  
  if (page.hasMixedContent) {
    // For pages with mixed content, create an index.md file
    mdPath = layoutStrategy.getIndexPathForPage(page, ".md");
  } else {
    // Regular behavior for normal pages
    mdPath = layoutStrategy.getPathForPage(page, ".md");
  }
  
  verbose(`writing ${mdPath}`);
  fs.writeFileSync(mdPath, finalMarkdown, {});
  ++counts.output_normally;
}

const notionLimiter = new RateLimiter({
  tokensPerInterval: 3,
  interval: "second",
});

let notionClient: Client;

async function getPageMetadata(id: string): Promise<GetPageResponse> {
  return await executeWithRateLimitAndRetries(`pages.retrieve(${id})`, () => {
    return notionClient.pages.retrieve({
      page_id: id,
    });
  });
}

// While everything works fine locally, on Github Actions we are getting a lot of timeouts, so
// we're trying this extra retry-able wrapper.
export async function executeWithRateLimitAndRetries<T>(
  label: string,
  asyncFunction: () => Promise<T>
): Promise<T> {
  await rateLimit();
  const kRetries = 10;
  let lastException = undefined;
  for (let i = 0; i < kRetries; i++) {
    try {
      return await asyncFunction();
    } catch (e: any) {
      lastException = e;
      if (
        e?.code === "notionhq_client_request_timeout" ||
        e.message.includes("timeout") ||
        e.message.includes("Timeout") ||
        e.message.includes("limit") ||
        e.message.includes("Limit") ||
        e?.code === "notionhq_client_response_error" ||
        e?.code === "service_unavailable"
      ) {
        const secondsToWait = i + 1;
        warning(
          `While doing "${label}", got error "${
            e.message as string
          }". Will retry after ${secondsToWait}s...`
        );
        await new Promise(resolve => setTimeout(resolve, 1000 * secondsToWait));
      } else {
        throw e;
      }
    }
  }

  error(`Error: could not complete "${label}" after ${kRetries} retries.`);
  throw lastException;
}

async function rateLimit() {
  if (notionLimiter.getTokensRemaining() < 1) {
    logDebug("rateLimit", "*** delaying for rate limit");
  }
  await notionLimiter.removeTokens(1);
}

async function getBlockChildren(id: string): Promise<NotionBlock[]> {
  // we can only get so many responses per call, so we set this to
  // the first response we get, then keep adding to its array of blocks
  // with each subsequent response
  let overallResult: ListBlockChildrenResponse | undefined = undefined;
  let start_cursor: string | undefined | null = undefined;

  // Note: there is a now a collectPaginatedAPI() in the notion client, so
  // we could switch to using that (I don't know if it does rate limiting?)
  do {
    const response: ListBlockChildrenResponse =
      await executeWithRateLimitAndRetries(`getBlockChildren(${id})`, () => {
        return notionClient.blocks.children.list({
          start_cursor: start_cursor as string | undefined,
          block_id: id,
        });
      });

    if (!overallResult) {
      overallResult = response;
    } else {
      overallResult.results.push(...response.results);
    }

    start_cursor = response?.next_cursor;
  } while (start_cursor != null);

  if (overallResult?.results?.some(b => !isFullBlock(b))) {
    error(
      `The Notion API returned some blocks that were not full blocks. docu-notion does not handle this yet. Please report it.`
    );
    exit(1);
  }

  const result = (overallResult?.results as BlockObjectResponse[]) ?? [];
  numberChildrenIfNumberedList(result);
  return result;
}
export function initNotionClient(notionToken: string): Client {
  notionClient = new Client({
    auth: notionToken,
  });
  return notionClient;
}
async function fromPageId(
  context: string,
  pageId: string,
  order: number,
  foundDirectlyInOutline: boolean
): Promise<NotionPage> {
  const metadata = await getPageMetadata(pageId);

  //logDebug("notion metadata", JSON.stringify(metadata));
  return new NotionPage({
    layoutContext: context,
    pageId,
    order,
    metadata,
    foundDirectlyInOutline,
  });
}

// This function is copied (and renamed from modifyNumberedListObject) from notion-to-md.
// They always run it on the results of their getBlockChildren.
// When we use our own getBlockChildren, we need to run it too.
export function numberChildrenIfNumberedList(
  blocks: ListBlockChildrenResponseResults
): void {
  let numberedListIndex = 0;

  for (const block of blocks) {
    if ("type" in block && block.type === "numbered_list_item") {
      // add numbers
      // @ts-ignore
      block.numbered_list_item.number = ++numberedListIndex;
    } else {
      numberedListIndex = 0;
    }
  }
}
