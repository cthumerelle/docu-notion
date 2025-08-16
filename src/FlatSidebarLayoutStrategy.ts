import * as fs from "fs-extra";
import sanitize from "sanitize-filename";
import { LayoutStrategy } from "./LayoutStrategy";
import { NotionPage } from "./NotionPage";

// This strategy creates a flat file structure where all pages are in the root docs/ directory
// The hierarchy is managed by a sidebars.js file instead of folder structure
// All files are named using slugs for clean URLs

export class FlatSidebarLayoutStrategy extends LayoutStrategy {
  public newLevel(
    dirRoot: string,
    order: number,
    context: string,
    levelLabel: string
  ): string {
    // In flat structure, we don't create physical directories for levels
    // Return the context but don't create any folders
    const flatContext = context + "/" + sanitize(levelLabel).replaceAll(" ", "-");
    return flatContext;
  }

  public getPathForPage(page: NotionPage, extensionWithDot: string): string {
    // All files go directly in the root directory, named by their slug
    const fileName = this.getFileNameFromSlug(page) + extensionWithDot;
    return this.rootDirectory + "/" + fileName;
  }

  public getIndexPathForPage(page: NotionPage, extensionWithDot: string): string {
    // For mixed content pages, we still use flat structure
    // The file is named by slug and hierarchy is handled by sidebars.js
    return this.getPathForPage(page, extensionWithDot);
  }

  private getFileNameFromSlug(page: NotionPage): string {
    // Use the slug if available, otherwise it will be generated from name by NotionPage.generateSlugFromName()
    let fileName = page.slug;
    
    // Remove leading slash from slug
    if (fileName.startsWith('/')) {
      fileName = fileName.substring(1);
    }
    
    // Handle special case of root page (slug is "/") 
    if (fileName === '' && page.slug === '/') {
      return 'index';
    }
    
    return fileName;
  }

  private isNotionId(str: string): boolean {
    // Check if the string looks like a Notion ID (contains hyphens and is ~32 chars)
    return str.includes('-') && str.length > 30 && /^[a-f0-9-]+$/.test(str);
  }
}